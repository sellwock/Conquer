"""Paper execution engine.

These tests pin the behaviour that makes paper results trustworthy: latency is real,
fill-or-kill can fail, and a failure to fill is recorded rather than assumed away.
"""

import pytest

from polyarb.book import BookStore
from polyarb.config import Settings
from polyarb.detector import Detector
from polyarb.execution.paper import PaperEngine
from polyarb.models import Direction, Market

NOW = 1_700_000_000_000
LATENCY = 150.0  # default assumed_latency_ms


def market(category="geopolitics"):
    return Market(
        condition_id="0xcond", question="Q", slug="q",
        yes_token_id="YES", no_token_id="NO",
        category=category, tick_size=0.01, min_order_size=5.0, liquidity=10_000.0,
    )


def book_msg(token, bids, asks, ts=NOW):
    return {
        "event_type": "book", "asset_id": token,
        "bids": [{"price": str(p), "size": str(s)} for p, s in bids],
        "asks": [{"price": str(p), "size": str(s)} for p, s in asks],
        "timestamp": str(ts),
    }


def setup(yes_bids, yes_asks, no_bids, no_asks, ts=NOW, category="geopolitics"):
    st = Settings()
    m = market(category)
    store = BookStore()
    store.handle(book_msg("YES", yes_bids, yes_asks, ts))
    store.handle(book_msg("NO", no_bids, no_asks, ts))
    det = Detector(st, {m.condition_id: m})
    engine = PaperEngine(store, st)
    return st, m, store, det, engine


def move(store, token, bids, asks, ts):
    store.handle(book_msg(token, bids, asks, ts))


