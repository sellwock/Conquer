"""Paper execution with honest latency modelling.

A paper engine that fills at the price it saw is worthless. It reports the edge the
detector *found* rather than the edge that would have been *captured*, which is a
different and much smaller number — and it manufactures exactly the confidence that
gets real money lost.

This engine instead does what the network does: it delays. An opportunity submitted
at T is not evaluated until T + latency, and it is then matched against the book as
it stands at that later moment. If the gap closed in the meantime — which is the
normal outcome, because everyone else is racing for the same thing — the fill-or-kill
legs simply do not fill, and that shows up in the fill rate.

The clock is injected, so replaying a recording measures latency in *stream* time and
produces the same answer it would live.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..book import BookStore
from ..config import Settings
from ..models import Direction, Opportunity, Outcome, Side, TradeResult
from .base import make_fill, pair_pnl, simulate_fak, simulate_fok


@dataclass(slots=True)
class _Pending:
    opp: Opportunity
    due_at_ms: float


class PaperEngine:
    """Simulates execution against live or replayed books."""

    def __init__(self, store: BookStore, settings: Settings) -> None:
        self.store = store
        self.settings = settings
        self._pending: list[_Pending] = []
        self.submitted = 0
        self.settled = 0

    def submit(self, opp: Opportunity, now_ms: float) -> None:
        latency = self.settings.execution.assumed_latency_ms
        self._pending.append(_Pending(opp=opp, due_at_ms=now_ms + latency))
        self.submitted += 1

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def settle_due(self, now_ms: float) -> list[TradeResult]:
        """Evaluate every submission whose latency window has elapsed."""
        if not self._pending:
            return []
        due = [p for p in self._pending if p.due_at_ms <= now_ms]
        if not due:
            return []
        self._pending = [p for p in self._pending if p.due_at_ms > now_ms]

        results = [self._evaluate(p.opp) for p in due]
        self.settled += len(results)
        return results

    def flush(self) -> list[TradeResult]:
        """Settle everything outstanding, regardless of the clock (end of run)."""
        return self.settle_due(float("inf"))

    # --- matching ---------------------------------------------------------
    def _evaluate(self, opp: Opportunity) -> TradeResult:
        market = opp.market
        rate = self.settings.fee_rate_for(market.category)
        gas = self.settings.execution.gas_cost_per_settlement
        buying = opp.direction is Direction.CONVERGE
        side = Side.BUY if buying else Side.SELL

        yes_leg, no_leg = opp.legs
        yes_book = self.store.get(market.yes_token_id)
        no_book = self.store.get(market.no_token_id)

        # A book that desynced while we were "in flight" cannot be filled against.
        if not yes_book.valid or not no_book.valid:
            return TradeResult(
                opportunity=opp, fills=[], realised_pnl=0.0,
                one_legged=False, unwound=False, error="book invalid at settle time",
            )

        yes_levels = yes_book.ask_levels() if buying else yes_book.bid_levels()
        no_levels = no_book.ask_levels() if buying else no_book.bid_levels()

        yes_ok, yes_notional, yes_fee = simulate_fok(
            yes_levels, yes_leg.size, yes_leg.limit_price, side, rate
        )
        no_ok, no_notional, no_fee = simulate_fok(
            no_levels, no_leg.size, no_leg.limit_price, side, rate
        )

        # Both killed: the opportunity evaporated before we arrived. No harm done.
        if not yes_ok and not no_ok:
            return TradeResult(
                opportunity=opp,
                fills=[
                    make_fill(yes_leg.token_id, Outcome.YES, side, 0, 0, 0,
                              ok=False, error="FOK not filled"),
                    make_fill(no_leg.token_id, Outcome.NO, side, 0, 0, 0,
                              ok=False, error="FOK not filled"),
                ],
                realised_pnl=0.0, one_legged=False, unwound=False,
            )

        if yes_ok and no_ok:
            # Model our own impact: the liquidity we just took is gone.
            self._consume(yes_book, no_book, opp, buying)
            pnl = pair_pnl(
                opp.direction, opp.size, yes_notional, no_notional, yes_fee + no_fee, gas
            )
            return TradeResult(
                opportunity=opp,
                fills=[
                    make_fill(yes_leg.token_id, Outcome.YES, side, yes_leg.size,
                              yes_notional, yes_fee),
                    make_fill(no_leg.token_id, Outcome.NO, side, no_leg.size,
                              no_notional, no_fee),
                ],
                realised_pnl=pnl, one_legged=False, unwound=False,
            )

        # Exactly one leg filled: we are naked directional and must deal with it.
        return self._handle_one_legged(
            opp, side, rate,
            filled_yes=yes_ok,
            yes_notional=yes_notional, yes_fee=yes_fee,
            no_notional=no_notional, no_fee=no_fee,
        )

    def _consume(self, yes_book, no_book, opp: Opportunity, buying: bool) -> None:
        side = "asks" if buying else "bids"
        yes_leg, no_leg = opp.legs
        yes_book.consume(side, yes_leg.size, yes_leg.limit_price)
        no_book.consume(side, no_leg.size, no_leg.limit_price)

    def _handle_one_legged(
        self,
        opp: Opportunity,
        side: Side,
        rate: float,
        *,
        filled_yes: bool,
        yes_notional: float,
        yes_fee: float,
        no_notional: float,
        no_fee: float,
    ) -> TradeResult:
        market = opp.market
        yes_leg, no_leg = opp.legs

        if filled_yes:
            good_leg, good_outcome = yes_leg, Outcome.YES
            notional, fee = yes_notional, yes_fee
            dead_leg, dead_outcome = no_leg, Outcome.NO
            book = self.store.get(market.yes_token_id)
        else:
            good_leg, good_outcome = no_leg, Outcome.NO
            notional, fee = no_notional, no_fee
            dead_leg, dead_outcome = yes_leg, Outcome.YES
            book = self.store.get(market.no_token_id)

        # The leg that did fill still consumed real liquidity.
        book.consume("asks" if side is Side.BUY else "bids", good_leg.size, good_leg.limit_price)

        fills = [
            make_fill(good_leg.token_id, good_outcome, side, good_leg.size, notional, fee),
            make_fill(dead_leg.token_id, dead_outcome, side, 0, 0, 0,
                      ok=False, error="FOK not filled"),
        ]

        if not self.settings.execution.unwind_one_legged:
            # Holding a naked leg is a directional bet, which is not this bot's
            # business. Carrying it is recorded as an open, unvalued position.
            return TradeResult(
                opportunity=opp, fills=fills, realised_pnl=0.0,
                one_legged=True, unwound=False,
                error="one-legged, holding (unwind disabled)",
            )

        # Reverse the filled leg immediately, accepting whatever the book gives.
        unwind_side = Side.SELL if side is Side.BUY else Side.BUY
        unwind_levels = book.bid_levels() if unwind_side is Side.SELL else book.ask_levels()
        out_size, out_notional, out_fee = simulate_fak(unwind_levels, good_leg.size, rate)

        if side is Side.BUY:
            # Bought at `notional`, sold back for `out_notional`.
            pnl = out_notional - notional - fee - out_fee
        else:
            # Sold at `notional`, bought back at `out_notional`.
            pnl = notional - out_notional - fee - out_fee

        fills.append(
            make_fill(good_leg.token_id, good_outcome, unwind_side,
                      out_size, out_notional, out_fee)
        )

        return TradeResult(
            opportunity=opp, fills=fills, realised_pnl=pnl,
            one_legged=True, unwound=True,
            error="" if out_size >= good_leg.size - 1e-9 else "partial unwind",
        )
