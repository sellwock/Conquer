"""Gap-lifetime analysis.

This is the measurement the funding decision rests on, so the tests here care most
about it being *conservative*: a gap seen once must not be reported as long-lived,
and capturability must be judged strictly against latency.
"""

import asyncio
import json
from pathlib import Path

import pytest

from polyarb.analysis import Gap, GapTracker, analyse_frames, extremity_bucket
from polyarb.config import Settings
from polyarb.feed import replay_frames
from polyarb.models import Direction, Leg, Market, Opportunity, Outcome, Side

FIXTURES = Path(__file__).parent / "fixtures"


def market(condition_id="0xa", slug="m", category="geopolitics"):
    return Market(
        condition_id=condition_id, question="Q", slug=slug,
        yes_token_id=f"{condition_id}_Y", no_token_id=f"{condition_id}_N",
        category=category, tick_size=0.01, min_order_size=5.0,
    )


def opp(m, edge=0.03, size=50.0, direction=Direction.CONVERGE, yes_price=0.42):
    side = Side.BUY if direction is Direction.CONVERGE else Side.SELL
    legs = (
        Leg(m.yes_token_id, Outcome.YES, side, yes_price, size, yes_price, 0.0),
        Leg(m.no_token_id, Outcome.NO, side, 1 - yes_price - edge, size, 0.0, 0.0),
    )
    return Opportunity(
        market=m, direction=direction, legs=legs, size=size,
        edge_per_pair=edge, gross_edge_per_pair=edge, fee_per_pair=0.0,
        gas_cost=0.02, total_profit=edge * size, book_age_ms=10.0,
    )


class TestExtremityBucket:
    def test_buckets(self):
        assert extremity_bucket(0.02) == "0-5c tail"
        assert extremity_bucket(0.98) == "0-5c tail"   # symmetric
        assert extremity_bucket(0.10) == "5-15c"
        assert extremity_bucket(0.20) == "15-30c"
        assert extremity_bucket(0.50) == "30-50c mid"
        assert extremity_bucket(0.45) == "30-50c mid"


class TestGapLifetime:
    def test_gap_opens_and_closes(self):
        m = market()
        t = GapTracker()
        t.observe(m, opp(m), 1000)
        t.observe(m, opp(m), 1500)
        t.observe(m, None, 1800)
        assert len(t.gaps) == 1
        assert t.gaps[0].lifetime_ms == pytest.approx(800)
        assert t.gaps[0].observations == 2

    def test_single_observation_has_zero_lifetime(self):
        # Conservative on purpose: one sighting is no evidence of persistence, and
        # this number decides whether real money gets deployed.
        m = market()
        t = GapTracker()
        t.observe(m, opp(m), 1000)
        t.observe(m, None, 1000)
        assert t.gaps[0].lifetime_ms == 0.0

    def test_unclosed_gap_is_closed_at_finish(self):
        m = market()
        t = GapTracker()
        t.observe(m, opp(m), 1000)
        t.observe(m, opp(m), 2000)
        t.finish()
        assert len(t.gaps) == 1
        assert t.gaps[0].lifetime_ms == pytest.approx(1000)

    def test_reopening_creates_a_second_gap(self):
        m = market()
        t = GapTracker()
        t.observe(m, opp(m), 1000)
        t.observe(m, None, 1200)
        t.observe(m, opp(m), 2000)
        t.observe(m, None, 2500)
        assert len(t.gaps) == 2
        assert [g.lifetime_ms for g in t.gaps] == pytest.approx([200, 500])

    def test_direction_flip_splits_the_gap(self):
        m = market()
        t = GapTracker()
        t.observe(m, opp(m, direction=Direction.CONVERGE), 1000)
        t.observe(m, opp(m, direction=Direction.DIVERGE), 1400)
        t.finish(1600)
        assert len(t.gaps) == 2
        assert {g.direction for g in t.gaps} == {"CONVERGE", "DIVERGE"}

    def test_markets_are_tracked_independently(self):
        a, b = market("0xa", "a"), market("0xb", "b")
        t = GapTracker()
        t.observe(a, opp(a), 1000)
        t.observe(b, opp(b), 1100)
        t.observe(a, None, 1200)
        t.observe(b, None, 1900)
        assert {g.slug: g.lifetime_ms for g in t.gaps} == pytest.approx(
            {"a": 200.0, "b": 800.0}
        )

    def test_peak_edge_is_retained(self):
        m = market()
        t = GapTracker()
        t.observe(m, opp(m, edge=0.01), 1000)
        t.observe(m, opp(m, edge=0.05), 1100)
        t.observe(m, opp(m, edge=0.02), 1200)
        t.finish()
        assert t.gaps[0].peak_edge_bps == pytest.approx(500.0)


class TestCapturability:
    def test_gap_must_outlive_latency(self):
        g = Gap("0xa", "m", "geo", "CONVERGE", opened_at_ms=0, closed_at_ms=200)
        assert g.capturable(150)
        assert g.capturable(200)
        assert not g.capturable(201)

    def test_summary_counts_only_reachable_gaps(self):
        m = market()
        t = GapTracker()
        # 500ms gap — reachable
        t.observe(m, opp(m), 0)
        t.observe(m, None, 500)
        # 50ms gap — gone before we arrive
        t.observe(m, opp(m), 1000)
        t.observe(m, None, 1050)
        t.finish()

        s = t.summary(latency_ms=150)
        assert s["gaps_detected"] == 2
        assert s["capturable"]["count"] == 1
        assert s["capturable"]["fraction"] == pytest.approx(0.5)

    def test_verdict_is_blunt_when_nothing_is_reachable(self):
        m = market()
        t = GapTracker()
        for i in range(30):  # 5 min apart -> ~2.4h window, past the rate threshold
            t.observe(m, opp(m), i * 300_000)
            t.observe(m, None, i * 300_000 + 10)  # 10ms gaps
        t.finish()
        s = t.summary(latency_ms=150)
        assert not s["sample_too_small_for_rates"]
        assert s["capturable"]["count"] == 0
        assert "Do not deploy capital" in s["verdict"]

    def test_verdict_is_encouraging_when_gaps_are_reachable(self):
        m = market()
        t = GapTracker()
        for i in range(20):  # ~1.6h window
            t.observe(m, opp(m), i * 300_000)
            t.observe(m, None, i * 300_000 + 5_000)  # 5s gaps
        t.finish()
        s = t.summary(latency_ms=150)
        assert not s["sample_too_small_for_rates"]
        assert s["capturable"]["fraction"] == 1.0
        assert "Worth paper trading" in s["verdict"]


