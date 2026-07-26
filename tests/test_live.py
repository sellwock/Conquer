"""Live execution engine, driven by a fake gateway.

The real gateway cannot be exercised offline, which is exactly why the trading logic
lives outside it. Everything that decides what happens to money is tested here.
"""

import pytest

from polyarb.config import Settings
from polyarb.execution.gateway import OrderAck, OrderRequest, parse_ack
from polyarb.execution.live import LiveEngine
from polyarb.models import Direction, Leg, Market, Opportunity, Outcome, Side
from polyarb.risk import RiskManager


class FakeGateway:
    """Scripted acks, in submission order."""

    def __init__(self, acks, batch_acks=None):
        self.acks = list(acks)
        self.batch_acks = batch_acks
        self.submitted: list[OrderRequest] = []
        self.batches: list[list[OrderRequest]] = []
        self.cancelled = False

    def submit_batch(self, orders):
        self.batches.append(list(orders))
        self.submitted.extend(orders)
        if self.batch_acks is not None:
            return self.batch_acks
        return [self.acks.pop(0) for _ in orders]

    def submit(self, order):
        self.submitted.append(order)
        return self.acks.pop(0)

    def cancel_all(self):
        self.cancelled = True

    def heartbeat(self):
        pass


def market(category="geopolitics"):
    return Market(
        condition_id="0xcond", question="Q", slug="q",
        yes_token_id="YES", no_token_id="NO",
        category=category, tick_size=0.01, min_order_size=5.0,
    )


def opportunity(size=50.0, direction=Direction.CONVERGE, yes_price=0.40, no_price=0.55):
    m = market()
    side = Side.BUY if direction is Direction.CONVERGE else Side.SELL
    legs = (
        Leg("YES", Outcome.YES, side, yes_price, size, yes_price, 0.0),
        Leg("NO", Outcome.NO, side, no_price, size, no_price, 0.0),
    )
    gross = (1 - yes_price - no_price) if direction is Direction.CONVERGE else (yes_price + no_price - 1)
    return Opportunity(
        market=m, direction=direction, legs=legs, size=size,
        edge_per_pair=gross, gross_edge_per_pair=gross, fee_per_pair=0.0,
        gas_cost=0.02, total_profit=gross * size, book_age_ms=50.0,
    )


def filled(size, price, fee=-1.0):
    return OrderAck(ok=True, order_id="0x1", filled_size=size,
                    notional=size * price, fee_paid=fee, status="matched")


def killed(reason="not filled (killed)"):
    return OrderAck(ok=False, status="killed", error=reason)


def engine(acks, settings=None, batch_acks=None):
    s = settings or Settings()
    risk = RiskManager(s, starting_capital=1000.0)
    gw = FakeGateway(acks, batch_acks=batch_acks)
    return LiveEngine(gw, s, risk), gw, risk


class TestBothLegsFill:
    def test_realises_expected_profit(self):
        eng, gw, _ = engine([filled(50, 0.40), filled(50, 0.55)])
        result = eng.execute(opportunity())
        assert result.ok
        assert not result.one_legged
        # 50 pairs merged for $50, cost $20 + $27.50, less $0.02 gas.
        assert result.realised_pnl == pytest.approx(50 - 20 - 27.5 - 0.02)

    def test_sends_both_legs_as_fok(self):
        eng, gw, _ = engine([filled(50, 0.40), filled(50, 0.55)])
        eng.execute(opportunity())
        assert len(gw.submitted) == 2
        assert all(o.order_type == "FOK" for o in gw.submitted)
        assert [o.side for o in gw.submitted] == [Side.BUY, Side.BUY]

    def test_uses_one_batch_request_by_default(self):
        eng, gw, _ = engine([filled(50, 0.40), filled(50, 0.55)])
        eng.execute(opportunity())
        assert len(gw.batches) == 1
        assert len(gw.batches[0]) == 2

    def test_diverge_sells_both_legs(self):
        eng, gw, _ = engine([filled(50, 0.60), filled(50, 0.45)])
        result = eng.execute(opportunity(direction=Direction.DIVERGE,
                                         yes_price=0.60, no_price=0.45))
        assert all(o.side is Side.SELL for o in gw.submitted)
        assert result.realised_pnl == pytest.approx(30 + 22.5 - 50 - 0.02)


class TestBothLegsKilled:
    def test_no_fill_is_not_an_error(self):
        eng, _, _ = engine([killed(), killed()])
        result = eng.execute(opportunity())
        assert result.realised_pnl == 0.0
        assert not result.one_legged
        assert not result.ok
        assert all(not f.ok for f in result.fills)


