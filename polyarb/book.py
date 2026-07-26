"""Local order book reconstruction from the CLOB market websocket.

A desynced book is worse than no book. The specific danger for this bot: if we drop
a delta and our copy goes stale, the two complementary books can appear to sum to
well under $1.00 — a huge fake arbitrage that we would happily fire real money at.
Every guard here exists to make that failure loud instead of profitable.

Integrity strategy
------------------
`book` messages are full snapshots and are treated as truth: they replace state
outright. `price_change` messages are deltas applied on top.

Server messages carry a `hash` field. The algorithm the server uses to compute it is
not documented in the public references, so we deliberately do NOT invent one and
pretend to verify — a wrong hash check is worse than none, because it either fires
constantly or silently never fires. Instead `hash_verifier` is a pluggable hook: set
it once the algorithm is confirmed on a live connection, and validation turns on. See
`polyarb doctor`.

Until then, desync is caught by structural invariants, which are strong on their own:
  * a crossed book (best bid >= best ask) is impossible on a live CLOB
  * a delta that removes size from a price level we never had
  * negative resulting size at a level
  * no update within the staleness window
Any of these marks the book `invalid` and requests a REST re-snapshot. An invalid
book is never traded on.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from .models import Level

# Prices are on a grid no finer than 1e-4, so 6dp keys are exact.
_PRICE_DP = 6


def _pkey(price: float | str) -> float:
    return round(float(price), _PRICE_DP)


class DesyncError(Exception):
    """Raised internally when book state cannot be trusted."""


@dataclass(slots=True)
class OrderBook:
    """One side-pair book for a single outcome token."""

    token_id: str
    tick_size: float = 0.01
    _bids: dict[float, float] = field(default_factory=dict)
    _asks: dict[float, float] = field(default_factory=dict)

    last_update_ms: float = 0.0
    reported_hash: str = ""
    # False until the first snapshot lands, or after a detected desync.
    valid: bool = False
    resync_requested: bool = False
    desync_reason: str = ""

    snapshots_applied: int = 0
    deltas_applied: int = 0

    # Optional hook: (book, reported_hash) -> bool. See module docstring.
    hash_verifier: Callable[["OrderBook", str], bool] | None = None

    # --- ingestion --------------------------------------------------------
    def apply_snapshot(self, msg: dict[str, Any]) -> None:
        """Replace the whole book from a `book` event."""
        bids: dict[float, float] = {}
        asks: dict[float, float] = {}
        for lvl in msg.get("bids") or []:
            size = float(lvl["size"])
            if size > 0:
                bids[_pkey(lvl["price"])] = size
        for lvl in msg.get("asks") or []:
            size = float(lvl["size"])
            if size > 0:
                asks[_pkey(lvl["price"])] = size

        self._bids = bids
        self._asks = asks
        self.reported_hash = str(msg.get("hash", ""))
        self.last_update_ms = _msg_time_ms(msg)
        self.snapshots_applied += 1
        self.valid = True
        self.resync_requested = False
        self.desync_reason = ""
        self._post_update_checks()

    def apply_price_change(self, msg: dict[str, Any]) -> None:
        """Apply a `price_change` delta.

        Handles both the batched shape (`changes: [{price, side, size}, ...]`) and
        the flat single-change shape, since both appear in the wild.
        """
        if not self.valid:
            # Deltas on an unknown base are meaningless; wait for a snapshot.
            self.resync_requested = True
            return

        changes = msg.get("changes")
        if changes is None:
            if "price" in msg and "side" in msg:
                changes = [msg]
            else:
                changes = []

        for ch in changes:
            try:
                self._apply_one_change(ch)
            except DesyncError as e:
                self._mark_desync(str(e))
                return

        self.reported_hash = str(msg.get("hash", self.reported_hash))
        self.last_update_ms = _msg_time_ms(msg)
        self.deltas_applied += 1
        self._post_update_checks()

    def _apply_one_change(self, ch: dict[str, Any]) -> None:
        side = str(ch.get("side", "")).upper()
        price = _pkey(ch["price"])
        size = float(ch["size"])

        if size < 0:
            raise DesyncError(f"negative size {size} at {price}")

        # BUY changes touch the bid side, SELL changes the ask side.
        if side in ("BUY", "BID", "BIDS"):
            book = self._bids
        elif side in ("SELL", "ASK", "ASKS"):
            book = self._asks
        else:
            raise DesyncError(f"unknown side {side!r}")

        if size == 0:
            # Removing a level we never knew about means we missed its creation.
            if price not in book:
                raise DesyncError(f"removal of unknown level {price} on {side}")
            del book[price]
        else:
            book[price] = size

    def _post_update_checks(self) -> None:
        bb = self.best_bid()
        ba = self.best_ask()
        if bb is not None and ba is not None and bb.price >= ba.price:
            # Impossible on a live matching engine: our copy is stale or corrupt.
            self._mark_desync(f"crossed book: bid {bb.price} >= ask {ba.price}")
            return
        if self.hash_verifier is not None and self.reported_hash:
            if not self.hash_verifier(self, self.reported_hash):
                self._mark_desync("hash mismatch")

    def _mark_desync(self, reason: str) -> None:
        self.valid = False
        self.resync_requested = True
        self.desync_reason = reason

    def consume(self, side: str, size: float, limit: float) -> float:
        """Remove `size` of liquidity, best-first, at prices no worse than `limit`.

        Used by the paper engine to model its own market impact. Without this, a
        simulated fill leaves the offer it just lifted sitting in the book, so a
        persistent gap gets traded over and over and paper results overstate both
        volume and profit. The next `book` snapshot overwrites this, which is
        correct — the venue is always the authority.

        `side` is the side of the book being consumed: "asks" when buying,
        "bids" when selling.
        """
        levels = self._asks if side == "asks" else self._bids
        prices = sorted(levels) if side == "asks" else sorted(levels, reverse=True)

        remaining = size
        for price in prices:
            if remaining <= 0:
                break
            if side == "asks" and price > limit + 1e-9:
                break
            if side == "bids" and price < limit - 1e-9:
                break
            available = levels[price]
            take = min(remaining, available)
            remaining -= take
            if available - take <= 1e-9:
                del levels[price]
            else:
                levels[price] = available - take
        return size - remaining

    def apply_tick_size_change(self, msg: dict[str, Any]) -> None:
        """Honour `tick_size_change`, or subsequent orders get rejected."""
        new = msg.get("new_tick_size") or msg.get("new_tick_size_value")
        if new is not None:
            self.tick_size = float(new)

    # --- reads ------------------------------------------------------------
    def bid_levels(self) -> list[Level]:
        """Best (highest) first."""
        return [Level(p, s) for p, s in sorted(self._bids.items(), key=lambda kv: -kv[0])]

    def ask_levels(self) -> list[Level]:
        """Best (lowest) first."""
        return [Level(p, s) for p, s in sorted(self._asks.items(), key=lambda kv: kv[0])]

    def best_bid(self) -> Level | None:
        if not self._bids:
            return None
        p = max(self._bids)
        return Level(p, self._bids[p])

    def best_ask(self) -> Level | None:
        if not self._asks:
            return None
        p = min(self._asks)
        return Level(p, self._asks[p])

    def age_ms(self, now_ms: float | None = None) -> float:
        if self.last_update_ms <= 0:
            return float("inf")
        now = now_ms if now_ms is not None else time.time() * 1000.0
        return max(0.0, now - self.last_update_ms)

    def is_tradable(self, max_age_ms: float, now_ms: float | None = None) -> bool:
        """Fresh, structurally sane, and two-sided."""
        return (
            self.valid
            and not self.resync_requested
            and self.best_bid() is not None
            and self.best_ask() is not None
            and self.age_ms(now_ms) <= max_age_ms
        )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        bb, ba = self.best_bid(), self.best_ask()
        return (
            f"<OrderBook {self.token_id[:10]}… "
            f"bid={bb.price if bb else None} ask={ba.price if ba else None} "
            f"valid={self.valid} age={self.age_ms():.0f}ms>"
        )


def _msg_time_ms(msg: dict[str, Any]) -> float:
    """Extract the server timestamp, falling back to local clock.

    Polymarket sends millisecond timestamps as strings. We prefer the server clock so
    that staleness reflects the exchange's view, not our own scheduling jitter.
    """
    for key in ("timestamp", "ts", "time"):
        raw = msg.get(key)
        if raw in (None, ""):
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            continue
        # Heuristic: seconds if it is implausibly small for epoch milliseconds.
        return v * 1000.0 if v < 1e11 else v
    return time.time() * 1000.0


class BookStore:
    """All tracked books, keyed by token id, with routing for websocket events."""

    def __init__(self, tick_sizes: dict[str, float] | None = None) -> None:
        self._books: dict[str, OrderBook] = {}
        self._tick_sizes = tick_sizes or {}

    def get(self, token_id: str) -> OrderBook:
        book = self._books.get(token_id)
        if book is None:
            book = OrderBook(token_id=token_id, tick_size=self._tick_sizes.get(token_id, 0.01))
            self._books[token_id] = book
        return book

    def __contains__(self, token_id: object) -> bool:
        return token_id in self._books

    def __len__(self) -> int:
        return len(self._books)

    def handle(self, msg: dict[str, Any]) -> str | None:
        """Route one websocket message. Returns the token id it touched, if any."""
        event = msg.get("event_type") or msg.get("type")
        token_id = msg.get("asset_id") or msg.get("assetId")
        if not token_id:
            return None

        book = self.get(str(token_id))
        if event == "book":
            book.apply_snapshot(msg)
        elif event == "price_change":
            book.apply_price_change(msg)
        elif event == "tick_size_change":
            book.apply_tick_size_change(msg)
        else:
            # last_trade_price, best_bid_ask and friends carry no book state we rely
            # on; the snapshot/delta stream is authoritative.
            return str(token_id)
        return str(token_id)

    def needing_resync(self) -> list[str]:
        return [tid for tid, b in self._books.items() if b.resync_requested or not b.valid]

    def stale(self, max_age_ms: float, now_ms: float | None = None) -> list[str]:
        return [tid for tid, b in self._books.items() if b.age_ms(now_ms) > max_age_ms]

    def books(self) -> Iterable[OrderBook]:
        return self._books.values()
