"""Shared execution primitives.

The fill model here is used by the paper engine directly and mirrors what the
exchange does to a live fill-or-kill order, so paper results and live results are
comparable rather than merely similar.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from ..fees import taker_fee_per_share
from ..models import Direction, Level, LegFill, Opportunity, Outcome, Side, TradeResult


class ExecutionEngine(Protocol):
    """What the runner needs from any execution backend."""

    def submit(self, opp: Opportunity, now_ms: float) -> None: ...

    def settle_due(self, now_ms: float) -> list[TradeResult]: ...


def marketable_levels(
    levels: Sequence[Level], limit: float, side: Side
) -> list[Level]:
    """Levels that a limit order at `limit` is allowed to touch.

    A buy may only lift offers at or below its limit; a sell may only hit bids at or
    above it.
    """
    if side is Side.BUY:
        return [l for l in levels if l.price <= limit + 1e-9]
    return [l for l in levels if l.price >= limit - 1e-9]


def simulate_fok(
    levels: Sequence[Level], size: float, limit: float, side: Side, fee_rate: float
) -> tuple[bool, float, float]:
    """Model a fill-or-kill order.

    Returns (filled, notional, fee). Fill-or-kill is all-or-nothing: if the book
    cannot supply the full size at prices no worse than the limit, nothing trades.

    Returning "no fill" is the *good* outcome when the market has moved — it is what
    keeps a stale opportunity from turning into a bad trade.
    """
    usable = marketable_levels(levels, limit, side)
    if sum(l.size for l in usable) + 1e-9 < size:
        return False, 0.0, 0.0

    remaining = size
    notional = 0.0
    fee = 0.0
    for lvl in usable:
        if remaining <= 0:
            break
        take = min(remaining, lvl.size)
        notional += take * lvl.price
        fee += take * taker_fee_per_share(lvl.price, fee_rate)
        remaining -= take
    return True, notional, fee


def simulate_fak(
    levels: Sequence[Level], size: float, fee_rate: float
) -> tuple[float, float, float]:
    """Model a fill-and-kill (partial fills allowed) sweep with no price protection.

    Used for unwinding a one-legged position, where getting out matters more than
    the price. Returns (filled, notional, fee).
    """
    remaining = size
    notional = 0.0
    fee = 0.0
    for lvl in levels:
        if remaining <= 0:
            break
        take = min(remaining, lvl.size)
        notional += take * lvl.price
        fee += take * taker_fee_per_share(lvl.price, fee_rate)
        remaining -= take
    return size - remaining, notional, fee


def pair_pnl(
    direction: Direction,
    size: float,
    yes_notional: float,
    no_notional: float,
    fees: float,
    gas: float,
) -> float:
    """Realised P&L for a completed two-leg trade.

    Converge buys both legs and merges the pair back into exactly $1 each.
    Diverge mints pairs at $1 each and sells both legs.
    """
    if direction is Direction.CONVERGE:
        return size - yes_notional - no_notional - fees - gas
    return yes_notional + no_notional - size - fees - gas


def make_fill(
    token_id: str,
    outcome: Outcome,
    side: Side,
    filled: float,
    notional: float,
    fee: float,
    *,
    ok: bool = True,
    error: str = "",
    order_id: str = "",
) -> LegFill:
    return LegFill(
        token_id=token_id,
        outcome=outcome,
        side=side,
        filled_size=filled,
        avg_price=(notional / filled) if filled > 0 else 0.0,
        fee_paid=fee,
        ok=ok,
        error=error,
        order_id=order_id,
    )