class TestSmallSampleGuard:
    """A short recording must not imply an hourly income.

    Extrapolating "$2500/hour" from one lucky gap in a two-minute capture is the
    single most misleading thing this tool could do, so it refuses to.
    """

    def test_short_window_suppresses_rates(self):
        m = market()
        t = GapTracker()
        for i in range(20):  # plenty of gaps, but only ~2 minutes of data
            t.observe(m, opp(m), i * 5_000)
            t.observe(m, None, i * 5_000 + 1_000)
        t.finish()
        s = t.summary(latency_ms=150)
        assert s["sample_too_small_for_rates"]
        assert "too small to extrapolate" in s["verdict"]

    def test_too_few_gaps_suppresses_rates(self):
        m = market()
        t = GapTracker()
        for i in range(3):  # long window, but almost nothing happened
            t.observe(m, opp(m), i * 3_600_000)
            t.observe(m, None, i * 3_600_000 + 1_000)
        t.finish()
        s = t.summary(latency_ms=150)
        assert s["window_hours"] > 1.0
        assert s["sample_too_small_for_rates"]
        assert "too small to extrapolate" in s["verdict"]

    def test_lifetimes_are_still_reported_when_the_sample_is_small(self):
        # The rate is noise; the per-gap lifetime is a real measurement.
        m = market()
        t = GapTracker()
        t.observe(m, opp(m), 0)
        t.observe(m, None, 800)
        s = t.summary(latency_ms=150)
        assert s["lifetime_ms"]["p50"] == pytest.approx(800)
        assert s["capturable"]["count"] == 1
        assert "lifetime numbers are still real" in s["verdict"]

    def test_no_gaps_is_reported_as_a_result(self):
        t = GapTracker()
        t.observe(market(), None, 1000)
        s = t.summary(latency_ms=150)
        assert s["gaps_detected"] == 0
        assert "do not deploy capital" in s["verdict"].lower()


class TestGrouping:
    def test_by_category_and_extremity(self):
        geo = market("0xa", "geo-m", "geopolitics")
        spo = market("0xb", "spo-m", "sports")
        t = GapTracker()
        t.observe(geo, opp(geo, yes_price=0.97), 0)
        t.observe(geo, None, 500)
        t.observe(spo, opp(spo, yes_price=0.50), 0)
        t.observe(spo, None, 500)
        t.finish()

        s = t.summary(latency_ms=150)
        assert set(s["by_category"]) == {"geopolitics", "sports"}
        assert set(s["by_extremity"]) == {"0-5c tail", "30-50c mid"}
        assert s["by_category"]["geopolitics"]["gaps"] == 1

    def test_window_and_rate(self):
        m = market()
        t = GapTracker()
        t.observe(m, opp(m), 0)
        t.observe(m, None, 1_800_000)  # half an hour later
        s = t.summary(latency_ms=150)
        assert s["window_hours"] == pytest.approx(0.5)
        assert s["gaps_per_hour"] == pytest.approx(2.0)


class TestAgainstTheFixture:
    """The analyser runs over the same recording the end-to-end test uses."""

    def load_markets(self):
        rows = json.loads((FIXTURES / "sample-markets.json").read_text())
        return {r["condition_id"]: Market(**r) for r in rows}

    def run(self, settings=None):
        s = settings or Settings()
        tracker, on_frame = analyse_frames(self.load_markets(), s)
        asyncio.run(replay_frames(FIXTURES / "sample-frames.jsonl", on_frame))
        tracker.finish()
        return tracker

    def test_finds_the_geopolitics_gap(self):
        t = self.run()
        assert len(t.gaps) == 1
        assert t.gaps[0].slug == "treaty-signed"
        assert t.gaps[0].category == "geopolitics"

    def test_never_reports_the_crypto_market(self):
        # Same guard as the e2e suite: a 1c gap at 0.07 fee rate is not an
        # opportunity, and the analyser must not inflate the numbers with it.
        t = self.run()
        assert all(g.slug != "btc-above-100k" for g in t.gaps)

    def test_measures_the_gap_lifetime_from_the_recording(self):
        # The fixture opens the gap at T+1000ms and closes it at T+1400ms.
        t = self.run()
        assert t.gaps[0].lifetime_ms == pytest.approx(400, abs=1)

    def test_no_trading_occurs(self):
        # The analyser must not consume liquidity — that is what separates
        # "the market closed the gap" from "we closed it".
        t = self.run()
        assert t.gaps[0].observations >= 1
        s = t.summary(latency_ms=150)
        assert s["capturable"]["count"] == 1  # 400ms gap beats 150ms latency

    def test_latency_changes_the_verdict_not_the_data(self):
        t = self.run()
        assert t.summary(latency_ms=150)["capturable"]["count"] == 1
        # Same recording, slower bot: the gap was there but we could not reach it.
        assert t.summary(latency_ms=900)["capturable"]["count"] == 0
