"""Fee curve and net-edge arithmetic.

This module is the reason the bot either makes money or quietly bleeds. Every
threshold decision routes through here.

The fee model
-------------
Polymarket charges a **taker-only** fee per share:

    fee_per_share(p) = rate * p * (1 - p)

where `p` is the execution price of that fill and `rate` is a per-category constant
(0 for geopolitics, ~0.04 for politics/finance/tech, 0.05 sports, 0.07 crypto).
Makers pay nothing.

Two consequences drive the whole strategy:

1. The fee is charged on **each leg**, so a two-leg complement arb pays it twice.
2. `p * (1 - p)` peaks at p = 0.5 and collapses toward the ends. A 50/50 pair in a
   0.05 category costs ~2.5c per share round-trip; a 95/5 pair in the same category
   costs ~0.475c. That 5x difference is larger than the spread we are chasing, so
   price extremity is not a detail — it is the edge.

A sweep across several price levels produces several fills at different prices, so
fees accumulate **per level**, not on the VWAP. `rate*vwap*(1-vwap)` is not the same
number as `sum(size_i * rate * p_i * (1-p_i))` and using the former understates cost
on a convex book. We do it per level.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .models import Level

# Polymarket prices are probabilities; anything outside this is a bad tick.
MIN_PRICE = 0.0
MAX_PRICE = 1.0


def taker_fee_per_share(price: float, rate: float) -> float:
    """Fee in collateral per share filled at `price`.

    Zero-rate categories are free, and the curve vanishes at the price extremes.
    """
    if rate <= 0.0:
        return 0.0
    if price <= MIN_PRICE or price >= MAX_PRICE:
        return 0.0
    return rate * price * (1.0 - price)


def round_to_tick(price: float, tick: float, *, up: bool) -> float:
    """Snap a price onto the market's tick grid.

    Prices off the grid are rejected outright by the exchange
    (`INVALID_ORDER_MIN_TICK_SIZE`), so this is mandatory, not cosmetic.

    `up=True` rounds toward 1.0 (use for buy limits, which are a ceiling on what we
    will pay); `up=False` rounds toward 0.0 (use for sell limits, a floor on what we
    will accept). Both directions round in the way that makes the order *more* likely
    to fill, because the limit is slippage protection and the real fill price is set
    by the resting book.
    """
    if tick <= 0:
        raise ValueError(f"invalid tick size: {tick}")
    steps = price / tick
    # Nudge away from float representation error before choosing a direction, so a
    # price already sitting exactly on the grid is not pushed a whole tick.
    eps = 1e-9
    if up:
        n = -(-(steps - eps) // 1)  # ceil
    else:
        n = (steps + eps) // 1  # floor
    snapped = n * tick
    # Clamp inside the tradable band.
    snapped = min(max(snapped, tick), 1.0 - tick)
    # Kill accumulated float noise: tick is never finer than 1e-4.
    return round(snapped, 6)


@dataclass(frozen=True, slots=True)
class LegCost:
    """Result of walking one side of a book for a target size."""

    filled: float
    notional: float  # collateral paid (buy) or received (sell), before fees
    fee: float
    levels_used: int
    # Deepest price touched. Becomes the order's limit price, so it doubles as the
    # worst case we are willing to accept.
    worst_price: float = 0.0

    @property
    def vwap(self) -> float:
        return self.notional / self.filled if self.filled > 0 else 0.0


def walk_book(levels: Sequence[Level], size: float, rate: float) -> LegCost:
    """Consume `size` shares from `levels`, accumulating notional and fees per level.

    `levels` must already be ordered best-first (ascending price for asks you are
    buying, descending price for bids you are selling into). Returns whatever could
    be filled, which may be less than `size` if the book is thin — callers must check
    `filled`.
    """
    if size <= 0:
        return LegCost(0.0, 0.0, 0.0, 0)

    remaining = size
    notional = 0.0
    fee = 0.0
    used = 0
    worst = 0.0

    for lvl in levels:
        if remaining <= 0:
            break
        if lvl.size <= 0:
            continue
        take = min(remaining, lvl.size)
        notional += take * lvl.price
        fee += take * taker_fee_per_share(lvl.price, rate)
        worst = lvl.price
        remaining -= take
        used += 1

    return LegCost(
        filled=size - remaining,
        notional=notional,
        fee=fee,
        levels_used=used,
        worst_price=worst,
    )


def available_depth(levels: Sequence[Level]) -> float:
    return sum(l.size for l in levels if l.size > 0)


# --- Top-of-book quick screens --------------------------------------------
# These ignore depth and gas. They exist to reject the ~99.9% of book updates that
# are nowhere near profitable, cheaply, before the full sizing walk runs.


def converge_edge_per_pair(ask_yes: float, ask_no: float, rate: float) -> float:
    """Net edge from buying one YES and one NO and merging the pair back into $1.

    Positive means the pair costs less than the $1 it is redeemable for, after fees.
    """
    gross = 1.0 - ask_yes - ask_no
    fees = taker_fee_per_share(ask_yes, rate) + taker_fee_per_share(ask_no, rate)
    return gross - fees


def diverge_edge_per_pair(bid_yes: float, bid_no: float, rate: float) -> float:
    """Net edge from splitting $1 into a YES/NO pair and selling both.

    Positive means the pair sells for more than the $1 it cost to mint, after fees.
    """
    gross = bid_yes + bid_no - 1.0
    fees = taker_fee_per_share(bid_yes, rate) + taker_fee_per_share(bid_no, rate)
    return gross - fees


def breakeven_spread(price: float, rate: float) -> float:
    """How far from $1.00 a pair must trade before a two-leg arb clears fees.

    Useful for reporting and for explaining why a seemingly juicy 1c gap at 50/50 is
    not actually a trade. At `price`, the complement sits near `1 - price`, and both
    legs pay the same fee because p(1-p) is symmetric.
    """
    return taker_fee_per_share(price, rate) + taker_fee_per_share(1.0 - price, rate)


def amortised_gas(gas_cost: float, size: float) -> float:
    """Per-pair share of a fixed settlement cost.

    This is why size matters: gas is fixed per merge, so a 2-share arb can be
    unprofitable while a 200-share arb at the same prices is fine.
    """
    if size <= 0:
        return float("inf")
    return gas_cost / size
