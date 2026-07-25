"""End-to-end: recorded frames in, trades and merges out.

This exercises the exact code path a live run uses — same Runner, same detector, same
paper engine, same settlement queue — differing only in where frames come from. If a
replay result cannot be trusted to mean something about live behaviour, the whole
verification ladder is worthless, so the paths must not diverge.

The fixture scenario is documented in `tests/fixtures/make_fixture.py`.
"""

import asyncio
import json
from pathlib import Path

import pytest

from polyarb.config import Settings
from polyarb.execution.paper import PaperEngine
from polyarb.feed import replay_frames
from polyarb.journal import Journal, read_journal, summarise
from polyarb.models import Direction, Market
from polyarb.risk import RiskManager
from polyarb.runner import Runner
from polyarb.settle import NullSettler

FIXTURES = Path(__file__).parent / "fixtures"


def load_markets() -> dict[str, Market]:
    rows = json.loads((FIXTURES / "sample-markets.json").read_text())
    markets = [Market(**r) for r in rows]
    return {m.condition_id: m for m in markets}


def build_runner(capital=500.0, journal=None, settings=None):
    s = settings or Settings()
    risk = RiskManager(s, starting_capital=capital)
    settler = NullSettler()
    runner = Runner(s, load_markets(), engine=None, risk=risk,
                    journal=journal, settler=settler)
    runner.engine = PaperEngine(runner.store, s)
    return runner, risk, settler


def run_replay(runner) -> int:
    count = asyncio.run(replay_frames(FIXTURES / "sample-frames.jsonl", runner.on_frame))
    runner.finish()
    return count


class TestReplayPipeline:
    def test_processes_every_frame(self):
        runner, _, _ = build_runner()
        assert run_replay(runner) == 22
        assert runner.frames == 22

    def test_finds_the_geopolitics_arbitrage(self):
        runner, _, _ = build_runner()
        run_replay(runner)
        assert runner.opportunities > 0
        slugs = {o.market.slug for o in (r.opportunity for r in runner.results)}
        assert "treaty-signed" in slugs

    def test_never_trades_the_crypto_market(self):
        # 1c gross gap, but the 0.07 fee rate costs ~3.5c per pair at those prices.
        # If this ever fails, the fee model has broken.
        runner, _, _ = build_runner()
        run_replay(runner)
        slugs = {r.opportunity.market.slug for r in runner.results}
        assert "btc-above-100k" not in slugs
        assert runner.detector.stats.per_market_emitted.get("btc-above-100k", 0) == 0

    def test_trade_is_a_converge_and_fills(self):
        runner, _, _ = build_runner()
        run_replay(runner)
        assert runner.results
        result = runner.results[0]
        assert result.opportunity.direction is Direction.CONVERGE
        assert result.ok
        # Bought at 0.42 + 0.55 = 0.97, merged for $1.00, less gas.
        assert result.realised_pnl > 0

    def test_profit_matches_the_model(self):
        runner, _, _ = build_runner()
        run_replay(runner)
        result = runner.results[0]
        opp = result.opportunity
        assert result.realised_pnl == pytest.approx(opp.total_profit)
        expected = opp.size * (1 - 0.42 - 0.55) - opp.gas_cost
        assert result.realised_pnl == pytest.approx(expected)


class TestSettlement:
    def test_pairs_are_merged_back_into_collateral(self):
        runner, _, settler = build_runner()
        run_replay(runner)
        assert settler.merges, "matched inventory should have been merged"
        merged_pairs = sum(pairs for _, pairs in settler.merges)
        assert merged_pairs == pytest.approx(runner.results[0].opportunity.size)

    def test_no_unmatched_inventory_remains(self):
        # Anything left here is a naked leg, which is the failure this bot must avoid.
        runner, _, _ = build_runner()
        run_replay(runner)
        assert runner.settlement.unmatched() == {}

    def test_capital_is_recycled_and_grows(self):
        runner, risk, _ = build_runner(capital=500.0)
        run_replay(runner)
        # Merging returns $1 per pair, so free capital ends above where it started.
        assert risk.available_capital > 500.0
        assert risk.state.realised_pnl > 0


class TestRiskIntegration:
    def test_small_capital_shrinks_the_trade(self):
        big, _, _ = build_runner(capital=500.0)
        run_replay(big)
        small, _, _ = build_runner(capital=20.0)
        run_replay(small)
        assert small.results[0].opportunity.size < big.results[0].opportunity.size

    def test_a_halted_bot_stops_trading(self):
        runner, risk, _ = build_runner()
        risk.halt("manual")
        run_replay(runner)
        assert runner.results == []
        assert runner.rejected > 0

    def test_high_min_edge_rejects_everything(self):
        s = Settings()
        s.risk.min_edge_bps = 5_000  # demand 50c per pair
        runner, _, _ = build_runner(settings=s)
        run_replay(runner)
        assert runner.results == []


class TestJournalling:
    def test_journal_records_the_run(self, tmp_path):
        with Journal(tmp_path) as journal:
            runner, _, _ = build_runner(journal=journal)
            run_replay(runner)
            path = journal.path

        rows = read_journal(path)
        kinds = {r["kind"] for r in rows}
        assert "opportunity" in kinds
        assert "trade" in kinds
        assert "event" in kinds  # the merge

        summary = summarise(rows)
        assert summary["opportunities_detected"] > 0
        assert summary["trades_filled"] >= 1
        assert summary["total_realised_pnl"] > 0
        assert summary["one_legged_rate"] == 0.0
        assert "edge_bps" in summary

    def test_capture_ratio_is_reported(self, tmp_path):
        with Journal(tmp_path) as journal:
            runner, _, _ = build_runner(journal=journal)
            run_replay(runner)
            path = journal.path
        summary = summarise(read_journal(path))
        # Nothing moved against us in the fixture, so we capture the full model edge.
        assert summary["capture_ratio"] == pytest.approx(1.0, abs=0.01)

    def test_rejections_are_journalled_with_reasons(self, tmp_path):
        with Journal(tmp_path) as journal:
            runner, risk, _ = build_runner(journal=journal)
            risk.halt("testing")
            run_replay(runner)
            path = journal.path
        rows = [r for r in read_journal(path) if r["kind"] == "rejected"]
        assert rows
        assert all("halted" in r["reason"] for r in rows)


class TestSummary:
    def test_summary_is_complete(self):
        runner, _, _ = build_runner()
        run_replay(runner)
        s = runner.summary()
        assert s["frames"] == 22
        assert s["approved"] >= 1
        assert s["risk"]["trades_filled"] >= 1
        assert s["settlement"]["settled_pairs"] > 0
        assert s["detector"]["scans"] > 0


class TestDeterminism:
    def test_replay_is_reproducible(self):
        results = []
        for _ in range(3):
            runner, risk, _ = build_runner()
            run_replay(runner)
            results.append((len(runner.results), round(risk.state.realised_pnl, 9)))
        assert len(set(results)) == 1
