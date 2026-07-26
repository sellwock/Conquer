"""Live execution.

Both legs go out together as fill-or-kill orders. The sizing module guarantees that
the limit prices carry positive marginal edge, so an FOK at those prices either fills
profitably or does not fill at all — there is no "fills at a bad price" branch.

What remains is the genuine hazard: **one leg fills and the other does not.** That
leaves a naked directional position, which is not what this bot is for. The response
is immediate and unconditional: reverse the filled leg at market, book the loss, and
record it. Losing a few cents to get flat is correct; hoping a naked leg comes good
is how an arbitrage bot turns into a gambling bot.

Every fill is also checked against the modelled fee. If reality disagrees with the
model beyond tolerance, the run halts — see `RiskManager.check_fee_reconciliation`.
"""

from __future__ import annotations

import logging

from ..config import Settings
from ..fees import taker_fee_per_share
from ..models import Direction, Opportunity, Outcome, Side, TradeResult
from ..risk import RiskManager
from .base import make_fill, pair_pnl
from .gateway import Gateway, OrderAck, OrderRequest

log = logging.getLogger(__name__)


class LiveEngine:
    """Executes opportunities against the real exchange."""

    def __init__(
        self,
        gateway: Gateway,
        settings: Settings,
        risk: RiskManager,
    ) -> None:
        self.gateway = gateway
        self.settings = settings
        self.risk = risk
        self._results: list[TradeResult] = []
        self.submitted = 0

    # --- ExecutionEngine interface ---------------------------------------
    def submit(self, opp: Opportunity, now_ms: float) -> None:
        """Execute now. Live trading has no simulated latency to wait out."""
        self.submitted += 1
        self._results.append(self.execute(opp))

    def settle_due(self, now_ms: float) -> list[TradeResult]:
        out, self._results = self._results, []
        return out

    def flush(self) -> list[TradeResult]:
        return self.settle_due(0.0)

    # --- execution --------------------------------------------------------
    def execute(self, opp: Opportunity) -> TradeResult:
        market = opp.market
        rate = self.settings.fee_rate_for(market.category)
        gas = self.settings.execution.gas_cost_per_settlement
        side = Side.BUY if opp.direction is Direction.CONVERGE else Side.SELL
        yes_leg, no_leg = opp.legs

        requests = [
            OrderRequest(
                token_id=leg.token_id, side=side, price=leg.limit_price, size=leg.size,
                tick_size=market.tick_size, neg_risk=market.neg_risk, order_type="FOK",
            )
            for leg in (yes_leg, no_leg)
        ]

        try:
            if self.settings.execution.batch_legs:
                acks = self.gateway.submit_batch(requests)
            else:
                # Sequential fallback: send the leg most likely to fail first, so a
                # miss costs nothing. Thinner side == higher limit-price risk, which
                # we proxy by the smaller expected notional.
                order = sorted(range(2), key=lambda i: requests[i].size * requests[i].price)
                acks = [OrderAck(ok=False, error="not attempted")] * 2
                for idx in order:
                    acks[idx] = self.gateway.submit(requests[idx])
                    if not acks[idx].ok:
                        break  # first leg missed: abort with zero exposure
        except Exception as e:
            log.exception("order submission failed")
            return TradeResult(
                opportunity=opp, fills=[], realised_pnl=0.0,
                one_legged=False, unwound=False,
                error=f"submission failed: {type(e).__name__}: {e}",
            )

        yes_ack, no_ack = acks[0], acks[1]
        self._reconcile_fees(opp, rate, [(yes_leg.token_id, yes_ack), (no_leg.token_id, no_ack)])

        if yes_ack.ok and no_ack.ok:
            fees = _fee_of(yes_ack, rate) + _fee_of(no_ack, rate)
            filled = min(yes_ack.filled_size, no_ack.filled_size)
            pnl = pair_pnl(opp.direction, filled, yes_ack.notional, no_ack.notional, fees, gas)
            return TradeResult(
                opportunity=opp,
                fills=[
                    make_fill(yes_leg.token_id, Outcome.YES, side, yes_ack.filled_size,
                              yes_ack.notional, _fee_of(yes_ack, rate), order_id=yes_ack.order_id),
                    make_fill(no_leg.token_id, Outcome.NO, side, no_ack.filled_size,
                              no_ack.notional, _fee_of(no_ack, rate), order_id=no_ack.order_id),
                ],
                realised_pnl=pnl, one_legged=False, unwound=False,
            )

        if not yes_ack.ok and not no_ack.ok:
            # Both killed. The gap closed before we arrived; nothing traded.
            return TradeResult(
                opportunity=opp,
                fills=[
                    make_fill(yes_leg.token_id, Outcome.YES, side, 0, 0, 0,
                              ok=False, error=yes_ack.error),
                    make_fill(no_leg.token_id, Outcome.NO, side, 0, 0, 0,
                              ok=False, error=no_ack.error),
                ],
                realised_pnl=0.0, one_legged=False, unwound=False,
            )

        return self._unwind(opp, side, rate, yes_ack, no_ack)

    def _unwind(
        self, opp: Opportunity, side: Side, rate: float, yes_ack: OrderAck, no_ack: OrderAck
    ) -> TradeResult:
        """Get flat after a one-legged fill."""
        yes_leg, no_leg = opp.legs
        if yes_ack.ok:
            good_leg, good_outcome, good_ack = yes_leg, Outcome.YES, yes_ack
            dead_leg, dead_outcome, dead_ack = no_leg, Outcome.NO, no_ack
        else:
            good_leg, good_outcome, good_ack = no_leg, Outcome.NO, no_ack
            dead_leg, dead_outcome, dead_ack = yes_leg, Outcome.YES, yes_ack

        fills = [
            make_fill(good_leg.token_id, good_outcome, side, good_ack.filled_size,
                      good_ack.notional, _fee_of(good_ack, rate), order_id=good_ack.order_id),
            make_fill(dead_leg.token_id, dead_outcome, side, 0, 0, 0,
                      ok=False, error=dead_ack.error),
        ]

        if not self.settings.execution.unwind_one_legged:
            return TradeResult(
                opportunity=opp, fills=fills, realised_pnl=0.0,
                one_legged=True, unwound=False,
                error="one-legged, holding (unwind disabled)",
            )

        unwind_side = Side.SELL if side is Side.BUY else Side.BUY
        # Price protection is deliberately wide: being flat matters more than the
        # last tick. FAK so a partial exit still gets most of the risk off.
        limit = 0.01 if unwind_side is Side.SELL else 0.99
        request = OrderRequest(
            token_id=good_leg.token_id, side=unwind_side, price=limit,
            size=good_ack.filled_size, tick_size=opp.market.tick_size,
            neg_risk=opp.market.neg_risk, order_type="FAK",
        )

        try:
            exit_ack = self.gateway.submit(request)
        except Exception as e:
            log.exception("unwind failed")
            exit_ack = OrderAck(ok=False, error=f"{type(e).__name__}: {e}")

        if not exit_ack.ok:
            # Still holding a naked leg. This is the worst state the bot can be in,
            # so it halts and hands over to a human rather than trading on.
            self.risk.halt(
                f"unwind failed on {opp.market.slug}: holding {good_ack.filled_size:.2f} "
                f"{good_outcome.value} — manual intervention required"
            )
            return TradeResult(
                opportunity=opp, fills=fills, realised_pnl=0.0,
                one_legged=True, unwound=False,
                error=f"unwind failed: {exit_ack.error}",
            )

        exit_fee = _fee_of(exit_ack, rate)
        entry_fee = _fee_of(good_ack, rate)
        if side is Side.BUY:
            pnl = exit_ack.notional - good_ack.notional - entry_fee - exit_fee
        else:
            pnl = good_ack.notional - exit_ack.notional - entry_fee - exit_fee

        fills.append(
            make_fill(good_leg.token_id, good_outcome, unwind_side, exit_ack.filled_size,
                      exit_ack.notional, exit_fee, order_id=exit_ack.order_id)
        )

        residual = good_ack.filled_size - exit_ack.filled_size
        error = "" if residual <= 1e-9 else f"partial unwind, {residual:.4f} shares still held"
        if residual > 1e-9:
            self.risk.halt(f"partial unwind on {opp.market.slug}: {residual:.4f} shares held")

        return TradeResult(
            opportunity=opp, fills=fills, realised_pnl=pnl,
            one_legged=True, unwound=True, error=error,
        )

    def _reconcile_fees(
        self, opp: Opportunity, rate: float, legs: list[tuple[str, OrderAck]]
    ) -> None:
        """Compare charged fees against the model on every filled leg."""
        for token_id, ack in legs:
            if not ack.ok or ack.filled_size <= 0 or ack.fee_paid < 0:
                continue  # nothing filled, or the venue reported no fee data
            predicted_per_share = taker_fee_per_share(ack.avg_price, rate)
            actual_per_share = ack.fee_paid / ack.filled_size
            self.risk.check_fee_reconciliation(
                predicted_per_share, actual_per_share,
                context=f"{opp.market.slug} {token_id[:10]}",
            )


def _fee_of(ack: OrderAck, rate: float) -> float:
    """Fee actually charged, falling back to the model when the venue is silent."""
    if ack.fee_paid >= 0:
        return ack.fee_paid
    return ack.filled_size * taker_fee_per_share(ack.avg_price, rate)
