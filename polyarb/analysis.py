"""Gap-lifetime analysis — the measurement that decides whether to trade at all.

Detecting an arbitrage is easy. The question that actually determines whether this
strategy is viable is different and harder:

    **How long does a gap stay open, compared to how long it takes us to reach it?**

If gaps close in 40ms and our round trip is 150ms, no amount of engineering saves the
strategy — we are looking at light from dead stars, and every "opportunity" the
detector reports is one we would have missed. If gaps routinely live for seconds, the
edge is real and worth pursuing.

This module answers that from recorded market data with **no trading and no execution
model at all**. That matters: the paper engine deliberately consumes the liquidity it
fills, so measuring lifetimes there would conflate "the market closed the gap" with
"we closed it ourselves". Here nothing is consumed, so a lifetime means exactly what
it says — how long the opportunity existed for anyone.

Two secondary questions it also answers:

* **Where does edge live?** Gaps are bucketed by price extremity, since the fee curve
  predicts that survivable edge concentrates near the tails. This checks the
  prediction against real data rather than assuming it.
* **How often?** Opportunities per hour, by category. A real but twice-weekly edge is
  a different business from a real hourly one.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Any

from .book import BookStore
from .config import Settings
from .detector import Detector
from .models import Market, Opportunity

# Price-extremity buckets, keyed by min(p, 1-p): 0.02 is a 2c/98c market, 0.5 is 50/50.
# The fee curve says cost collapses toward the left of this table.
EXTREMITY_BUCKETS: list[tuple[float, float, str]] = [
    (0.00, 0.05, "0-5c tail"),
    (0.05, 0.15, "5-15c"),
    (0.15, 0.30, "15-30c"),
    (0.30, 0.51, "30-50c mid"),
]


# Below either of these, per-hour rates are noise and are reported as such.
MIN_WINDOW_HOURS = 1.0
MIN_GAPS_FOR_RATE = 10


def extremity_bucket(price: float) -> str:
    e = min(price, 1.0 - price)
    for lo, hi, label in EXTREMITY_BUCKETS:
        if lo <= e < hi:
            return label
    return "30-50c mid"


@dataclass
class Gap:
    """One continuous stretch during which an opportunity was detectable."""

    condition_id: str
    slug: str
    category: str
    direction: str
    opened_at_ms: float
    closed_at_ms: float | None = None
    peak_edge_bps: float = 0.0
    peak_profit: float = 0.0
    peak_size: float = 0.0
    extremity: str = ""
    observations: int = 0

    @property
    def lifetime_ms(self) -> float:
        """How long the gap stayed open.

        A gap seen in only one frame has a lifetime of 0: we know it existed at that
        instant and have no evidence it survived any longer. Treating that as
        "instant" is the conservative reading, and conservative is the right bias
        when the answer decides whether real money gets deployed.
        """
        if self.closed_at_ms is None:
            return 0.0
        return max(0.0, self.closed_at_ms - self.opened_at_ms)

    def capturable(self, latency_ms: float) -> bool:
        """Would this still have been there when our order landed?"""
        return self.lifetime_ms >= latency_ms


@dataclass
class GapTracker:
    """Turns a stream of per-market scan results into gap lifetimes."""

    gaps: list[Gap] = field(default_factory=list)
    _open: dict[str, Gap] = field(default_factory=dict)
    # None rather than 0.0: a timestamp of zero is a legitimate value, and using it
    # as the "unset" sentinel silently resets the observation window.
    first_ms: float | None = None
    last_ms: float | None = None
    observations: int = 0

    def observe(self, market: Market, opp: Opportunity | None, now_ms: float) -> None:
        """Record the detector's verdict for one market at one instant."""
        self.observations += 1
        if self.first_ms is None:
            self.first_ms = now_ms
        self.last_ms = now_ms if self.last_ms is None else max(self.last_ms, now_ms)

        cid = market.condition_id
        current = self._open.get(cid)

        if opp is None:
            if current is not None:
                self._close(cid, now_ms)
            return

        direction = opp.direction.value
        # A flip in direction is a different opportunity, not a continuation.
        if current is not None and current.direction != direction:
            self._close(cid, now_ms)
            current = None

        if current is None:
            current = Gap(
                condition_id=cid,
                slug=market.slug,
                category=market.category or "unknown",
                direction=direction,
                opened_at_ms=now_ms,
                extremity=extremity_bucket(opp.legs[0].limit_price),
            )
            self._open[cid] = current

        current.observations += 1
        if opp.edge_bps > current.peak_edge_bps:
            current.peak_edge_bps = opp.edge_bps
            current.extremity = extremity_bucket(opp.legs[0].limit_price)
        current.peak_profit = max(current.peak_profit, opp.total_profit)
        current.peak_size = max(current.peak_size, opp.size)

    def _close(self, condition_id: str, now_ms: float) -> None:
        gap = self._open.pop(condition_id, None)
        if gap is None:
            return
        gap.closed_at_ms = now_ms
        self.gaps.append(gap)

    def finish(self, now_ms: float | None = None) -> None:
        """Close everything still open at end of stream."""
        end = now_ms if now_ms is not None else (self.last_ms or 0.0)
        for cid in list(self._open):
            self._close(cid, end)

    @property
    def window_hours(self) -> float:
        if self.first_ms is None or self.last_ms is None or self.last_ms <= self.first_ms:
            return 0.0
        return (self.last_ms - self.first_ms) / 3_600_000.0

    def summary(self, latency_ms: float) -> dict[str, Any]:
        """The report that decides whether Stage 2 gets built."""
        gaps = self.gaps
        hours = self.window_hours

        out: dict[str, Any] = {
            "window_hours": round(hours, 3),
            "markets_observed": len({g.condition_id for g in gaps}),
            "scans": self.observations,
            "gaps_detected": len(gaps),
            "gaps_per_hour": round(len(gaps) / hours, 2) if hours > 0 else None,
            "assumed_latency_ms": latency_ms,
            # Rates below this bar are noise; the report says so rather than
            # letting a two-minute recording imply an hourly income.
            "sample_too_small_for_rates": hours < MIN_WINDOW_HOURS or len(gaps) < MIN_GAPS_FOR_RATE,
        }

        if not gaps:
            out["verdict"] = (
                "No opportunities cleared the fee-and-edge threshold in this window. "
                "That is a result: do not deploy capital on this evidence."
            )
            return out

        lifetimes = [g.lifetime_ms for g in gaps]
        out["lifetime_ms"] = {
            "min": round(min(lifetimes), 1),
            "p50": round(statistics.median(lifetimes), 1),
            "p90": round(_pct(lifetimes, 0.90), 1),
            "max": round(max(lifetimes), 1),
        }

        capturable = [g for g in gaps if g.capturable(latency_ms)]
        out["capturable"] = {
            "count": len(capturable),
            "fraction": round(len(capturable) / len(gaps), 4),
            "per_hour": round(len(capturable) / hours, 2) if hours > 0 else None,
            "profit_if_all_captured": round(sum(g.peak_profit for g in capturable), 4),
        }
        out["theoretical_profit_all_gaps"] = round(sum(g.peak_profit for g in gaps), 4)

        edges = [g.peak_edge_bps for g in gaps]
        out["peak_edge_bps"] = {
            "min": round(min(edges), 1),
            "p50": round(statistics.median(edges), 1),
            "max": round(max(edges), 1),
        }

        out["by_category"] = _group(gaps, lambda g: g.category, latency_ms)
        out["by_extremity"] = _group(gaps, lambda g: g.extremity, latency_ms)
        out["verdict"] = _verdict(gaps, capturable, hours, latency_ms)
        return out


