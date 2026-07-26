"""Risk limits and halt conditions.

Everything here is a brake. The detector's job is to find trades; this module's job
is to refuse them. When the two disagree, this module wins.

Halts are sticky: once tripped, the bot stops trading until a human clears it. That
is deliberate. Every halt condition below represents "the world is not what the model
thinks it is", and the correct response to that is to stop, not to retry.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings
from .models import Direction, Opportunity, TradeResult

# Sub-cent tolerance for capital comparisons, well below pUSD's 6-decimal precision.
CAPITAL_EPSILON = 1e-6


@dataclass
class RiskState:
    starting_capital: float
    free_capital: float
    realised_pnl: float = 0.0
    fees_paid: float = 0.0
    gas_paid: float = 0.0

    exposure_by_market: dict[str, float] = field(default_factory=dict)
    trades_attempted: int = 0
    trades_filled: int = 0
    trades_one_legged: int = 0
    trades_unwound: int = 0

    halted: bool = False
    halt_reason: str = ""
    day_start: float = field(default_factory=time.time)

    @property
    def total_exposure(self) -> float:
        return sum(self.exposure_by_market.values())


class RiskManager:
    def __init__(self, settings: Settings, starting_capital: float,
                 kill_switch_path: str | Path | None = None) -> None:
        self.settings = settings
        self.cfg = settings.risk
        self.state = RiskState(starting_capital=starting_capital, free_capital=starting_capital)
        self.kill_switch_path = Path(kill_switch_path) if kill_switch_path else None
        # Rolling record of recent attempts, True when the attempt left us one-legged.
        self._recent_one_legged: deque[bool] = deque(maxlen=self.cfg.one_legged_window)
        self._consecutive_errors = 0

    # --- halting ----------------------------------------------------------
    def halt(self, reason: str) -> None:
        if not self.state.halted:
            self.state.halted = True
            self.state.halt_reason = reason

    def clear_halt(self) -> None:
        self.state.halted = False
        self.state.halt_reason = ""
        self._consecutive_errors = 0
        self._recent_one_legged.clear()

    def kill_switch_engaged(self) -> bool:
        """A file on disk stops the bot without needing to reach the process."""
        return self.kill_switch_path is not None and self.kill_switch_path.exists()

    # --- pre-trade checks -------------------------------------------------
    def approve(self, opp: Opportunity) -> tuple[bool, str]:
        """Gate one opportunity. Returns (approved, reason_if_not)."""
        if self.kill_switch_engaged():
            return False, f"kill switch present at {self.kill_switch_path}"
        if self.state.halted:
            return False, f"halted: {self.state.halt_reason}"

        if opp.size <= 0:
            return False, "non-positive size"
        if opp.edge_bps < self.cfg.min_edge_bps:
            return False, f"edge {opp.edge_bps:.1f}bps below minimum {self.cfg.min_edge_bps}"
        if opp.total_profit <= 0:
            return False, "non-positive expected profit"
        if opp.book_age_ms > self.cfg.max_book_age_ms:
            return False, f"book age {opp.book_age_ms:.0f}ms exceeds limit"

        capital_needed = self.capital_for(opp)
        # The detector sizes right up to the capital ceiling on purpose, so the
        # boundary case is legitimate and must not be lost to float noise.
        if capital_needed > self.state.free_capital + CAPITAL_EPSILON:
            return False, (
                f"needs ${capital_needed:.2f} but only ${self.state.free_capital:.2f} free"
            )

        market_exposure = self.state.exposure_by_market.get(opp.market.condition_id, 0.0)
        if market_exposure + opp.size > self.cfg.max_position_per_market:
            return False, (
                f"market exposure {market_exposure:.1f}+{opp.size:.1f} exceeds "
                f"{self.cfg.max_position_per_market}"
            )
        if self.state.total_exposure + opp.size > self.cfg.max_total_exposure:
            return False, (
                f"total exposure {self.state.total_exposure:.1f}+{opp.size:.1f} exceeds "
                f"{self.cfg.max_total_exposure}"
            )
        if opp.size > self.cfg.max_trade_size:
            return False, f"size {opp.size:.1f} exceeds max trade size {self.cfg.max_trade_size}"

        return True, ""

    def capital_for(self, opp: Opportunity) -> float:
        """Collateral consumed by the trade.

        Converge pays for both legs; diverge must first mint pairs at $1 each.
        """
        if opp.direction is Direction.CONVERGE:
            legs = sum(leg.expected_vwap * leg.size for leg in opp.legs)
            return legs + opp.fee_per_pair * opp.size + opp.gas_cost
        return opp.size + opp.gas_cost

    # --- post-trade accounting -------------------------------------------
    def on_trade(self, result: TradeResult) -> None:
        st = self.state
        st.trades_attempted += 1
        self._recent_one_legged.append(result.one_legged)

        if result.one_legged:
            st.trades_one_legged += 1
        if result.unwound:
            st.trades_unwound += 1
        if result.ok:
            st.trades_filled += 1

        st.realised_pnl += result.realised_pnl
        st.free_capital += result.realised_pnl
        st.fees_paid += sum(f.fee_paid for f in result.fills)

        if result.error:
            self._consecutive_errors += 1
            if self._consecutive_errors >= self.cfg.max_consecutive_errors:
                self.halt(f"{self._consecutive_errors} consecutive execution errors")
        else:
            self._consecutive_errors = 0

        self._check_daily_loss()
        self._check_one_legged_rate()

    def _check_daily_loss(self) -> None:
        if self.state.realised_pnl <= -abs(self.cfg.max_daily_loss):
            self.halt(
                f"daily loss ${-self.state.realised_pnl:.2f} reached limit "
                f"${self.cfg.max_daily_loss:.2f}"
            )

    def _check_one_legged_rate(self) -> None:
        """A high one-legged rate means we are consistently too slow.

        Each one is a small loss, but the signal matters more than the cost: it says
        our quotes are stale by the time they arrive and we are the one being picked
        off. Better to stop and investigate than to keep paying tuition.
        """
        if len(self._recent_one_legged) < self._recent_one_legged.maxlen:
            return
        rate = sum(self._recent_one_legged) / len(self._recent_one_legged)
        if rate > self.cfg.max_one_legged_rate:
            self.halt(
                f"one-legged rate {rate:.0%} over last {len(self._recent_one_legged)} "
                f"attempts exceeds {self.cfg.max_one_legged_rate:.0%}"
            )

    def check_fee_reconciliation(self, predicted: float, actual: float, context: str = "") -> bool:
        """Compare modelled fee against what was actually charged.

        The fee model could not be verified against live fills from a sandboxed
        environment, so this is the tripwire. If reality disagrees with the model, we
        stop — a wrong fee model turns every "profitable" trade into a slow loss.
        """
        divergence = abs(predicted - actual)
        if divergence > self.cfg.fee_reconcile_tolerance:
            self.halt(
                f"fee model divergence ${divergence:.5f} (predicted ${predicted:.5f}, "
                f"actual ${actual:.5f}){f' on {context}' if context else ''}"
            )
            return False
        return True

    # --- exposure ---------------------------------------------------------
    def add_exposure(self, condition_id: str, size: float, capital: float) -> None:
        st = self.state
        st.exposure_by_market[condition_id] = st.exposure_by_market.get(condition_id, 0.0) + size
        st.free_capital -= capital

    def release_exposure(self, condition_id: str, size: float, capital_returned: float) -> None:
        st = self.state
        remaining = st.exposure_by_market.get(condition_id, 0.0) - size
        if remaining <= 1e-9:
            st.exposure_by_market.pop(condition_id, None)
        else:
            st.exposure_by_market[condition_id] = remaining
        st.free_capital += capital_returned

    @property
    def available_capital(self) -> float:
        return max(0.0, self.state.free_capital)

    def exposure_snapshot(self) -> dict[str, float]:
        return dict(self.state.exposure_by_market)

    def summary(self) -> dict[str, object]:
        st = self.state
        one_legged_rate = (
            st.trades_one_legged / st.trades_attempted if st.trades_attempted else 0.0
        )
        return {
            "starting_capital": round(st.starting_capital, 4),
            "free_capital": round(st.free_capital, 4),
            "realised_pnl": round(st.realised_pnl, 4),
            "fees_paid": round(st.fees_paid, 4),
            "gas_paid": round(st.gas_paid, 4),
            "total_exposure": round(st.total_exposure, 4),
            "trades_attempted": st.trades_attempted,
            "trades_filled": st.trades_filled,
            "trades_one_legged": st.trades_one_legged,
            "trades_unwound": st.trades_unwound,
            "one_legged_rate": round(one_legged_rate, 4),
            "halted": st.halted,
            "halt_reason": st.halt_reason,
        }
