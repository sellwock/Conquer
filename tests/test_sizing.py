"""Depth-aware sizing.

Expected values are hand-computed in comments. The most important test in this file
is `TestLimitPriceSafety` — it asserts the property the live executor relies on.
"""

import random

import pytest

from polyarb.models import Direction, Level
from polyarb.sizing import size_trade, worst_case_edge


def lv(*pairs):
    return [Level(p, s) for p, s in pairs]


def converge(yes, no, **kw):
    kw.setdefault("fee_rate", 0.0)
    kw.setdefault("tick_size", 0.01)
    return size_trade(Direction.CONVERGE, yes, no, **kw)


def diverge(yes, no, **kw):
    kw.setdefault("fee_rate", 0.0)
    kw.setdefault("tick_size", 0.01)
    return size_trade(Direction.DIVERGE, yes, no, **kw)


class TestConverge:
    def test_single_level(self):
        # 1 - 0.40 - 0.55 = 0.05 edge, 100 deep on both sides
        t = converge(lv((0.40, 100)), lv((0.55, 100)))
        assert t is not None
        assert t.size == pytest.approx(100)
        assert t.edge_per_pair == pytest.approx(0.05)
        assert t.total_profit == pytest.approx(5.0)
        assert t.capital_required == pytest.approx(95.0)  # 40 + 55
        assert t.yes_vwap == pytest.approx(0.40)
        assert t.no_vwap == pytest.approx(0.55)

    def test_limited_by_thinner_side(self):
        t = converge(lv((0.40, 10)), lv((0.55, 500)))
        assert t.size == pytest.approx(10)

    def test_stops_when_marginal_edge_turns_negative(self):
        # Level 2 of the YES book is 0.48: 1 - 0.48 - 0.55 = -0.03, so the sweep
        # must stop after the first 10 shares rather than chasing size.
        t = converge(lv((0.40, 10), (0.48, 100)), lv((0.55, 50)))
        assert t.size == pytest.approx(10)
        assert t.total_profit == pytest.approx(0.5)
        assert t.levels_consumed == 1

    def test_keeps_consuming_while_marginal_positive(self):
        # slice 1: 10 @ (0.40, 0.55) -> marginal 0.05
        # slice 2: 10 @ (0.42, 0.55) -> marginal 0.03, still worth taking
        # notional: yes 4.0 + 4.2 = 8.2, no 20*0.55 = 11.0
        # gross edge = (20 - 8.2 - 11.0) / 20 = 0.04
        t = converge(lv((0.40, 10), (0.42, 10)), lv((0.55, 25)))
        assert t.size == pytest.approx(20)
        assert t.gross_edge_per_pair == pytest.approx(0.04)
        assert t.total_profit == pytest.approx(0.8)
        assert t.levels_consumed == 2

    def test_bigger_size_beats_better_price(self):
        # Taking only the first slice would earn 0.05*10 = 0.5. Taking both earns
        # 0.8 at a worse average. Total profit is the objective, not per-share edge.
        deep = converge(lv((0.40, 10), (0.42, 10)), lv((0.55, 25)))
        shallow = converge(lv((0.40, 10)), lv((0.55, 25)))
        assert deep.total_profit > shallow.total_profit
        assert deep.edge_per_pair < shallow.edge_per_pair

    def test_no_edge_returns_none(self):
        assert converge(lv((0.50, 100)), lv((0.50, 100))) is None
        assert converge(lv((0.60, 100)), lv((0.55, 100))) is None

    def test_empty_books(self):
        assert converge([], lv((0.55, 10))) is None
        assert converge(lv((0.40, 10)), []) is None


class TestFees:
    def test_fees_reduce_edge(self):
        # rate 0.05: fee = 0.05*0.40*0.60 + 0.05*0.55*0.45
        #                = 0.012 + 0.012375 = 0.024375
        # edge = 0.05 - 0.024375 = 0.025625
        t = converge(lv((0.40, 100)), lv((0.55, 100)), fee_rate=0.05)
        assert t.fee_per_pair == pytest.approx(0.024375)
        assert t.edge_per_pair == pytest.approx(0.025625)

    def test_fees_can_eliminate_the_trade(self):
        # A 1c gap at mid prices does not survive a 0.05 fee rate.
        assert converge(lv((0.49, 100)), lv((0.50, 100)), fee_rate=0.05) is None
        # The same gap does survive with no fee.
        assert converge(lv((0.49, 100)), lv((0.50, 100)), fee_rate=0.0) is not None

    def test_tail_prices_survive_where_mid_prices_do_not(self):
        # Identical 1c gross gap, but out at the tail the fee curve collapses.
        assert converge(lv((0.94, 100)), lv((0.05, 100)), fee_rate=0.05) is not None


class TestGas:
    def test_gas_kills_tiny_trades(self):
        # 1 share at 5c edge cannot cover 10c of gas.
        assert converge(lv((0.40, 1)), lv((0.55, 1)), gas_cost=0.10) is None
        # The same prices at size 100 amortise it away.
        t = converge(lv((0.40, 100)), lv((0.55, 100)), gas_cost=0.10)
        assert t is not None
        assert t.edge_per_pair == pytest.approx(0.05 - 0.001)

    def test_gas_is_charged_once_not_per_share(self):
        t = converge(lv((0.40, 100)), lv((0.55, 100)), gas_cost=0.02)
        assert t.total_profit == pytest.approx(5.0 - 0.02)


