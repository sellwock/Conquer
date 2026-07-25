"""Detection across paired complementary books."""

import pytest

from polyarb.book import BookStore
from polyarb.config import Settings
from polyarb.detector import Detector
from polyarb.models import Direction, Market

NOW = 1_700_000_000_000


def make_market(category="geopolitics", **kw):
    defaults = dict(
        condition_id="0xcond",
        question="Will it happen?",
        slug="will-it-happen",
        yes_token_id="YES",
        no_token_id="NO",
        category=category,
        tick_size=0.01,
        min_order_size=5.0,
        liquidity=10_000.0,
    )
    defaults.update(kw)
    return Market(**defaults)


def book_msg(token, bids, asks, ts=NOW):
    return {
        "event_type": "book",
        "asset_id": token,
        "bids": [{"price": str(p), "size": str(s)} for p, s in bids],
        "asks": [{"price": str(p), "size": str(s)} for p, s in asks],
        "timestamp": str(ts),
    }


def store_with(yes_bids, yes_asks, no_bids, no_asks, ts=NOW):
    s = BookStore()
    s.handle(book_msg("YES", yes_bids, yes_asks, ts))
    s.handle(book_msg("NO", no_bids, no_asks, ts))
    return s


@pytest.fixture
def settings():
    return Settings()


class TestConvergeDetection:
    def test_finds_opportunity(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with(
            yes_bids=[(0.38, 100)], yes_asks=[(0.40, 100)],
            no_bids=[(0.53, 100)], no_asks=[(0.55, 100)],
        )
        opp = d.scan_market(m, s, available_capital=1000.0, now_ms=NOW)

        assert opp is not None
        assert opp.direction is Direction.CONVERGE
        # Capped by max_trade_size / max_position_per_market, both 50 by default.
        assert opp.size == pytest.approx(50.0)
        # 1 - 0.40 - 0.55 = 0.05 gross, minus 0.02 gas over 50 pairs.
        assert opp.gross_edge_per_pair == pytest.approx(0.05)
        assert opp.edge_per_pair == pytest.approx(0.05 - 0.02 / 50)
        assert opp.fee_per_pair == 0.0  # geopolitics is fee-free

        yes_leg, no_leg = opp.legs
        assert yes_leg.side.value == "BUY" and no_leg.side.value == "BUY"
        assert yes_leg.limit_price == pytest.approx(0.40)
        assert no_leg.limit_price == pytest.approx(0.55)

    def test_no_opportunity_at_parity(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.39, 100)], [(0.40, 100)], [(0.59, 100)], [(0.60, 100)])
        assert d.scan_market(m, s, available_capital=1000.0, now_ms=NOW) is None