class TestLatency:
    def test_nothing_settles_before_the_latency_window(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)

        assert engine.settle_due(NOW + LATENCY - 1) == []
        assert engine.pending_count == 1
        assert len(engine.settle_due(NOW + LATENCY)) == 1
        assert engine.pending_count == 0

    def test_flush_settles_everything(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        engine.submit(det.scan_market(m, store, available_capital=1000.0, now_ms=NOW), NOW)
        assert len(engine.flush()) == 1


class TestFills:
    def test_full_fill_realises_the_expected_profit(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        (result,) = engine.settle_due(NOW + LATENCY)

        assert result.ok
        assert not result.one_legged
        # size 50 (max_trade_size) at 0.40 + 0.55, merged for $1, less $0.02 gas.
        assert result.realised_pnl == pytest.approx(50 - 20.0 - 27.5 - 0.02)
        assert result.realised_pnl == pytest.approx(opp.total_profit)

    def test_fills_are_priced_per_level_on_a_swept_book(self):
        _, m, store, det, engine = setup(
            [(0.38, 100)], [(0.40, 10), (0.41, 100)],
            [(0.53, 100)], [(0.55, 100)],
        )
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        (result,) = engine.settle_due(NOW + LATENCY)
        yes_fill = result.fills[0]
        # 10 @ 0.40 then the rest @ 0.41
        assert yes_fill.avg_price > 0.40
        assert yes_fill.avg_price < 0.41
        assert result.ok


class TestMarketImpact:
    """A simulated fill must remove the liquidity it took.

    Otherwise the same resting offer gets lifted on every subsequent frame and paper
    results overstate both volume and profit on any gap that persists.
    """

    def test_fill_consumes_the_book(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 50)],
                                         [(0.53, 100)], [(0.55, 200)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        assert opp.size == pytest.approx(50)
        engine.submit(opp, NOW)
        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.ok

        # The 50-share offer we lifted is gone; the NO side is drawn down by 50.
        assert store.get("YES").best_ask() is None
        assert store.get("NO").best_ask().size == pytest.approx(150)

    def test_gap_is_not_tradable_twice(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 50)],
                                         [(0.53, 100)], [(0.55, 200)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        engine.settle_due(NOW + LATENCY)
        # Same books, one scan later: the opportunity is genuinely gone.
        assert det.scan_market(m, store, available_capital=1000.0, now_ms=NOW + LATENCY) is None

    def test_one_legged_fill_also_consumes(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        move(store, "YES", [(0.44, 100)], [(0.46, 100)], NOW + 50)
        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.one_legged
        # The NO leg filled 50 of the 100 offered, then unwound into the bid.
        assert store.get("NO").best_ask().size == pytest.approx(50)


class TestOpportunityEvaporates:
    def test_both_legs_killed_when_the_gap_closes(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)

        # Someone faster took it: both sides reprice above our limits.
        move(store, "YES", [(0.44, 100)], [(0.46, 100)], NOW + 50)
        move(store, "NO", [(0.56, 100)], [(0.58, 100)], NOW + 50)

        (result,) = engine.settle_due(NOW + LATENCY)
        assert not result.ok
        assert not result.one_legged
        assert result.realised_pnl == 0.0
        assert all(not f.ok for f in result.fills)

    def test_thin_book_kills_a_fok_that_cannot_fill_in_full(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        # Size at our price collapses to less than we need: FOK is all-or-nothing.
        move(store, "YES", [(0.38, 100)], [(0.40, 1)], NOW + 50)
        move(store, "NO", [(0.53, 100)], [(0.55, 1)], NOW + 50)

        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.realised_pnl == 0.0
        assert not result.one_legged


class TestOneLegged:
    def test_unwinds_and_books_the_loss(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)

        # YES runs away, NO still fills -> we end up long 50 NO and naked.
        move(store, "YES", [(0.44, 100)], [(0.46, 100)], NOW + 50)

        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.one_legged
        assert result.unwound
        assert not result.ok
        # Bought 50 NO at 0.55 (=27.50), dumped them into the 0.53 bid (=26.50).
        assert result.realised_pnl == pytest.approx(26.5 - 27.5)
        assert len(result.fills) == 3  # filled leg, killed leg, unwind

    def test_holding_is_recorded_when_unwind_disabled(self):
        st, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                          [(0.53, 100)], [(0.55, 100)])
        st.execution.unwind_one_legged = False
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        move(store, "YES", [(0.44, 100)], [(0.46, 100)], NOW + 50)

        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.one_legged
        assert not result.unwound
        assert "unwind disabled" in result.error

    def test_partial_unwind_is_flagged(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        move(store, "YES", [(0.44, 100)], [(0.46, 100)], NOW + 50)
        # Only 5 of our 50 NO shares can be sold back.
        move(store, "NO", [(0.53, 5)], [(0.55, 100)], NOW + 50)

        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.one_legged and result.unwound
        assert result.error == "partial unwind"


class TestDesyncAtSettleTime:
    def test_invalid_book_blocks_the_fill(self):
        _, m, store, det, engine = setup([(0.38, 100)], [(0.40, 100)],
                                         [(0.53, 100)], [(0.55, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        # Corrupt the YES book while the order is notionally in flight.
        store.handle({
            "event_type": "price_change", "asset_id": "YES",
            "changes": [{"price": "0.99", "side": "BUY", "size": "10"}],
            "timestamp": str(NOW + 50),
        })
        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.realised_pnl == 0.0
        assert "book invalid" in result.error


class TestDiverge:
    def test_diverge_fills_and_pays(self):
        _, m, store, det, engine = setup([(0.60, 100)], [(0.62, 100)],
                                         [(0.45, 100)], [(0.47, 100)])
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        assert opp.direction is Direction.DIVERGE
        engine.submit(opp, NOW)
        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.ok
        # Minted 50 pairs for $50, sold at 0.60 + 0.45 = $52.50, less gas.
        assert result.realised_pnl == pytest.approx(30.0 + 22.5 - 50 - 0.02)


class TestFeesAreCharged:
    def test_fee_category_reduces_realised_pnl(self):
        _, m, store, det, engine = setup(
            [(0.93, 200)], [(0.94, 200)], [(0.04, 200)], [(0.05, 200)],
            category="sports",
        )
        opp = det.scan_market(m, store, available_capital=1000.0, now_ms=NOW)
        engine.submit(opp, NOW)
        (result,) = engine.settle_due(NOW + LATENCY)
        assert result.ok
        total_fee = sum(f.fee_paid for f in result.fills)
        assert total_fee > 0
        # Gross would be 1 cent per pair; fees eat part of it.
        assert result.realised_pnl < opp.size * 0.01
        assert result.realised_pnl == pytest.approx(opp.total_profit)
