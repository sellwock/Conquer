"""Tests for the fee curve and edge arithmetic.

Expected values here are computed by hand in the comments. If one of these fails,
do not adjust the expectation to match the code — the code is what is wrong.
"""

import math

import pytest

from polyarb.fees import (
    amortised_gas,
    available_depth,
    breakeven_spread,
    converge_edge_per_pair,
    diverge_edge_per_pair,
    round_to_tick,
    taker_fee_per_share,
    walk_book,
)
from polyarb.models import Level


class TestTakerFee:
    def test_zero_rate_is_free(self):
        assert taker_fee_per_share(0.5, 0.0) == 0.0
        assert taker_fee_per_share(0.99, 0.0) == 0.0

    def test_hand_computed(self):
        # 0.05 * 0.5 * 0.5 = 0.0125
        assert taker_fee_per_share(0.5, 0.05) == pytest.approx(0.0125)
        # 0.07 * 0.5 * 0.5 = 0.0175  -> $1.75 per 100 shares, the documented peak
        assert taker_fee_per_share(0.5, 0.07) == pytest.approx(0.0175)
        # 0.05 * 0.95 * 0.05 = 0.002375
        assert taker_fee_per_share(0.95, 0.05) == pytest.approx(0.002375)

    def test_peaks_at_half(self):
        rate = 0.05
        peak = taker_fee_per_share(0.5, rate)
        for p in (0.01, 0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 0.99):
            assert taker_fee_per_share(p, rate) < peak

    def test_symmetric_about_half(self):
        # p(1-p) is symmetric, so a leg and its complement always cost the same.
        for p in (0.05, 0.2, 0.37, 0.5):
            assert taker_fee_per_share(p, 0.05) == pytest.approx(
                taker_fee_per_share(1.0 - p, 0.05)
            )

    def test_vanishes_at_bounds(self):
        assert taker_fee_per_share(0.0, 0.07) == 0.0
        assert taker_fee_per_share(1.0, 0.07) == 0.0

    def test_extremity_is_much_cheaper(self):
        # The core strategic claim: trading at 95/5 costs ~5x less than at 50/50.
        ratio = taker_fee_per_share(0.5, 0.05) / taker_fee_per_share(0.95, 0.05)
        assert ratio == pytest.approx(5.263, abs=0.01)


class TestNoFreeMoney:
    """The single most important property. If this breaks, the bot invents profit."""

    @pytest.mark.parametrize("rate", [0.01, 0.04, 0.05, 0.07])
    @pytest.mark.parametrize("a", [0.01, 0.05, 0.2, 0.35, 0.5, 0.64, 0.8, 0.99])
    def test_converge_at_parity_is_strictly_negative(self, a, rate):
        # Complement prices summing to exactly $1 offer zero gross edge, so after
        # paying any positive fee the trade must lose money.
        edge = converge_edge_per_pair(a, 1.0 - a, rate)
        assert edge < 0.0

    @pytest.mark.parametrize("rate", [0.01, 0.04, 0.05, 0.07])
    @pytest.mark.parametrize("a", [0.01, 0.05, 0.2, 0.35, 0.5, 0.64, 0.8, 0.99])
    def test_diverge_at_parity_is_strictly_negative(self, a, rate):
        edge = diverge_edge_per_pair(a, 1.0 - a, rate)
        assert edge < 0.0

    def test_zero_fee_parity_is_exactly_flat(self):
        # With no fee, parity is break-even rather than a loss.
        assert converge_edge_per_pair(0.4, 0.6, 0.0) == pytest.approx(0.0)
        assert diverge_edge_per_pair(0.4, 0.6, 0.0) == pytest.approx(0.0)


class TestConvergeEdge:
    def test_zero_fee_keeps_full_spread(self):
        # 1 - 0.49 - 0.50 = 0.01
        assert converge_edge_per_pair(0.49, 0.50, 0.0) == pytest.approx(0.01)

    def test_fees_can_invert_an_apparent_edge(self):
        # A 1c gap at mid prices looks like free money and is not:
        #   gross = 1 - 0.49 - 0.50           = 0.01
        #   fee   = 0.05*0.49*0.51 = 0.012495
        #         + 0.05*0.50*0.50 = 0.0125
        #   net   = 0.01 - 0.024995           = -0.014995
        edge = converge_edge_per_pair(0.49, 0.50, 0.05)
        assert edge == pytest.approx(-0.014995)
        assert edge < 0

    def test_same_gap_survives_at_the_extremes(self):
        # The identical 1c gap, moved out to the tail, is profitable:
        #   gross = 1 - 0.94 - 0.05           = 0.01
        #   fee   = 0.05*0.94*0.06 = 0.00282
        #         + 0.05*0.05*0.95 = 0.002375
        #   net   = 0.01 - 0.005195           = 0.004805
        edge = converge_edge_per_pair(0.94, 0.05, 0.05)
        assert edge == pytest.approx(0.004805)
        assert edge > 0

    def test_zero_fee_category_beats_both(self):
        assert converge_edge_per_pair(0.49, 0.50, 0.0) > converge_edge_per_pair(
            0.94, 0.05, 0.05
        )


class TestDivergeEdge:
    def test_zero_fee(self):
        # 0.52 + 0.49 - 1 = 0.01
        assert diverge_edge_per_pair(0.52, 0.49, 0.0) == pytest.approx(0.01)

    def test_with_fees(self):
        #   gross = 0.01
        #   fee   = 0.04*0.52*0.48 = 0.0099840
        #         + 0.04*0.49*0.51 = 0.0099960
        #   net   = 0.01 - 0.01998 = -0.00998
        assert diverge_edge_per_pair(0.52, 0.49, 0.04) == pytest.approx(-0.00998)