class TestDivergeDetection:
    def test_finds_opportunity(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with(
            yes_bids=[(0.60, 100)], yes_asks=[(0.62, 100)],
            no_bids=[(0.45, 100)], no_asks=[(0.47, 100)],
        )
        opp = d.scan_market(m, s, available_capital=1000.0, now_ms=NOW)
        assert opp is not None
        assert opp.direction is Direction.DIVERGE
        assert all(leg.side.value == "SELL" for leg in opp.legs)
        assert opp.gross_edge_per_pair == pytest.approx(0.05)


class TestFeeCategoryDrivesEverything:
    """The same book is a trade in one category and a loss in another."""

    BOOKS = dict(
        yes_bids=[(0.48, 200)], yes_asks=[(0.49, 200)],
        no_bids=[(0.49, 200)], no_asks=[(0.50, 200)],
    )

    def test_free_category_takes_the_one_cent_gap(self, settings):
        m = make_market(category="geopolitics")
        d = Detector(settings, {m.condition_id: m})
        opp = d.scan_market(m, store_with(**self.BOOKS), available_capital=1000.0, now_ms=NOW)
        assert opp is not None
        assert opp.gross_edge_per_pair == pytest.approx(0.01)

    def test_crypto_category_rejects_the_same_book(self, settings):
        m = make_market(category="crypto")  # rate 0.07
        d = Detector(settings, {m.condition_id: m})
        assert d.scan_market(m, store_with(**self.BOOKS), available_capital=1000.0, now_ms=NOW) is None

    def test_unknown_category_is_treated_as_expensive(self, settings):
        m = make_market(category="something-we-never-heard-of")
        d = Detector(settings, {m.condition_id: m})
        assert d.scan_market(m, store_with(**self.BOOKS), available_capital=1000.0, now_ms=NOW) is None

    def test_tail_prices_survive_even_in_a_fee_category(self, settings):
        m = make_market(category="sports")  # rate 0.05
        d = Detector(settings, {m.condition_id: m})
        s = store_with(
            yes_bids=[(0.93, 200)], yes_asks=[(0.94, 200)],
            no_bids=[(0.04, 200)], no_asks=[(0.05, 200)],
        )
        opp = d.scan_market(m, s, available_capital=1000.0, now_ms=NOW)
        assert opp is not None


class TestSafetyGuards:
    def test_stale_books_are_not_traded(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 100)], [(0.40, 100)], [(0.53, 100)], [(0.55, 100)], ts=NOW)
        # Default max_book_age_ms is 1500.
        assert d.scan_market(m, s, available_capital=1000.0, now_ms=NOW + 5000) is None
        assert d.stats.skipped_untradable_book == 1

    def test_desynced_book_is_not_traded(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 100)], [(0.40, 100)], [(0.53, 100)], [(0.55, 100)])
        # Force a crossed book on the YES side.
        s.handle({
            "event_type": "price_change", "asset_id": "YES",
            "changes": [{"price": "0.99", "side": "BUY", "size": "10"}],
            "timestamp": str(NOW),
        })
        assert not s.get("YES").valid
        assert d.scan_market(m, s, available_capital=1000.0, now_ms=NOW) is None

    def test_one_sided_book_is_not_traded(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 100)], [], [(0.53, 100)], [(0.55, 100)])
        assert d.scan_market(m, s, available_capital=1000.0, now_ms=NOW) is None

    def test_capital_limits_size(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 500)], [(0.40, 500)], [(0.53, 500)], [(0.55, 500)])
        opp = d.scan_market(m, s, available_capital=19.0, now_ms=NOW)
        assert opp is not None
        # Gas is reserved out of capital before sizing: (19 - 0.02) / 0.95.
        assert opp.size == pytest.approx(18.98 / 0.95)
        assert opp.legs[0].size * (0.40 + 0.55) + 0.02 <= 19.0 + 1e-9

    def test_per_market_exposure_cap(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 500)], [(0.40, 500)], [(0.53, 500)], [(0.55, 500)])
        opp = d.scan_market(
            m, s, available_capital=1000.0, exposure_in_market=45.0, now_ms=NOW
        )
        assert opp is not None
        assert opp.size == pytest.approx(5.0)  # 50 cap - 45 already on

    def test_full_market_cap_blocks_trade(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 500)], [(0.40, 500)], [(0.53, 500)], [(0.55, 500)])
        assert d.scan_market(
            m, s, available_capital=1000.0, exposure_in_market=50.0, now_ms=NOW
        ) is None

    def test_min_edge_threshold_is_enforced(self):
        st = Settings()
        st.risk.min_edge_bps = 600  # demand 6c, book only offers 5c
        m = make_market()
        d = Detector(st, {m.condition_id: m})
        s = store_with([(0.38, 100)], [(0.40, 100)], [(0.53, 100)], [(0.55, 100)])
        assert d.scan_market(m, s, available_capital=1000.0, now_ms=NOW) is None


class TestScanAll:
    def test_ranks_by_total_profit(self, settings):
        small = make_market(condition_id="0xa", slug="small",
                            yes_token_id="AY", no_token_id="AN")
        big = make_market(condition_id="0xb", slug="big",
                          yes_token_id="BY", no_token_id="BN")
        d = Detector(settings, {small.condition_id: small, big.condition_id: big})

        s = BookStore()
        s.handle(book_msg("AY", [(0.38, 10)], [(0.40, 10)]))
        s.handle(book_msg("AN", [(0.53, 10)], [(0.55, 10)]))
        s.handle(book_msg("BY", [(0.38, 200)], [(0.40, 200)]))
        s.handle(book_msg("BN", [(0.53, 200)], [(0.55, 200)]))

        opps = d.scan_all(s, available_capital=1000.0, now_ms=NOW)
        assert [o.market.slug for o in opps] == ["big", "small"]
        assert opps[0].total_profit > opps[1].total_profit

    def test_skips_closed_markets(self, settings):
        m = make_market(closed=True)
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.38, 100)], [(0.40, 100)], [(0.53, 100)], [(0.55, 100)])
        assert d.scan_all(s, available_capital=1000.0, now_ms=NOW) == []

    def test_token_index_maps_back_to_market(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        assert d.market_for_token("YES") is m
        assert d.market_for_token("NO") is m
        assert d.market_for_token("other") is None


class TestStats:
    def test_stats_explain_rejections(self, settings):
        m = make_market()
        d = Detector(settings, {m.condition_id: m})
        s = store_with([(0.39, 100)], [(0.40, 100)], [(0.59, 100)], [(0.60, 100)])
        d.scan_market(m, s, available_capital=1000.0, now_ms=NOW)
        stats = d.stats.as_dict()
        assert stats["scans"] == 1
        assert stats["emitted"] == 0
        # Both directions screened out at top of book.
        assert stats["screened_out_no_gross_edge"] == 2

    def test_no_edge_seen_reports_none(self, settings):
        d = Detector(settings, {})
        assert d.stats.as_dict()["best_edge_bps_seen"] is None
