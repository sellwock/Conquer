"""Depth-aware trade sizing.

A naive bot reads top-of-book, sees `ask_yes + ask_no < 1`, and fires for whatever
size it feels like. That is wrong twice over: the displayed top level is usually far
too small to matter, and sweeping deeper changes the arithmetic on every level it
touches.

Method
------
Consume both books in lockstep, one price level at a time. The marginal edge on the
next shared slice is

    marginal = 1 - p_yes - p_no - fee(p_yes) - fee(p_no)      (converge)
    marginal = p_yes + p_no - 1 - fee(p_yes) - fee(p_no)      (diverge)

which is constant within a slice, so total profit is piecewise-linear in size and is
maximised by consuming exactly while `marginal > 0`. Stop at the first slice where it
turns negative.

This yields a property worth stating plainly, because it is the main safety
guarantee in the execution path:

    **The limit price of each leg is the deepest price we consumed, and every price
    we consumed had positive marginal edge. Book prices are always on the tick grid,
    so the limits need no widening. A fill-or-kill order at those limits therefore
    cannot fill at a loss (before gas) even if the book moves against us — it simply
    will not fill.**

Gas is the one fixed cost that does not shrink with size, so it is applied once at
the end and is what rules out tiny trades.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .fees import round_to_tick, taker_fee_per_share
from .models import Direction, Level


@dataclass(frozen=True, slots=True)
class SizedTrade:
    """A fully-priced trade candidate."""

    direction: Direction
    size: float

    yes_vwap: float
    no_vwap: float
    yes_limit: float
    no_limit: float

    gross_edge_per_pair: float
    fee_per_pair: float
    gas_cost: float
    edge_per_pair: float
    total_profit: float
    capital_required: float

    levels_consumed: int

    @property
    def edge_bps(self) -> float:
        return self.edge_per_pair * 10_000.0


def _slices(
    yes: Sequence[Level], no: Sequence[Level]
) -> list[tuple[float, float, float]]:
    """Walk two books in lockstep, yielding (size, yes_price, no_price) slices.

    Each slice is the largest chunk over which both prices are constant.
    """
    out: list[tuple[float, float, float]] = []
    i = j = 0
    y_left = yes[0].size if yes else 0.0
    n_left = no[0].size if no else 0.0

    while i < len(yes) and j < len(no):
        if y_left <= 0:
            i += 1
            if i < len(yes):
                y_left = yes[i].size
            continue
        if n_left <= 0:
            j += 1
            if j < len(no):
                n_left = no[j].size
            continue

        take = min(y_left, n_left)
        out.append((take, yes[i].price, no[j].price))
        y_left -= take
        n_left -= take

    return out


def size_trade(
    direction: Direction,
    yes_levels: Sequence[Level],
    no_levels: Sequence[Level],
    *,
    fee_rate: float,
    tick_size: float,
    gas_cost: float = 0.0,
    max_size: float = float("inf"),
    max_capital: float = float("inf"),
    min_order_size: float = 0.0,
    min_edge_per_pair: float = 0.0,
) -> SizedTrade | None:
    """Find the most profitable executable size, or None if there is no trade.

    `yes_levels` / `no_levels` must be best-first: ascending asks for CONVERGE
    (we are buying), descending bids for DIVERGE (we are selling).
    """
    if not yes_levels or not no_levels or max_size <= 0:
        return None

    converge = direction is Direction.CONVERGE

    size = 0.0
    y_notional = 0.0
    n_notional = 0.0
    fees = 0.0
    y_worst = 0.0
    n_worst = 0.0
    consumed = 0

    for slice_size, py, pn in _slices(yes_levels, no_levels):
        fee_slice = taker_fee_per_share(py, fee_rate) + taker_fee_per_share(pn, fee_rate)
        gross = (1.0 - py - pn) if converge else (py + pn - 1.0)
        marginal = gross - fee_slice

        # The moment an extra share stops paying for itself, stop. Everything
        # beyond this point strictly reduces total profit.
        if marginal <= 0:
            break

        take = min(slice_size, max_size - size)

        # Respect the capital ceiling. Converge pays the two legs plus fees;
        # diverge must first mint pairs at $1 each.
        if max_capital < float("inf"):
            spent = (y_notional + n_notional + fees) if converge else size
            per_share = (py + pn + fee_slice) if converge else 1.0
            room = (max_capital - gas_cost - spent) / per_share if per_share > 0 else 0.0
            take = min(take, max(0.0, room))

        if take <= 0:
            break

        size += take
        y_notional += take * py
        n_notional += take * pn
        fees += take * fee_slice
        y_worst, n_worst = py, pn
        consumed += 1

        if size >= max_size:
            break

    if size <= 0 or size < min_order_size:
        return None

    gross_edge = ((size - y_notional - n_notional) if converge
                  else (y_notional + n_notional - size)) / size
    fee_per_pair = fees / size
    edge_per_pair = gross_edge - fee_per_pair - (gas_cost / size)
    total_profit = edge_per_pair * size

    if total_profit <= 0 or edge_per_pair < min_edge_per_pair:
        return None

    # Book prices already sit on the tick grid, so these are no-ops in practice;
    # they exist to be certain we never emit an off-grid price, which the exchange
    # rejects outright.
    yes_limit = round_to_tick(y_worst, tick_size, up=converge)
    no_limit = round_to_tick(n_worst, tick_size, up=converge)

    capital_required = (
        (y_notional + n_notional + fees + gas_cost) if converge else (size + gas_cost)
    )

    return SizedTrade(
        direction=direction,
        size=size,
        yes_vwap=y_notional / size,
        no_vwap=n_notional / size,
        yes_limit=yes_limit,
        no_limit=no_limit,
        gross_edge_per_pair=gross_edge,
        fee_per_pair=fee_per_pair,
        gas_cost=gas_cost,
        edge_per_pair=edge_per_pair,
        total_profit=total_profit,
        capital_required=capital_required,
        levels_consumed=consumed,
    )


def worst_case_edge(trade: SizedTrade, fee_rate: float) -> float:
    """Edge if both legs filled entirely at their limit prices.

    Should always be positive before gas — see the module docstring. Used as an
    assertion in tests and as a runtime tripwire in the executor.
    """
    ly, ln = trade.yes_limit, trade.no_limit
    gross = (1.0 - ly - ln) if trade.direction is Direction.CONVERGE else (ly + ln - 1.0)
    fees = taker_fee_per_share(ly, fee_rate) + taker_fee_per_share(ln, fee_rate)
    return gross - fees
