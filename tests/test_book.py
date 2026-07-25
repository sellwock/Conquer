"""Order book reconstruction and desync detection.

The tests that matter most here are the desync ones. A stale book makes two
complementary outcomes look like they sum to well under $1.00, which is exactly the
signature of a large arbitrage — so a book that fails silently doesn't produce no
trades, it produces confident, wrong, expensive ones.
"""

import pytest

from polyarb.book import BookStore, OrderBook


def snapshot(token="tok", bids=None, asks=None, ts=1_700_000_000_000, hash_="h1"):
    return {
        "event_type": "book",
        "asset_id": token,
        "bids": [{"price": str(p), "size": str(s)} for p, s in (bids or [])],
        "asks": [{"price": str(p), "size": str(s)} for p, s in (asks or [])],
        "timestamp": str(ts),
        "hash": hash_,
    }


def price_change(token="tok", changes=(), ts=1_700_000_000_100):
    return {
        "event_type": "price_change",
        "asset_id": token,
        "changes": [{"price": str(p), "side": side, "size": str(s)} for p, side, s in changes],
        "timestamp": str(ts),
    }


class TestSnapshot:
    def test_applies_and_sorts(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10), (0.42, 5), (0.41, 7)],
                                  asks=[(0.46, 3), (0.44, 8), (0.45, 6)]))
        assert b.valid
        assert b.best_bid().price == pytest.approx(0.42)
        assert b.best_ask().price == pytest.approx(0.44)
        assert [l.price for l in b.bid_levels()] == pytest.approx([0.42, 0.41, 0.40])
        assert [l.price for l in b.ask_levels()] == pytest.approx([0.44, 0.45, 0.46])

    def test_replaces_rather_than_merges(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_snapshot(snapshot(bids=[(0.30, 5)], asks=[(0.70, 5)]))
        assert [l.price for l in b.bid_levels()] == pytest.approx([0.30])
        assert b.best_bid().size == 5

    def test_drops_zero_size_levels(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 0), (0.39, 5)], asks=[(0.60, 10)]))
        assert [l.price for l in b.bid_levels()] == pytest.approx([0.39])

    def test_clears_prior_desync(self):
        b = OrderBook("tok")
        b._mark_desync("test")
        assert not b.valid
        b.apply_snapshot(snapshot(bids=[(0.4, 1)], asks=[(0.6, 1)]))
        assert b.valid and not b.resync_requested and b.desync_reason == ""


class TestDeltas:
    def test_updates_and_adds_levels(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.40, "BUY", 25), (0.41, "BUY", 5)]))
        assert b.valid
        assert b.best_bid().price == pytest.approx(0.41)
        assert dict((l.price, l.size) for l in b.bid_levels())[0.40] == 25

    def test_zero_size_removes_known_level(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10), (0.39, 5)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.40, "BUY", 0)]))
        assert b.valid
        assert [l.price for l in b.bid_levels()] == pytest.approx([0.39])

    def test_accepts_flat_single_change_shape(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(
            {"event_type": "price_change", "asset_id": "tok",
             "price": "0.41", "side": "BUY", "size": "3", "timestamp": "1700000000200"}
        )
        assert b.best_bid().price == pytest.approx(0.41)

    def test_side_aliases(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.61, "ASK", 4)]))
        assert any(l.price == pytest.approx(0.61) for l in b.ask_levels())


class TestDesyncDetection:
    def test_crossed_book_is_rejected(self):
        # This is the money case: a crossed book would read as free profit.
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.65, "BUY", 5)]))
        assert not b.valid
        assert b.resync_requested
        assert "crossed" in b.desync_reason

    def test_touching_prices_are_also_crossed(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.60, "BUY", 5)]))
        assert not b.valid

    def test_crossed_snapshot_is_rejected_too(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.70, 10)], asks=[(0.60, 10)]))
        assert not b.valid

    def test_removing_unknown_level_is_desync(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.35, "BUY", 0)]))
        assert not b.valid
        assert "unknown level" in b.desync_reason

    def test_negative_size_is_desync(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.40, "BUY", -1)]))
        assert not b.valid
        assert "negative size" in b.desync_reason

    def test_unknown_side_is_desync(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        b.apply_price_change(price_change(changes=[(0.40, "SIDEWAYS", 5)]))
        assert not b.valid

    def test_delta_before_snapshot_requests_resync(self):
        b = OrderBook("tok")
        b.apply_price_change(price_change(changes=[(0.40, "BUY", 10)]))
        assert not b.valid
        assert b.resync_requested

    def test_hash_verifier_hook_can_invalidate(self):
        b = OrderBook("tok")
        b.hash_verifier = lambda book, h: False
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)]))
        assert not b.valid
        assert "hash mismatch" in b.desync_reason

    def test_no_verifier_means_no_hash_check(self):
        # We must not invent a hash algorithm; absent a verifier, hashes are stored
        # but never used to invalidate.
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.60, 10)], hash_="whatever"))
        assert b.valid
        assert b.reported_hash == "whatever"