class TestBreakevenSpread:
    def test_mid_market_needs_wide_gap(self):
        # 2 * 0.05 * 0.25 = 0.025 -> a 50/50 sports pair needs 2.5c to clear fees.
        assert breakeven_spread(0.5, 0.05) == pytest.approx(0.025)

    def test_tail_needs_far_less(self):
        # 0.05*0.95*0.05 * 2 = 0.00475 -> under half a cent at 95/5.
        assert breakeven_spread(0.95, 0.05) == pytest.approx(0.00475)

    def test_free_category_needs_nothing(self):
        assert breakeven_spread(0.5, 0.0) == 0.0


class TestRoundToTick:
    def test_rounds_in_requested_direction(self):
        assert round_to_tick(0.5234, 0.01, up=True) == pytest.approx(0.53)
        assert round_to_tick(0.5234, 0.01, up=False) == pytest.approx(0.52)

    def test_price_already_on_grid_is_unchanged(self):
        # Float noise must not push an on-grid price a whole tick away.
        for p, tick in [(0.52, 0.01), (0.7, 0.1), (0.123, 0.001), (0.9999, 0.0001)]:
            assert round_to_tick(p, tick, up=True) == pytest.approx(p)
            assert round_to_tick(p, tick, up=False) == pytest.approx(p)

    def test_clamped_inside_tradable_band(self):
        assert round_to_tick(1.5, 0.01, up=True) == pytest.approx(0.99)
        assert round_to_tick(0.0, 0.01, up=False) == pytest.approx(0.01)
        assert round_to_tick(-1.0, 0.01, up=False) == pytest.approx(0.01)

    def test_all_documented_tick_tiers(self):
        for tick in (0.1, 0.01, 0.001, 0.0001):
            snapped = round_to_tick(0.4567, tick, up=False)
            # Result must sit exactly on the grid.
            assert math.isclose(snapped / tick, round(snapped / tick), abs_tol=1e-6)

    def test_rejects_bad_tick(self):
        with pytest.raises(ValueError):
            round_to_tick(0.5, 0.0, up=True)


class TestWalkBook:
    def test_single_level(self):
        levels = [Level(0.40, 100.0)]
        r = walk_book(levels, 50.0, rate=0.0)
        assert r.filled == 50.0
        assert r.notional == pytest.approx(20.0)
        assert r.vwap == pytest.approx(0.40)
        assert r.worst_price == pytest.approx(0.40)
        assert r.levels_used == 1

    def test_sweeps_multiple_levels(self):
        levels = [Level(0.40, 10.0), Level(0.41, 10.0), Level(0.42, 10.0)]
        r = walk_book(levels, 25.0, rate=0.0)
        # 10*0.40 + 10*0.41 + 5*0.42 = 4.0 + 4.1 + 2.1 = 10.2
        assert r.filled == 25.0
        assert r.notional == pytest.approx(10.2)
        assert r.vwap == pytest.approx(0.408)
        assert r.worst_price == pytest.approx(0.42)
        assert r.levels_used == 3

    def test_partial_fill_when_book_too_thin(self):
        levels = [Level(0.40, 5.0), Level(0.41, 3.0)]
        r = walk_book(levels, 100.0, rate=0.0)
        assert r.filled == 8.0
        assert r.notional == pytest.approx(5 * 0.40 + 3 * 0.41)

    def test_fee_accumulates_per_level_not_on_vwap(self):
        # A convex book makes the per-level fee differ from the VWAP-based figure.
        # Using the VWAP shortcut would understate cost and manufacture fake edge.
        levels = [Level(0.10, 10.0), Level(0.50, 10.0)]
        rate = 0.05
        r = walk_book(levels, 20.0, rate=rate)
        per_level = 10 * taker_fee_per_share(0.10, rate) + 10 * taker_fee_per_share(0.50, rate)
        # 10*0.0045 + 10*0.0125 = 0.045 + 0.125 = 0.17
        assert r.fee == pytest.approx(0.17)
        assert r.fee == pytest.approx(per_level)

        vwap_shortcut = 20 * taker_fee_per_share(r.vwap, rate)  # 20 * 0.05*0.3*0.7 = 0.21
        assert vwap_shortcut == pytest.approx(0.21)
        assert r.fee < vwap_shortcut  # the shortcut is wrong, and wrong in both directions

    def test_zero_and_negative_size(self):
        levels = [Level(0.40, 10.0)]
        assert walk_book(levels, 0.0, 0.05).filled == 0.0
        assert walk_book(levels, -5.0, 0.05).filled == 0.0

    def test_skips_empty_levels(self):
        levels = [Level(0.40, 0.0), Level(0.41, 10.0)]
        r = walk_book(levels, 5.0, rate=0.0)
        assert r.notional == pytest.approx(5 * 0.41)
        assert r.levels_used == 1

    def test_empty_book(self):
        r = walk_book([], 10.0, 0.05)
        assert r.filled == 0.0
        assert r.vwap == 0.0


class TestHelpers:
    def test_available_depth(self):
        assert available_depth([Level(0.4, 10.0), Level(0.41, 5.0)]) == 15.0
        assert available_depth([]) == 0.0

    def test_amortised_gas_shrinks_with_size(self):
        assert amortised_gas(0.02, 1.0) == pytest.approx(0.02)
        assert amortised_gas(0.02, 100.0) == pytest.approx(0.0002)
        assert amortised_gas(0.02, 0.0) == float("inf")

    def test_gas_can_dominate_a_small_trade(self):
        # 2 shares at a 0.5c edge do not cover 2c of gas.
        edge = 0.005
        assert edge - amortised_gas(0.02, 2.0) < 0
        assert edge - amortised_gas(0.02, 200.0) > 0