class TestOneLegged:
    def test_unwinds_immediately(self):
        # YES fills, NO killed, then the unwind sells YES back at 0.38.
        eng, gw, _ = engine([filled(50, 0.40), killed(), filled(50, 0.38)])
        result = eng.execute(opportunity())

        assert result.one_legged
        assert result.unwound
        assert result.realised_pnl == pytest.approx(19.0 - 20.0)
        # The unwind is a FAK sell of the filled leg.
        unwind = gw.submitted[-1]
        assert unwind.order_type == "FAK"
        assert unwind.side is Side.SELL
        assert unwind.token_id == "YES"

    def test_halts_when_unwind_fails(self):
        eng, _, risk = engine([filled(50, 0.40), killed(), killed("no bid")])
        result = eng.execute(opportunity())
        assert result.one_legged
        assert not result.unwound
        assert risk.state.halted
        assert "manual intervention" in risk.state.halt_reason

    def test_halts_on_partial_unwind(self):
        eng, _, risk = engine([filled(50, 0.40), killed(), filled(30, 0.38)])
        result = eng.execute(opportunity())
        assert result.unwound
        assert "partial unwind" in result.error
        assert risk.state.halted

    def test_holding_when_unwind_disabled(self):
        s = Settings()
        s.execution.unwind_one_legged = False
        eng, gw, _ = engine([filled(50, 0.40), killed()], settings=s)
        result = eng.execute(opportunity())
        assert result.one_legged
        assert not result.unwound
        assert len(gw.submitted) == 2  # no unwind order sent

    def test_unwind_of_a_sell_leg_buys_back(self):
        eng, gw, _ = engine([filled(50, 0.60), killed(), filled(50, 0.62)])
        result = eng.execute(
            opportunity(direction=Direction.DIVERGE, yes_price=0.60, no_price=0.45)
        )
        assert result.unwound
        assert gw.submitted[-1].side is Side.BUY
        # Sold at 0.60, bought back at 0.62.
        assert result.realised_pnl == pytest.approx(30.0 - 31.0)


class TestSequentialFallback:
    def test_aborts_after_the_first_leg_misses(self):
        s = Settings()
        s.execution.batch_legs = False
        eng, gw, _ = engine([killed()], settings=s)
        result = eng.execute(opportunity())
        # Only one order attempted: the miss costs nothing, so stop there.
        assert len(gw.submitted) == 1
        assert not result.one_legged
        assert result.realised_pnl == 0.0


class TestFeeReconciliation:
    def test_matching_fee_does_not_halt(self):
        s = Settings()
        # sports rate 0.05 at price 0.40 -> 0.05*0.4*0.6 = 0.012/share
        m = market("sports")
        eng, _, risk = engine([filled(50, 0.40, fee=0.012 * 50),
                               filled(50, 0.55, fee=0.05 * 0.55 * 0.45 * 50)], settings=s)
        opp = opportunity()
        opp.market = m
        eng.execute(opp)
        assert not risk.state.halted

    def test_wrong_fee_halts_the_bot(self):
        s = Settings()
        m = market("sports")
        # Venue charges 10x the modelled fee: the model is wrong, so stop.
        eng, _, risk = engine([filled(50, 0.40, fee=0.12 * 50), filled(50, 0.55, fee=0.0)],
                              settings=s)
        opp = opportunity()
        opp.market = m
        eng.execute(opp)
        assert risk.state.halted
        assert "fee model divergence" in risk.state.halt_reason

    def test_missing_fee_data_is_not_treated_as_zero(self):
        # fee_paid < 0 means "venue said nothing", which must not trigger a halt
        # nor be booked as a free trade.
        s = Settings()
        m = market("sports")
        eng, _, risk = engine([filled(50, 0.40, fee=-1.0), filled(50, 0.55, fee=-1.0)],
                              settings=s)
        opp = opportunity()
        opp.market = m
        result = eng.execute(opp)
        assert not risk.state.halted
        assert sum(f.fee_paid for f in result.fills) > 0  # modelled fee applied instead


class TestSubmitInterface:
    def test_submit_then_settle(self):
        eng, _, _ = engine([filled(50, 0.40), filled(50, 0.55)])
        eng.submit(opportunity(), now_ms=0.0)
        results = eng.settle_due(0.0)
        assert len(results) == 1
        assert eng.settle_due(0.0) == []


class TestParseAck:
    def test_parses_a_successful_fill(self):
        ack = parse_ack(
            {"success": True, "orderID": "0xabc", "status": "matched",
             "sizeMatched": "50", "avgPrice": "0.41", "feePaid": "0.12"},
            requested_size=50, requested_price=0.42,
        )
        assert ack.ok
        assert ack.filled_size == 50
        assert ack.avg_price == pytest.approx(0.41)
        assert ack.fee_paid == pytest.approx(0.12)

    def test_killed_fok_is_a_clean_no_fill(self):
        ack = parse_ack({"status": "killed", "orderID": "0x1"}, 50, 0.4)
        assert not ack.ok
        assert "not filled" in ack.error

    def test_explicit_error(self):
        ack = parse_ack({"success": False, "error": "INVALID_ORDER_MIN_TICK_SIZE"}, 50, 0.4)
        assert not ack.ok
        assert "TICK_SIZE" in ack.error

    def test_unknown_shape_is_a_failure_not_a_success(self):
        # Never optimistically assume a fill: that would leave the bot believing it
        # holds a hedge it does not have.
        assert not parse_ack(None, 50, 0.4).ok
        assert not parse_ack("weird", 50, 0.4).ok
        assert not parse_ack({}, 50, 0.4).ok

    def test_matched_without_size_assumes_requested_size(self):
        ack = parse_ack({"status": "matched", "orderID": "0x1"}, 50, 0.4)
        assert ack.ok
        assert ack.filled_size == 50

    def test_zero_fill_is_not_ok(self):
        assert not parse_ack({"status": "matched", "sizeMatched": "0"}, 50, 0.4).ok

    def test_missing_fee_is_negative_sentinel(self):
        ack = parse_ack({"status": "matched", "sizeMatched": "50"}, 50, 0.4)
        assert ack.fee_paid < 0  # "no data", distinct from a genuine zero fee
