"""Adapter over `py-clob-client-v2`.

Why this layer exists
---------------------
The exact request/response shapes of the V2 SDK could not be exercised from the
environment this was built in (`*.polymarket.com` is blocked by egress policy). So
every assumption about the SDK is confined to this one file, marked `# VERIFY:`, and
put behind a narrow interface that the executor talks to instead. That means:

  * the trading logic is fully unit-tested against a fake gateway
  * when a field name turns out to be wrong, exactly one file changes
  * `polyarb doctor` can probe this layer in isolation before any capital moves

Response parsing is deliberately paranoid. An unrecognised response is reported as a
*failure*, never as a silent success — mis-reading "rejected" as "filled" would leave
the bot believing it holds a hedge it does not have.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from ..models import Side

log = logging.getLogger(__name__)


@dataclass(slots=True)
class OrderRequest:
    token_id: str
    side: Side
    price: float
    size: float
    tick_size: float
    neg_risk: bool = False
    # FOK for arbitrage legs (all-or-nothing), FAK for unwinds (take what you can).
    order_type: str = "FOK"


@dataclass(slots=True)
class OrderAck:
    ok: bool
    order_id: str = ""
    filled_size: float = 0.0
    notional: float = 0.0
    fee_paid: float = 0.0
    status: str = ""
    error: str = ""

    @property
    def avg_price(self) -> float:
        return self.notional / self.filled_size if self.filled_size > 0 else 0.0


class Gateway(Protocol):
    """What the live executor needs. Implemented for real below, faked in tests."""

    def submit_batch(self, orders: list[OrderRequest]) -> list[OrderAck]: ...

    def submit(self, order: OrderRequest) -> OrderAck: ...

    def cancel_all(self) -> None: ...

    def heartbeat(self) -> None: ...


# Statuses that mean "this order is done and did not trade".
_DEAD_STATUSES = {"canceled", "cancelled", "killed", "unmatched", "rejected", "failed", "expired"}
# Statuses that mean the order matched.
_LIVE_STATUSES = {"matched", "filled", "mined", "confirmed", "success"}


def _f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_ack(resp: Any, requested_size: float, requested_price: float) -> OrderAck:
    """Turn an SDK response into an `OrderAck`.

    VERIFY: field names below are taken from the documented V2 response shape and
    must be confirmed against a real fill. Anything unrecognised becomes a failure.
    """
    if resp is None:
        return OrderAck(ok=False, error="empty response")
    if not isinstance(resp, dict):
        return OrderAck(ok=False, error=f"unexpected response type {type(resp).__name__}")

    # Explicit error envelopes come in a few shapes.
    err = resp.get("error") or resp.get("errorMsg") or resp.get("message")
    success = resp.get("success")
    order_id = str(resp.get("orderID") or resp.get("order_id") or resp.get("orderId") or "")
    status = str(resp.get("status") or resp.get("orderStatus") or "").lower()

    if success is False or (err and status not in _LIVE_STATUSES):
        return OrderAck(ok=False, order_id=order_id, status=status, error=str(err or "rejected"))

    if status in _DEAD_STATUSES:
        # A killed FOK is a normal, healthy outcome: the market moved and we did not
        # get a bad fill. Not an error, just no trade.
        return OrderAck(ok=False, order_id=order_id, status=status, error=f"not filled ({status})")

    # Size actually traded. Several field spellings are in circulation.
    filled = _f(
        resp.get("sizeMatched")
        or resp.get("size_matched")
        or resp.get("filledSize")
        or resp.get("filled_size"),
        default=-1.0,
    )
    if filled < 0:
        # No size field at all. If the venue said it matched, assume the full
        # requested size; otherwise refuse to guess.
        if status in _LIVE_STATUSES or success is True:
            filled = requested_size
        else:
            return OrderAck(ok=False, order_id=order_id, status=status,
                            error="could not determine filled size")

    if filled <= 0:
        return OrderAck(ok=False, order_id=order_id, status=status, error="zero fill")

    avg_price = _f(
        resp.get("avgPrice") or resp.get("average_price") or resp.get("price"),
        default=requested_price,
    )
    if avg_price <= 0:
        avg_price = requested_price

    fee = _f(resp.get("feePaid") or resp.get("fee_paid") or resp.get("fee"), default=-1.0)
    # A missing fee is left at -1 so the caller can tell "no data" from "zero fee"
    # and skip reconciliation rather than halting on a phantom mismatch.
    return OrderAck(
        ok=True,
        order_id=order_id,
        filled_size=filled,
        notional=filled * avg_price,
        fee_paid=fee,
        status=status or "matched",
    )


class ClobGateway:
    """Real gateway backed by `py-clob-client-v2`."""

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self._client: Any = None
        self._heartbeat_id: str | None = None
        self._batch_supported: bool | None = None

    def connect(self) -> None:
        """Build an authenticated client. Import is lazy: paper mode needs no SDK."""
        try:
            from py_clob_client_v2 import ApiCreds, ClobClient  # type: ignore
        except ImportError as e:  # pragma: no cover - depends on optional extra
            raise RuntimeError(
                "py-clob-client-v2 is not installed. Install the live extra:\n"
                "    pip install -e '.[live]'"
            ) from e

        from ..config import CLOB_API, POLYGON_CHAIN_ID

        s = self.settings
        if not s.has_credentials():
            raise RuntimeError(
                "missing credentials; set POLYARB_PRIVATE_KEY, POLYARB_API_KEY, "
                "POLYARB_API_SECRET and POLYARB_API_PASSPHRASE"
            )

        creds = ApiCreds(
            api_key=s.api_key, api_secret=s.api_secret, api_passphrase=s.api_passphrase
        )
        kwargs: dict[str, Any] = dict(
            host=CLOB_API, chain_id=POLYGON_CHAIN_ID, key=s.private_key, creds=creds
        )
        if s.funder_address:
            kwargs["funder"] = s.funder_address
        self._client = ClobClient(**kwargs)

    @property
    def client(self) -> Any:
        if self._client is None:
            self.connect()
        return self._client

    def _order_kwargs(self, o: OrderRequest) -> dict[str, Any]:
        from py_clob_client_v2 import (  # type: ignore
            OrderArgs,
            OrderType,
            PartialCreateOrderOptions,
            Side as ClobSide,
        )

        return dict(
            order_args=OrderArgs(
                token_id=o.token_id,
                price=o.price,
                size=o.size,
                side=ClobSide.BUY if o.side is Side.BUY else ClobSide.SELL,
            ),
            options=PartialCreateOrderOptions(
                tick_size=_tick_str(o.tick_size), neg_risk=o.neg_risk
            ),
            order_type=getattr(OrderType, o.order_type),
        )

    def submit(self, order: OrderRequest) -> OrderAck:
        try:
            resp = self.client.create_and_post_order(**self._order_kwargs(order))
        except Exception as e:
            return OrderAck(ok=False, error=f"{type(e).__name__}: {e}")
        return parse_ack(resp, order.size, order.price)

    def submit_batch(self, orders: list[OrderRequest]) -> list[OrderAck]:
        """Submit both legs together to minimise the window between them.

        The batch endpoint accepts up to 15 orders. If this SDK build does not expose
        it, fall back to sequential submission — slower and slightly riskier, but
        correct. The fallback is taken once and remembered.
        """
        if len(orders) > 15:
            raise ValueError("batch limit is 15 orders")

        if self._batch_supported is not False:
            post_orders = getattr(self.client, "post_orders", None)
            if post_orders is None:
                self._batch_supported = False
            else:
                try:
                    payload = [self._order_kwargs(o) for o in orders]
                    resp = post_orders(payload)
                    self._batch_supported = True
                    responses = resp if isinstance(resp, list) else [resp]
                    if len(responses) == len(orders):
                        return [
                            parse_ack(r, o.size, o.price)
                            for r, o in zip(responses, orders, strict=True)
                        ]
                    return [OrderAck(ok=False, error="batch response length mismatch")] * len(orders)
                except Exception as e:
                    # VERIFY: batch payload shape. Degrade rather than fail the run.
                    log.warning("batch submit unavailable (%s); falling back to sequential", e)
                    self._batch_supported = False

        return [self.submit(o) for o in orders]

    def cancel_all(self) -> None:
        try:
            self.client.cancel_all()
        except Exception as e:  # pragma: no cover - network path
            log.error("cancel_all failed: %s", e)

    def heartbeat(self) -> None:
        """Keep resting orders alive.

        Without a heartbeat every 10s the venue cancels all open orders. This bot
        trades FOK only, so nothing rests and this is belt-and-braces — but a missed
        heartbeat during any future maker mode would silently wipe the book.
        """
        try:
            fn = getattr(self.client, "post_heartbeat", None)
            if fn is None:
                return
            resp = fn(self._heartbeat_id) if self._heartbeat_id else fn()
            if isinstance(resp, dict):
                self._heartbeat_id = resp.get("heartbeat_id") or self._heartbeat_id
        except Exception as e:  # pragma: no cover - network path
            log.warning("heartbeat failed: %s", e)


def _tick_str(tick: float) -> str:
    """The API expects tick size as a decimal string, not a float."""
    for candidate in ("0.1", "0.01", "0.001", "0.0001"):
        if abs(tick - float(candidate)) < 1e-9:
            return candidate
    return f"{tick:.4f}".rstrip("0")
