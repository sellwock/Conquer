"""Configuration: YAML for tunables, environment for secrets.

Secrets are read from the environment only. They are never written to the config
file, never journaled, and `Settings.redacted()` is what gets logged.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator

# --- Endpoints (CLOB V2) ---------------------------------------------------
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
DATA_API = "https://data-api.polymarket.com"
WS_MARKET = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
WS_USER = "wss://ws-subscriptions-clob.polymarket.com/ws/user"

POLYGON_CHAIN_ID = 137

# --- Contracts -------------------------------------------------------------
# The Gnosis CTF is unchanged across V1/V2 and is what merge/split act on.
CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
# V2 exchanges (replace the V1 CTF/NegRisk exchanges).
EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B"
NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59"
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"

# VERIFY: pUSD replaced USDC.e as V2 collateral, and it is the token address that
# must be passed to splitPosition/mergePositions. This address is NOT hardcoded as
# trusted — `polyarb doctor` resolves and confirms it on-chain before live mode is
# allowed to run. Override via config if it is wrong.
PUSD_ADDRESS_DEFAULT = ""

# Per-category taker fee rates. fee_per_share = rate * p * (1 - p), taker only.
# Sourced from public fee documentation; `polyarb doctor` re-checks these against
# the live API and refuses to start live trading if it cannot confirm them.
DEFAULT_FEE_RATES: dict[str, float] = {
    "geopolitics": 0.00,
    "politics": 0.04,
    "finance": 0.04,
    "economics": 0.04,
    "tech": 0.04,
    "mentions": 0.04,
    "culture": 0.04,
    "sports": 0.05,
    "crypto": 0.07,
}

# Any category we do not recognise is assumed to be the most expensive one. An
# unknown category must never look cheaper than it is.
UNKNOWN_CATEGORY_FEE_RATE = 0.07


class RiskConfig(BaseModel):
    """Hard limits. These are the difference between a bad day and a blown account."""

    # Total collateral the bot may deploy at once, in pUSD.
    max_total_exposure: float = 250.0
    # Most that may sit in any single market.
    max_position_per_market: float = 50.0
    # Largest single trade, in pairs.
    max_trade_size: float = 50.0
    # Stop for the day after losing this much.
    max_daily_loss: float = 25.0
    # Minimum net edge required to act, in basis points of the $1 pair.
    min_edge_bps: float = 40.0
    # Refuse to trade a book older than this.
    max_book_age_ms: float = 1_500.0
    # If more than this fraction of recent attempts end up one-legged, halt: it
    # means we are systematically too slow and being picked off.
    max_one_legged_rate: float = 0.25
    one_legged_window: int = 20
    # Halt if actual fees diverge from the model by more than this (absolute $/share).
    fee_reconcile_tolerance: float = 0.002
    # Consecutive execution errors before halting.
    max_consecutive_errors: int = 5


class ExecutionConfig(BaseModel):
    # Round-trip latency assumed by the paper engine when deciding whether an
    # opportunity would still have been there on arrival.
    assumed_latency_ms: float = 150.0
    # Estimated Polygon gas cost of one merge/split, in pUSD.
    gas_cost_per_settlement: float = 0.02
    # Accumulate this much mergeable inventory before paying gas to merge.
    merge_threshold_pairs: float = 25.0
    # Merge anything outstanding at least this often, regardless of threshold.
    merge_max_age_s: float = 600.0
    # Send both legs in one batch request rather than sequentially.
    batch_legs: bool = True
    # On a one-legged fill, immediately exit the filled leg at market.
    unwind_one_legged: bool = True


class DiscoveryConfig(BaseModel):
    # Only track markets in these categories. Empty means all.
    # Defaulting to the zero-fee category plus the cheap tier is deliberate: it is
    # where net-of-fee edge actually survives.
    categories: list[str] = Field(default_factory=lambda: ["geopolitics", "politics", "finance", "tech"])
    # Skip illiquid markets; they show wide phantom spreads that never fill.
    min_liquidity: float = 500.0
    # Cap on tracked markets (each costs two WS subscriptions).
    max_markets: int = 200
    # Asset IDs per websocket connection. ~5 connections per IP is the documented cap.
    assets_per_connection: int = 200
    # Refresh the market list this often.
    refresh_interval_s: float = 900.0
    # Exclude neg-risk markets. Complement arb still works on them, but they route
    # through a different exchange contract; keep v1 to the plain path.
    exclude_neg_risk: bool = True


class Settings(BaseModel):
    risk: RiskConfig = Field(default_factory=RiskConfig)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    discovery: DiscoveryConfig = Field(default_factory=DiscoveryConfig)

    fee_rates: dict[str, float] = Field(default_factory=lambda: dict(DEFAULT_FEE_RATES))
    unknown_fee_rate: float = UNKNOWN_CATEGORY_FEE_RATE
    pusd_address: str = PUSD_ADDRESS_DEFAULT

    journal_dir: Path = Path("journals")
    recording_dir: Path = Path("recordings")

    # Live trading is off unless this is true AND the CLI is invoked with
    # --i-understand-the-risks. Two independent switches, on purpose.
    live_enabled: bool = False

    @field_validator("fee_rates")
    @classmethod
    def _lowercase_categories(cls, v: dict[str, float]) -> dict[str, float]:
        return {k.lower(): float(rate) for k, rate in v.items()}

    # --- Secrets: environment only ----------------------------------------
    @property
    def private_key(self) -> str:
        return os.environ.get("POLYARB_PRIVATE_KEY", "")

    @property
    def api_key(self) -> str:
        return os.environ.get("POLYARB_API_KEY", "")

    @property
    def api_secret(self) -> str:
        return os.environ.get("POLYARB_API_SECRET", "")

    @property
    def api_passphrase(self) -> str:
        return os.environ.get("POLYARB_API_PASSPHRASE", "")

    @property
    def rpc_url(self) -> str:
        return os.environ.get("POLYARB_RPC_URL", "https://polygon-rpc.com")

    @property
    def funder_address(self) -> str:
        return os.environ.get("POLYARB_FUNDER_ADDRESS", "")

    def has_credentials(self) -> bool:
        return bool(self.private_key and self.api_key and self.api_secret and self.api_passphrase)

    def redacted(self) -> dict[str, Any]:
        """Safe to log."""
        d = self.model_dump(mode="json")
        d["secrets_present"] = {
            "private_key": bool(self.private_key),
            "api_key": bool(self.api_key),
            "api_secret": bool(self.api_secret),
            "api_passphrase": bool(self.api_passphrase),
        }
        return d

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Settings":
        """Load from YAML if present, else defaults. Env supplies secrets either way."""
        if path is None:
            return cls()
        p = Path(path)
        if not p.exists():
            return cls()
        data = yaml.safe_load(p.read_text()) or {}
        return cls.model_validate(data)

    def fee_rate_for(self, category: str) -> float:
        """Fee rate for a category, defaulting pessimistically."""
        return self.fee_rates.get((category or "").lower(), self.unknown_fee_rate)
