"""Risk limits and halt conditions."""

import pytest

from polyarb.config import Settings
from polyarb.models import Direction, Leg, LegFill, Market, Opportunity, Outcome, Side, TradeResult
from polyarb.risk import RiskManager


def market(condition_id="0xcond", category="geopolitics"):
    return Market(
        condition_id=condition_id, question="Q", slug="q",
        yes_token_id="YES", no_token_id="NO",
        category=category, tick_size=0.01, min_order_size=5.0,
    )


def opportunity(size=10.0, edge=0.05, direction=Direction.CONVERGE, m=None,
                book_age_ms=100.0, yes_price=0.40, no_price=0.55):
    m = m or market()
    side = Side.BUY if direction is Direction.CONVERGE else Side.SELL
    legs = (
        Leg("YES", Outcome.YES, side, yes_price, size, yes_price, 0.0),
        Leg("NO", Outcome.NO, side, no_price, size, no_price, 0.0),
    )
    return Opportunity(
        market=m, direction=direction, legs=legs, size=size,
        edge_per_pair=edge, gross_edge_per_pair=edge, fee_per_pair=0.0,
        gas_cost=0.02, total_profit=edge * size, book_age_ms=book_age_ms,
    )


def trade_result(opp, pnl=0.0, one_legged=False, unwound=False, error="", fee=0.0):
    return TradeResult(
        opportunity=opp,
        fills=[LegFill("YES", Outcome.YES, Side.BUY, opp.size, 0.4, fee)],
        realised_pnl=pnl, one_legged=one_legged, unwound=unwound, error=error,
    )


@pytest.fixture
def rm():
    return RiskManager(Settings(), starting_capital=500.0)


class TestApproval:
    def test_approves_a_good_trade(self, rm):
        ok, reason = rm.approve(opportunity())
        assert ok, reason

    def test_rejects_below_min_edge(self, rm):
        # Default minimum is 40bps.
        ok, reason = rm.approve(opportunity(edge=0.001))
        assert not ok
        assert "below minimum" in reason

    def test_rejects_stale_book(self, rm):
        ok, reason = rm.approve(opportunity(book_age_ms=99_999))
        assert not ok
        assert "book age" in reason

    def test_rejects_zero_size(self, rm):
        ok, _ = rm.approve(opportunity(size=0.0))
        assert not ok

    def test_rejects_oversized_trade(self, rm):
        # Capital is checked before the size caps, so this trips on capital first.
        ok, reason = rm.approve(opportunity(size=999.0))
        assert not ok
        assert reason

    def test_max_trade_size_is_enforced_when_capital_is_ample(self):
        st = Settings()
        st.risk.max_position_per_market = 10_000.0
        st.risk.max_total_exposure = 10_000.0
        st.risk.max_trade_size = 50.0
        rm = RiskManager(st, starting_capital=1_000_000.0)
        ok, reason = rm.approve(opportunity(size=60.0))
        assert not ok
        assert "max trade size" in reason
        assert rm.approve(opportunity(size=50.0))[0]

    def test_rejects_when_capital_short(self):
        rm = RiskManager(Settings(), starting_capital=1.0)
        ok, reason = rm.approve(opportunity(size=10.0))
        assert not ok
        assert "free" in reason

    def test_diverge_capital_is_a_dollar_per_pair(self):
        rm = RiskManager(Settings(), starting_capital=5.0)
        # Converge only needs 0.95/pair, so 5 pairs fit inside $5.
        ok, _ = rm.approve(opportunity(size=5.0, direction=Direction.CONVERGE))
        assert ok
        # Diverge must mint at $1/pair plus gas, so the same size does not fit.
        ok, reason = rm.approve(opportunity(size=5.0, direction=Direction.DIVERGE))
        assert not ok
        assert "free" in reason


class TestExposureCaps:
    def test_per_market_cap(self, rm):
        rm.add_exposure("0xcond", 45.0, capital=45.0)
        ok, reason = rm.approve(opportunity(size=10.0))
        assert not ok
        assert "market exposure" in reason

    def test_total_exposure_cap(self):
        st = Settings()
        st.risk.max_position_per_market = 100.0
        st.risk.max_total_exposure = 120.0
        rm = RiskManager(st, starting_capital=10_000.0)
        rm.add_exposure("0xa", 100.0, capital=100.0)
        ok, reason = rm.approve(opportunity(size=50.0, m=market("0xb")))
        assert not ok
        assert "total exposure" in reason

    def test_release_frees_capacity(self, rm):
        rm.add_exposure("0xcond", 50.0, capital=50.0)
        assert not rm.approve(opportunity(size=10.0))[0]
        rm.release_exposure("0xcond", 50.0, capital_returned=50.0)
        assert rm.approve(opportunity(size=10.0))[0]
        assert rm.state.exposure_by_market == {}

    def test_partial_release_keeps_remainder(self, rm):
        rm.add_exposure("0xcond", 50.0, capital=50.0)
        rm.release_exposure("0xcond", 20.0, capital_returned=20.0)
        assert rm.state.exposure_by_market["0xcond"] == pytest.approx(30.0)

    def test_capital_tracks_exposure(self, rm):
        start = rm.available_capital
        rm.add_exposure("0xcond", 10.0, capital=9.5)
        assert rm.available_capital == pytest.approx(start - 9.5)


