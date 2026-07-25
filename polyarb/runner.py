"""Orchestration: wire the feed, books, detector, risk, execution and settlement.

The same object drives live paper trading, live real trading, and offline replay.
Only two things vary: where frames come from, and which execution engine is attached.
That is deliberate — a replay must exercise the identical code path a live run does,
or its results say nothing about live behaviour.

Time is injected rather than read from the wall clock. During replay the clock is
*stream time*, taken from server timestamps in the recording, so the modelled latency
means the same thing offline as it does live.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from .book import BookStore
from .config import Settings
from .detector import Detector
from .execution.base import ExecutionEngine
from .journal import Journal
from .models import Direction, Market, TradeResult
from .risk import RiskManager
from .settle import NullSettler, SettlementQueue, Settler

log = logging.getLogger(__name__)


class Runner:
    def __init__(
        self,
        settings: Settings,
        markets: dict[str, Market],
        # May be None at construction: the paper engine needs the runner's BookStore,
        # which does not exist until here. Assign `runner.engine` before the first frame.
        engine: ExecutionEngine | None,
        risk: RiskManager,
        *,
        journal: Journal | None = None,
        settler: Settler | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.settings = settings
        self.store = BookStore(
            tick_sizes={
                tid: m.tick_size
                for m in markets.values()
                for tid in (m.yes_token_id, m.no_token_id)
            }
        )
        self.detector = Detector(settings, markets)
        self.engine = engine
        self.risk = risk
        self.journal = journal
        self.settler = settler or NullSettler()
        self.settlement = SettlementQueue(settings.execution)

        # Stream time: the newest server timestamp seen. Falls back to the wall
        # clock before any frame arrives.
        self._stream_now_ms: float = 0.0
        self._clock = clock

        self.frames = 0
        self.opportunities = 0
        self.approved = 0
        self.rejected = 0
        self.skipped_in_flight = 0
        self.results: list[TradeResult] = []

        # Markets with an order already outstanding. An opportunity persists across
        # many frames — the book keeps showing the gap until someone takes it — so
        # without this the runner fires a fresh pair of orders on every single
        # update, stacking duplicate exposure on one opportunity and paying for the
        # late ones after the gap has closed.
        self._in_flight: set[str] = set()

    def now_ms(self) -> float:
        if self._clock is not None:
            return self._clock()
        if self._stream_now_ms > 0:
            return self._stream_now_ms
        import time

        return time.time() * 1000.0

    # --- frame handling ---------------------------------------------------
    def on_frame(self, frame: dict[str, Any]) -> None:
        """Process one websocket frame end to end."""
        self.frames += 1
        token_id = self.store.handle(frame)

        book = self.store.get(token_id) if token_id else None
        if book is not None and book.last_update_ms > self._stream_now_ms:
            self._stream_now_ms = book.last_update_ms

        now = self.now_ms()

        # Settle anything whose latency window elapsed, before looking for more.
        self._collect(self.engine.settle_due(now))

        if not token_id:
            return
        market = self.detector.market_for_token(token_id)
        if market is None or market.closed:
            return
        if market.condition_id in self._in_flight:
            self.skipped_in_flight += 1
            return

        self._consider(market, now)

    def _consider(self, market: Market, now: float) -> None:
        opp = self.detector.scan_market(
            market,
            self.store,
            available_capital=self.risk.available_capital,
            exposure_in_market=self.risk.exposure_snapshot().get(market.condition_id, 0.0),
            now_ms=now,
        )
        if opp is None:
            return

        self.opportunities += 1
        if self.journal:
            self.journal.opportunity(opp)

        approved, reason = self.risk.approve(opp)
        if not approved:
            self.rejected += 1
            if self.journal:
                self.journal.rejected(opp, reason)
            log.debug("rejected %s: %s", opp.market.slug, reason)
            return

        self.approved += 1
        # Reserve capital and exposure at submission. Anything not filled is
        # released when the result comes back.
        self.risk.add_exposure(
            market.condition_id, opp.size, capital=self.risk.capital_for(opp)
        )
        self._in_flight.add(market.condition_id)
        self.engine.submit(opp, now)

    def _collect(self, results: list[TradeResult]) -> None:
        for result in results:
            self.results.append(result)
            opp = result.opportunity
            self._in_flight.discard(opp.market.condition_id)

            # Release the reservation; realised P&L is applied by on_trade.
            self.risk.release_exposure(
                opp.market.condition_id, opp.size, capital_returned=self.risk.capital_for(opp)
            )
            self.risk.on_trade(result)

            if self.journal:
                self.journal.trade(result)

            if result.ok:
                self._record_inventory(result)

        if results:
            self._settle_due()

    def _record_inventory(self, result: TradeResult) -> None:
        """Track matched pairs so they can be merged back into collateral."""
        opp = result.opportunity
        if opp.direction is not Direction.CONVERGE:
            # Diverge already returned collateral by selling the minted pair.
            return
        filled = min(f.filled_size for f in result.fills if f.ok) if result.fills else 0.0
        if filled <= 0:
            return
        cost = sum(f.filled_size * f.avg_price + f.fee_paid for f in result.fills if f.ok)
        self.settlement.record(
            opp.market.condition_id,
            yes_size=filled,
            no_size=filled,
            cost=cost,
            neg_risk=opp.market.neg_risk,
            now=self.now_ms() / 1000.0,
        )

    def _settle_due(self) -> None:
        settled = self.settlement.settle(self.settler, now=self.now_ms() / 1000.0)
        for condition_id, pairs, tx in settled:
            # Merging returns exactly $1 per pair to free capital.
            self.risk.state.free_capital += pairs
            self.risk.state.gas_paid += self.settings.execution.gas_cost_per_settlement
            if self.journal:
                self.journal.event("merge", condition_id=condition_id, pairs=pairs, tx=tx)
            log.info("merged %.2f pairs of %s (%s)", pairs, condition_id, tx)

    # --- lifecycle --------------------------------------------------------
    def finish(self) -> None:
        """Settle outstanding work at end of run."""
        flush = getattr(self.engine, "flush", None)
        if flush is not None:
            self._collect(flush())
        # Force-merge whatever inventory remains, regardless of thresholds.
        for pos in list(self.settlement.positions.values()):
            pairs = pos.mergeable
            if pairs <= 0:
                continue
            try:
                tx = self.settler.merge(pos.condition_id, pairs, pos.neg_risk)
            except Exception as e:
                log.error("final merge failed for %s: %s", pos.condition_id, e)
                continue
            pos.yes_size -= pairs
            pos.no_size -= pairs
            self.risk.state.free_capital += pairs
            if self.journal:
                self.journal.event("merge", condition_id=pos.condition_id, pairs=pairs, tx=tx)

        leftover = self.settlement.unmatched()
        if leftover:
            log.warning("unmatched inventory remains: %s", leftover)
            if self.journal:
                self.journal.event("unmatched_inventory", positions=leftover)

    def summary(self) -> dict[str, Any]:
        return {
            "frames": self.frames,
            "opportunities": self.opportunities,
            "approved": self.approved,
            "rejected": self.rejected,
            "skipped_in_flight": self.skipped_in_flight,
            "detector": self.detector.stats.as_dict(),
            "risk": self.risk.summary(),
            "settlement": {
                "settled_pairs": round(self.settlement.settled_pairs, 4),
                "outstanding_pairs": round(self.settlement.outstanding_pairs(), 4),
                "unmatched": self.settlement.unmatched(),
            },
        }

    def invalidate(self, token_ids: list[str]) -> None:
        """Drop book state after a reconnect: resumed deltas cannot be trusted."""
        for tid in token_ids:
            if tid in self.store:
                book = self.store.get(tid)
                book.valid = False
                book.resync_requested = True
                book.desync_reason = "reconnected"
