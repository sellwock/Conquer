"""Core data types.

Money convention: prices and sizes are floats. Polymarket prices live on a coarse
tick grid (0.1 / 0.01 / 0.001 / 0.0001) and pUSD has 6 decimals, so float precision
is far finer than anything that reaches the wire. Every value that becomes an order
price goes through `fees.round_to_tick` first, and every value that is journaled is
quantised with `q6`. Do not do naked float arithmetic on money outside those helpers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

PRICE_DP = 6


def q6(x: float) -> float:
    """Quantise to pUSD precision (6 decimals) for storage and accounting."""
    return round(x, PRICE_DP)


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Outcome(str, Enum):
    YES = "YES"
    NO = "NO"


class Direction(str, Enum):
    """Which side of the complement relationship we are trading.

    CONVERGE: asks sum below $1 -> buy both legs, merge the pair back into $1.
    DIVERGE:  bids sum above $1 -> split $1 into a pair, sell both legs.
    """

    CONVERGE = "CONVERGE"
    DIVERGE = "DIVERGE"


@dataclass(frozen=True, slots=True)
class Level:
    price: float
    size: float


@dataclass(slots=True)
class Market:
    """A binary market and its two complementary outcome tokens.

    `yes_token_id` and `no_token_id` are CLOB token IDs; `condition_id` is the CTF
    condition, which is what merge/split operate on.
    """

    condition_id: str
    question: str
    slug: str
    yes_token_id: str
    no_token_id: str
    category: str
    tick_size: float
    min_order_size: float
    neg_risk: bool = False
    closed: bool = False
    # Populated from Gamma when present; used only for candidate ranking.
    liquidity: float = 0.0
    volume_24h: float = 0.0

    @property
    def token_ids(self) -> tuple[str, str]:
        return (self.yes_token_id, self.no_token_id)

    def outcome_of(self, token_id: str) -> Outcome:
        if token_id == self.yes_token_id:
            return Outcome.YES
        if token_id == self.no_token_id:
            return Outcome.NO
        raise KeyError(f"token {token_id} does not belong to market {self.condition_id}")


@dataclass(slots=True)
class Leg:
    """One side of a two-leg arbitrage trade."""

    token_id: str
    outcome: Outcome
    side: Side
    # Limit price sent to the exchange: the worst price we will accept.
    limit_price: float
    size: float
    # Expected VWAP from walking the book at detection time.
    expected_vwap: float
    expected_fee: float


@dataclass(slots=True)
class Opportunity:
    """A priced, sized arbitrage candidate, ready to execute or reject."""

    market: Market
    direction: Direction
    legs: tuple[Leg, Leg]
    size: float
    # Per-pair economics, net of taker fees and amortised gas.
    edge_per_pair: float
    gross_edge_per_pair: float
    fee_per_pair: float
    gas_cost: float
    total_profit: float
    # Freshness: the age of the older of the two books, in milliseconds.
    book_age_ms: float
    detected_at: float = field(default_factory=time.time)

    @property
    def edge_bps(self) -> float:
        """Net edge in basis points of the $1 pair notional."""
        return self.edge_per_pair * 10_000.0

    def describe(self) -> str:
        arrow = "asks<1" if self.direction is Direction.CONVERGE else "bids>1"
        return (
            f"{self.market.slug} [{self.market.category}] {self.direction.value} ({arrow}) "
            f"size={self.size:.2f} edge={self.edge_bps:.1f}bps "
            f"profit=${self.total_profit:.4f} age={self.book_age_ms:.0f}ms"
        )


@dataclass(slots=True)
class LegFill:
    token_id: str
    outcome: Outcome
    side: Side
    filled_size: float
    avg_price: float
    fee_paid: float
    order_id: str = ""
    ok: bool = True
    error: str = ""


@dataclass(slots=True)
class TradeResult:
    """Outcome of attempting both legs of an opportunity."""

    opportunity: Opportunity
    fills: list[LegFill]
    realised_pnl: float
    one_legged: bool
    unwound: bool
    error: str = ""
    finished_at: float = field(default_factory=time.time)

    @property
    def ok(self) -> bool:
        return not self.one_legged and not self.error and all(f.ok for f in self.fills)


@dataclass(slots=True)
class PairPosition:
    """Matched YES/NO inventory for one condition, awaiting merge."""

    condition_id: str
    neg_risk: bool
    yes_size: float = 0.0
    no_size: float = 0.0
    cost_basis: float = 0.0

    @property
    def mergeable(self) -> float:
        """Number of complete pairs that can be merged back into collateral."""
        return min(self.yes_size, self.no_size)