def _pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def _group(gaps: list[Gap], key, latency_ms: float) -> dict[str, dict[str, Any]]:
    buckets: dict[str, list[Gap]] = {}
    for g in gaps:
        buckets.setdefault(key(g), []).append(g)
    return {
        name: {
            "gaps": len(items),
            "capturable": sum(1 for g in items if g.capturable(latency_ms)),
            "median_edge_bps": round(statistics.median([g.peak_edge_bps for g in items]), 1),
            "median_lifetime_ms": round(statistics.median([g.lifetime_ms for g in items]), 1),
            "profit": round(sum(g.peak_profit for g in items), 4),
        }
        for name, items in sorted(buckets.items(), key=lambda kv: -len(kv[1]))
    }


def _verdict(gaps: list[Gap], capturable: list[Gap], hours: float, latency_ms: float) -> str:
    """A plain-language read on the numbers, so the answer is not left to wishful
    interpretation of a table."""
    frac = len(capturable) / len(gaps) if gaps else 0.0
    per_hour = len(capturable) / hours if hours > 0 else 0.0
    profit_per_hour = sum(g.peak_profit for g in capturable) / hours if hours > 0 else 0.0

    # Rates from a tiny sample are worse than no rates: a two-minute recording
    # containing one lucky gap extrapolates to a fantasy hourly figure, and that is
    # precisely the sort of encouraging-but-false number this tool exists to avoid.
    if hours < MIN_WINDOW_HOURS or len(gaps) < MIN_GAPS_FOR_RATE:
        return (
            f"Sample too small to extrapolate: {len(gaps)} gap(s) over {hours:.2f}h. "
            f"Per-hour figures are meaningless at this size — ignore them. The "
            f"lifetime numbers are still real ({len(capturable)}/{len(gaps)} outlived "
            f"{latency_ms:.0f}ms). Record at least {MIN_WINDOW_HOURS:.0f}h with "
            f"{MIN_GAPS_FOR_RATE}+ gaps before drawing any conclusion."
        )

    if frac < 0.05:
        return (
            f"Only {frac:.1%} of gaps outlived {latency_ms:.0f}ms of latency. The "
            f"opportunities are real but close far faster than we can reach them. "
            f"Do not deploy capital; the edge belongs to someone closer to the venue."
        )
    if per_hour < 0.5:
        return (
            f"{len(capturable)} capturable gaps over {hours:.1f}h "
            f"({per_hour:.2f}/hour, about ${profit_per_hour:.2f}/hour gross). Real but "
            f"rare — check that this clears infrastructure cost before committing."
        )
    return (
        f"{len(capturable)} of {len(gaps)} gaps ({frac:.1%}) outlived {latency_ms:.0f}ms, "
        f"at {per_hour:.2f}/hour and roughly ${profit_per_hour:.2f}/hour gross before "
        f"slippage and misses. Worth paper trading to confirm the fill rate holds up."
    )