class TestHalting:
    def test_daily_loss_halts(self):
        st = Settings()
        st.risk.max_daily_loss = 10.0
        rm = RiskManager(st, starting_capital=500.0)
        rm.on_trade(trade_result(opportunity(), pnl=-6.0))
        assert not rm.state.halted
        rm.on_trade(trade_result(opportunity(), pnl=-5.0))
        assert rm.state.halted
        assert "daily loss" in rm.state.halt_reason
        assert not rm.approve(opportunity())[0]

    def test_one_legged_rate_halts(self):
        st = Settings()
        st.risk.one_legged_window = 4
        st.risk.max_one_legged_rate = 0.25
        rm = RiskManager(st, starting_capital=500.0)
        # Window must fill before the rate is judged.
        for _ in range(3):
            rm.on_trade(trade_result(opportunity(), one_legged=True))
        assert not rm.state.halted
        rm.on_trade(trade_result(opportunity(), one_legged=True))
        assert rm.state.halted
        assert "one-legged rate" in rm.state.halt_reason

    def test_healthy_fills_do_not_halt(self):
        st = Settings()
        st.risk.one_legged_window = 4
        rm = RiskManager(st, starting_capital=500.0)
        for _ in range(20):
            rm.on_trade(trade_result(opportunity(), pnl=0.1))
        assert not rm.state.halted

    def test_consecutive_errors_halt(self):
        st = Settings()
        st.risk.max_consecutive_errors = 3
        rm = RiskManager(st, starting_capital=500.0)
        for _ in range(2):
            rm.on_trade(trade_result(opportunity(), error="boom"))
        assert not rm.state.halted
        rm.on_trade(trade_result(opportunity(), error="boom"))
        assert rm.state.halted
        assert "consecutive execution errors" in rm.state.halt_reason

    def test_a_success_resets_the_error_streak(self):
        st = Settings()
        st.risk.max_consecutive_errors = 3
        rm = RiskManager(st, starting_capital=500.0)
        rm.on_trade(trade_result(opportunity(), error="boom"))
        rm.on_trade(trade_result(opportunity(), error="boom"))
        rm.on_trade(trade_result(opportunity(), pnl=0.5))
        rm.on_trade(trade_result(opportunity(), error="boom"))
        assert not rm.state.halted

    def test_halt_is_sticky_until_cleared(self, rm):
        rm.halt("because")
        assert not rm.approve(opportunity())[0]
        rm.clear_halt()
        assert rm.approve(opportunity())[0]

    def test_first_halt_reason_is_kept(self, rm):
        rm.halt("first")
        rm.halt("second")
        assert rm.state.halt_reason == "first"


class TestFeeReconciliation:
    def test_matching_fees_pass(self, rm):
        assert rm.check_fee_reconciliation(0.0125, 0.0126)
        assert not rm.state.halted

    def test_divergence_halts(self, rm):
        # Default tolerance is $0.002/share.
        assert not rm.check_fee_reconciliation(predicted=0.0125, actual=0.0500)
        assert rm.state.halted
        assert "fee model divergence" in rm.state.halt_reason

    def test_context_is_reported(self, rm):
        rm.check_fee_reconciliation(0.01, 0.9, context="market-slug")
        assert "market-slug" in rm.state.halt_reason


class TestKillSwitch:
    def test_file_presence_blocks_trading(self, tmp_path):
        path = tmp_path / "HALT"
        rm = RiskManager(Settings(), starting_capital=500.0, kill_switch_path=path)
        assert rm.approve(opportunity())[0]

        path.write_text("stop")
        ok, reason = rm.approve(opportunity())
        assert not ok
        assert "kill switch" in reason

        path.unlink()
        assert rm.approve(opportunity())[0]

    def test_no_path_means_no_kill_switch(self, rm):
        assert not rm.kill_switch_engaged()


class TestSummary:
    def test_counts_and_pnl(self, rm):
        rm.on_trade(trade_result(opportunity(), pnl=1.0, fee=0.05))
        rm.on_trade(trade_result(opportunity(), pnl=-0.5, one_legged=True, unwound=True))
        s = rm.summary()
        assert s["trades_attempted"] == 2
        assert s["trades_filled"] == 1
        assert s["trades_one_legged"] == 1
        assert s["trades_unwound"] == 1
        assert s["realised_pnl"] == pytest.approx(0.5)
        assert s["one_legged_rate"] == pytest.approx(0.5)
        assert s["fees_paid"] == pytest.approx(0.05)

    def test_pnl_flows_back_into_capital(self, rm):
        start = rm.available_capital
        rm.on_trade(trade_result(opportunity(), pnl=2.5))
        assert rm.available_capital == pytest.approx(start + 2.5)