class TestConstraints:
    def test_max_size(self):
        t = converge(lv((0.40, 100)), lv((0.55, 100)), max_size=25)
        assert t.size == pytest.approx(25)

    def test_max_capital_for_converge(self):
        # Each pair costs 0.95, so $50 buys 52.63 pairs.
        t = converge(lv((0.40, 100)), lv((0.55, 100)), max_capital=50.0)
        assert t.capital_required <= 50.0 + 1e-9
        assert t.size == pytest.approx(50.0 / 0.95, rel=1e-6)

    def test_max_capital_for_diverge_uses_mint_cost(self):
        # Diverge must mint pairs at $1 each before selling, so capital caps size 1:1.
        t = diverge(lv((0.60, 500)), lv((0.45, 500)), max_capital=40.0)
        assert t.size == pytest.approx(40.0)
        assert t.capital_required <= 40.0 + 1e-9

    def test_min_order_size_rejects_dust(self):
        assert converge(lv((0.40, 2)), lv((0.55, 2)), min_order_size=5.0) is None
        assert converge(lv((0.40, 20)), lv((0.55, 20)), min_order_size=5.0) is not None

    def test_min_edge_threshold(self):
        assert converge(lv((0.40, 100)), lv((0.55, 100)), min_edge_per_pair=0.06) is None
        assert converge(lv((0.40, 100)), lv((0.55, 100)), min_edge_per_pair=0.04) is not None

    def test_zero_capital(self):
        assert converge(lv((0.40, 100)), lv((0.55, 100)), max_capital=0.0) is None


class TestDiverge:
    def test_basic(self):
        # 0.60 + 0.45 - 1 = 0.05
        t = diverge(lv((0.60, 100)), lv((0.45, 100)))
        assert t.size == pytest.approx(100)
        assert t.edge_per_pair == pytest.approx(0.05)
        assert t.capital_required == pytest.approx(100.0)  # $1 per pair to split

    def test_stops_when_bids_thin_out(self):
        # Second YES bid at 0.52: 0.52 + 0.45 - 1 = -0.03, stop.
        t = diverge(lv((0.60, 10), (0.52, 100)), lv((0.45, 200)))
        assert t.size == pytest.approx(10)

    def test_no_edge(self):
        assert diverge(lv((0.50, 100)), lv((0.50, 100))) is None


class TestLimitPriceSafety:
    """The guarantee the executor depends on.

    Limits are set at the deepest price consumed, and we only ever consume prices
    with positive marginal edge. So a fill-or-kill at those limits cannot fill at a
    loss even if the book moves — it just won't fill.
    """

    def test_limits_are_the_deepest_prices_consumed(self):
        t = converge(lv((0.40, 10), (0.42, 10)), lv((0.55, 25)))
        assert t.yes_limit == pytest.approx(0.42)
        assert t.no_limit == pytest.approx(0.55)

    def test_worst_case_edge_positive_converge(self):
        t = converge(lv((0.40, 10), (0.42, 10)), lv((0.55, 25)), fee_rate=0.04)
        assert worst_case_edge(t, 0.04) > 0

    def test_worst_case_edge_positive_diverge(self):
        t = diverge(lv((0.60, 10), (0.58, 10)), lv((0.45, 25)), fee_rate=0.04)
        assert worst_case_edge(t, 0.04) > 0

    @pytest.mark.parametrize("seed", range(60))
    def test_property_holds_on_random_books(self, seed):
        rng = random.Random(seed)
        rate = rng.choice([0.0, 0.04, 0.05, 0.07])

        def book(start, step_sign):
            levels, p = [], start
            for _ in range(rng.randint(1, 6)):
                levels.append(Level(round(p, 2), rng.uniform(1, 200)))
                p += step_sign * rng.choice([0.01, 0.02, 0.05])
                if not 0.01 < p < 0.99:
                    break
            return levels

        for direction in (Direction.CONVERGE, Direction.DIVERGE):
            buying = direction is Direction.CONVERGE
            sign = 1 if buying else -1
            yes = book(rng.uniform(0.05, 0.9), sign)
            no = book(rng.uniform(0.05, 0.9), sign)

            t = size_trade(
                direction, yes, no,
                fee_rate=rate, tick_size=0.01,
                gas_cost=rng.choice([0.0, 0.02]),
            )
            if t is None:
                continue
            # Ex-gas, filling entirely at the limits must still be profitable.
            assert worst_case_edge(t, rate) > 0, (direction, yes, no, rate)
            assert t.total_profit > 0
            assert t.size > 0

    def test_limits_land_on_the_tick_grid(self):
        for tick in (0.1, 0.01, 0.001):
            t = converge(lv((0.40, 100)), lv((0.55, 100)), tick_size=tick)
            if t is None:
                continue
            for limit in (t.yes_limit, t.no_limit):
                assert limit / tick == pytest.approx(round(limit / tick), abs=1e-6)