def analyse_frames(
    markets: dict[str, Market],
    settings: Settings,
) -> tuple[GapTracker, Any]:
    """Build a detection-only pipeline. Returns (tracker, on_frame callable).

    Deliberately bypasses `Runner`: no risk manager, no execution engine, no
    in-flight suppression and no market impact. Every frame is scanned and every
    verdict recorded, which is what makes the lifetimes mean what they claim.

    Latency is not a parameter here: gap lifetimes are a property of the market, not
    of us. It is applied afterwards by `GapTracker.summary(latency_ms)`, so the same
    recording can be judged against several latencies without re-running.
    """
    store = BookStore(
        tick_sizes={
            tid: m.tick_size for m in markets.values() for tid in (m.yes_token_id, m.no_token_id)
        }
    )
    detector = Detector(settings, markets)
    tracker = GapTracker()
    state = {"now_ms": 0.0}

    # Generous, so detection is limited by the market rather than by our balance;
    # per-market and per-trade caps from the config still apply, so sizes stay real.
    capital = max(settings.risk.max_total_exposure, 1.0) * 10.0

    def on_frame(frame: dict[str, Any]) -> None:
        token_id = store.handle(frame)
        if not token_id:
            return
        book = store.get(token_id)
        if book.last_update_ms > state["now_ms"]:
            state["now_ms"] = book.last_update_ms
        now = state["now_ms"]

        market = detector.market_for_token(token_id)
        if market is None or market.closed:
            return
        opp = detector.scan_market(market, store, available_capital=capital, now_ms=now)
        tracker.observe(market, opp, now)

    return tracker, on_frame


__all__ = [
    "Gap",
    "GapTracker",
    "analyse_frames",
    "extremity_bucket",
    "EXTREMITY_BUCKETS",
]
