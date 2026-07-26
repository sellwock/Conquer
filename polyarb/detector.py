"""Opportunity detection across paired complementary books."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .book import BookStore, OrderBook
from .config import Settings
from .fees import converge_edge_per_pair, diverge_edge_per_pair
from .models import Direction, Leg, Market, Opportunity, Outcome, Side
from .sizing import SizedTrade, size_trade


@dataclass
class DetectorStats:
    """Where candidates die. Reading this is how you tell 'no edge exists' apart
    from 'the bot is misconfigured and rejecting everything'."""

    scans: int = 0
    skipped_untradable_book: int = 0
    screened_out_no_gross_edge: int = 0
    sized_out_below_threshold: int = 0
    emitted: int = 0
    best_edge_bps_seen: float = float("-inf")
    per_market_emitted: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, float | int | dict[str, int]]:
        return {
            "scans": self.scans,
            "skipped_untradable_book": self.skipped_untradable_book,
            "screened_out_no_gross_edge": self.screened_out_no_gross_edge,
            "sized_out_below_threshold": self.sized_out_below_threshold,
            "emitted": self.emitted,
            "best_edge_bps_seen": (
                None if self.best_edge_bps_seen == float("-inf") else round(self.best_edge_bps_seen, 2)
            ),
            "per_market_emitted": dict(self.per_market_emitted),
        }


class Detector:
    """Turns book state into priced, sized, risk-bounded opportunities."""

    def __init__(self, settings: Settings, markets: dict[str, Market] | None = None) -> None:
        self.settings = settings
        self.markets: dict[str, Market] = markets or {}
        self.stats = DetectorStats()
        # token id -> market, so a websocket frame can be traced back cheaply.
        self._by_token: dict[str, Market] = {}
        for m in self.markets.values():
            self._index(m)

    def _index(self, market: Market) -> None:
        self._by_token[market.yes_token_id] = market
        self._by_token[market.no_token_id] = market

    def set_markets(self, markets: dict[str, Market]) -> None:
        self.markets = markets
        self._by_token = {}
        for m in markets.values():
            self._index(m)

    def market_for_token(self, token_id: str) -> Market | None:
        return self._by_token.get(token_id)

    # --- detection --------------------------------------------------------
    def scan_market(
        self,
        market: Market,
        store: BookStore,
        *,
        available_capital: float,
        exposure_in_market: float = 0.0,
        now_ms: float | None = None,
    ) -> Opportunity | None:
        """Best opportunity in one market, or None."""
        self.stats.scans += 1
        risk = self.settings.risk
        now_ms = now_ms if now_ms is not None else time.time() * 1000.0

        yes_book = store.get(market.yes_token_id)
        no_book = store.get(market.no_token_id)

        # A stale or desynced book is the classic source of phantom arbitrage.
        if not yes_book.is_tradable(risk.max_book_age_ms, now_ms) or not no_book.is_tradable(
            risk.max_book_age_ms, now_ms
        ):
            self.stats.skipped_untradable_book += 1
            return None

        rate = self.settings.fee_rate_for(market.category)

        # Room left under the per-market cap, and overall.
        market_room = max(0.0, risk.max_position_per_market - exposure_in_market)
        if market_room <= 0 or available_capital <= 0:
            return None

        best: tuple[Direction, SizedTrade] | None = None
        for direction, sized in self._candidates(
            market, yes_book, no_book, rate, market_room, available_capital
        ):
            if best is None or sized.total_profit > best[1].total_profit:
                best = (direction, sized)

        if best is None:
            return None

        direction, sized = best
        self.stats.best_edge_bps_seen = max(self.stats.best_edge_bps_seen, sized.edge_bps)
        self.stats.emitted += 1
        self.stats.per_market_emitted[market.slug] = (
            self.stats.per_market_emitted.get(market.slug, 0) + 1
        )

        age = max(yes_book.age_ms(now_ms), no_book.age_ms(now_ms))
        return self._build_opportunity(market, direction, sized, rate, age)

    def _candidates(
        self,
        market: Market,
        yes_book: OrderBook,
        no_book: OrderBook,
        rate: float,
        market_room: float,
        available_capital: float,
    ):
        """Yield (direction, sized_trade) for whichever directions are live."""
        risk = self.settings.risk
        execu = self.settings.execution
        min_edge = risk.min_edge_bps / 10_000.0
        max_size = min(risk.max_trade_size, market_room)

        specs = (
            (Direction.CONVERGE, yes_book.best_ask(), no_book.best_ask(),
             yes_book.ask_levels, no_book.ask_levels, converge_edge_per_pair),
            (Direction.DIVERGE, yes_book.best_bid(), no_book.best_bid(),
             yes_book.bid_levels, no_book.bid_levels, diverge_edge_per_pair),
        )

        for direction, top_y, top_n, levels_y, levels_n, screen in specs:
            if top_y is None or top_n is None:
                continue
            # Cheap screen on top-of-book. This rejects the overwhelming majority of
            # updates without the cost of a full two-book walk.
            if screen(top_y.price, top_n.price, rate) <= 0:
                self.stats.screened_out_no_gross_edge += 1
                continue

            sized = size_trade(
                direction,
                levels_y(),
                levels_n(),
                fee_rate=rate,
                tick_size=market.tick_size,
                gas_cost=execu.gas_cost_per_settlement,
                max_size=max_size,
                max_capital=available_capital,
                min_order_size=market.min_order_size,
                min_edge_per_pair=min_edge,
            )
            if sized is None:
                self.stats.sized_out_below_threshold += 1
                continue
            yield direction, sized

    def _build_opportunity(
        self,
        market: Market,
        direction: Direction,
        sized: SizedTrade,
        rate: float,
        book_age_ms: float,
    ) -> Opportunity:
        side = Side.BUY if direction is Direction.CONVERGE else Side.SELL
        from .fees import taker_fee_per_share

        yes_leg = Leg(
            token_id=market.yes_token_id,
            outcome=Outcome.YES,
            side=side,
            limit_price=sized.yes_limit,
            size=sized.size,
            expected_vwap=sized.yes_vwap,
            expected_fee=sized.size * taker_fee_per_share(sized.yes_vwap, rate),
        )
        no_leg = Leg(
            token_id=market.no_token_id,
            outcome=Outcome.NO,
            side=side,
            limit_price=sized.no_limit,
            size=sized.size,
            expected_vwap=sized.no_vwap,
            expected_fee=sized.size * taker_fee_per_share(sized.no_vwap, rate),
        )

        return Opportunity(
            market=market,
            direction=direction,
            legs=(yes_leg, no_leg),
            size=sized.size,
            edge_per_pair=sized.edge_per_pair,
            gross_edge_per_pair=sized.gross_edge_per_pair,
            fee_per_pair=sized.fee_per_pair,
            gas_cost=sized.gas_cost,
            total_profit=sized.total_profit,
            book_age_ms=book_age_ms,
        )

    def scan_all(
        self,
        store: BookStore,
        *,
        available_capital: float,
        exposure_by_market: dict[str, float] | None = None,
        now_ms: float | None = None,
    ) -> list[Opportunity]:
        """Scan every tracked market, best opportunities first."""
        exposure = exposure_by_market or {}
        found = []
        for market in self.markets.values():
            if market.closed:
                continue
            opp = self.scan_market(
                market,
                store,
                available_capital=available_capital,
                exposure_in_market=exposure.get(market.condition_id, 0.0),
                now_ms=now_ms,
            )
            if opp is not None:
                found.append(opp)
        found.sort(key=lambda o: o.total_profit, reverse=True)
        return found