class TestFreshness:
    def test_age_from_server_timestamp(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(ts=1_700_000_000_000, bids=[(0.4, 1)], asks=[(0.6, 1)]))
        assert b.age_ms(now_ms=1_700_000_000_500) == pytest.approx(500)

    def test_seconds_timestamps_are_normalised(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(ts=1_700_000_000, bids=[(0.4, 1)], asks=[(0.6, 1)]))
        assert b.last_update_ms == pytest.approx(1_700_000_000_000)

    def test_missing_timestamp_falls_back_to_local_clock(self):
        b = OrderBook("tok")
        msg = snapshot(bids=[(0.4, 1)], asks=[(0.6, 1)])
        del msg["timestamp"]
        b.apply_snapshot(msg)
        assert b.age_ms() < 1000

    def test_untouched_book_is_infinitely_old(self):
        assert OrderBook("tok").age_ms() == float("inf")

    def test_is_tradable_requires_fresh_valid_two_sided(self):
        b = OrderBook("tok")
        now = 1_700_000_000_000
        b.apply_snapshot(snapshot(ts=now, bids=[(0.4, 1)], asks=[(0.6, 1)]))
        assert b.is_tradable(1000, now_ms=now + 100)
        assert not b.is_tradable(1000, now_ms=now + 5000)  # stale

        one_sided = OrderBook("tok2")
        one_sided.apply_snapshot(snapshot(token="tok2", ts=now, bids=[(0.4, 1)], asks=[]))
        assert not one_sided.is_tradable(1000, now_ms=now)


class TestConsume:
    """Market-impact model used by the paper engine."""

    def test_consumes_asks_best_first(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.50, 10), (0.51, 10)]))
        taken = b.consume("asks", 15, limit=0.51)
        assert taken == pytest.approx(15)
        # 0.50 fully gone, 0.51 partially depleted.
        assert [(l.price, l.size) for l in b.ask_levels()] == [(pytest.approx(0.51), 5)]

    def test_consumes_bids_best_first(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10), (0.39, 10)], asks=[(0.60, 10)]))
        b.consume("bids", 12, limit=0.39)
        assert [(l.price, l.size) for l in b.bid_levels()] == [(pytest.approx(0.39), 8)]

    def test_respects_the_limit_price(self):
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.50, 10), (0.60, 10)]))
        taken = b.consume("asks", 20, limit=0.50)
        assert taken == pytest.approx(10)  # cannot reach the 0.60 level
        assert [l.price for l in b.ask_levels()] == pytest.approx([0.60])

    def test_repeated_consumption_exhausts_the_level(self):
        # This is what stops a persistent gap being traded forever in paper mode.
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.50, 100)]))
        for _ in range(4):
            b.consume("asks", 25, limit=0.50)
        assert b.best_ask() is None

    def test_snapshot_overwrites_local_depletion(self):
        # The venue is always the authority.
        b = OrderBook("tok")
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.50, 100)]))
        b.consume("asks", 100, limit=0.50)
        assert b.best_ask() is None
        b.apply_snapshot(snapshot(bids=[(0.40, 10)], asks=[(0.50, 100)]))
        assert b.best_ask().size == 100


class TestTickSize:
    def test_tick_change_is_applied(self):
        b = OrderBook("tok", tick_size=0.01)
        b.apply_tick_size_change({"event_type": "tick_size_change", "new_tick_size": "0.001"})
        assert b.tick_size == pytest.approx(0.001)


class TestBookStore:
    def test_routes_by_asset_id(self):
        s = BookStore()
        s.handle(snapshot(token="a", bids=[(0.4, 1)], asks=[(0.6, 1)]))
        s.handle(snapshot(token="b", bids=[(0.3, 1)], asks=[(0.7, 1)]))
        assert len(s) == 2
        assert s.get("a").best_bid().price == pytest.approx(0.4)
        assert s.get("b").best_bid().price == pytest.approx(0.3)

    def test_ignores_frames_without_asset(self):
        s = BookStore()
        assert s.handle({"event_type": "book"}) is None
        assert len(s) == 0

    def test_unknown_events_do_not_corrupt_state(self):
        s = BookStore()
        s.handle(snapshot(token="a", bids=[(0.4, 1)], asks=[(0.6, 1)]))
        s.handle({"event_type": "last_trade_price", "asset_id": "a", "price": "0.5"})
        assert s.get("a").valid
        assert s.get("a").best_bid().price == pytest.approx(0.4)

    def test_tracks_books_needing_resync(self):
        s = BookStore()
        s.handle(snapshot(token="a", bids=[(0.4, 1)], asks=[(0.6, 1)]))
        s.handle(snapshot(token="b", bids=[(0.7, 1)], asks=[(0.6, 1)]))  # crossed
        assert s.needing_resync() == ["b"]

    def test_applies_configured_tick_sizes(self):
        s = BookStore(tick_sizes={"a": 0.001})
        assert s.get("a").tick_size == pytest.approx(0.001)
        assert s.get("unknown").tick_size == pytest.approx(0.01)
