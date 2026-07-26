"""Market discovery via the Gamma API.

Gamma is unauthenticated and returns market metadata: the CLOB token ids, tick size,
minimum order size, and enough tagging to work out the fee category.

Parsing is deliberately defensive and kept separate from HTTP so it can be tested
without a network. Gamma returns several fields as JSON-encoded *strings*
(`clobTokenIds`, `outcomes`) and is inconsistent about numeric types, so every field
goes through a coercion helper. Anything we cannot parse confidently is dropped
rather than guessed at — a market with the wrong YES/NO mapping would have the bot
buying two of the same side and calling it arbitrage.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from typing import Any

import httpx

from .config import GAMMA_API, DEFAULT_FEE_RATES, DiscoveryConfig
from .models import Market

log = logging.getLogger(__name__)

# Tags/labels seen on Gamma mapped onto our fee-table categories.
_CATEGORY_ALIASES: dict[str, str] = {
    "geopolitics": "geopolitics",
    "geopolitical": "geopolitics",
    "world": "geopolitics",
    "war": "geopolitics",
    "middle east": "geopolitics",
    "politics": "politics",
    "us-current-affairs": "politics",
    "elections": "politics",
    "election": "politics",
    "trump": "politics",
    "finance": "finance",
    "business": "finance",
    "economy": "economics",
    "economics": "economics",
    "inflation": "economics",
    "fed": "economics",
    "tech": "tech",
    "technology": "tech",
    "ai": "tech",
    "science": "tech",
    "sports": "sports",
    "nfl": "sports",
    "nba": "sports",
    "mlb": "sports",
    "soccer": "sports",
    "football": "sports",
    "crypto": "crypto",
    "bitcoin": "crypto",
    "ethereum": "crypto",
    "culture": "culture",
    "entertainment": "culture",
    "pop-culture": "culture",
    "mentions": "mentions",
}


def _as_float(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    if value is None:
        return default
    return bool(value)


def _as_list(value: Any) -> list[Any]:
    """Gamma sends arrays as JSON strings about half the time."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def infer_category(raw: dict[str, Any]) -> str:
    """Best-effort fee category.

    Returns "" when nothing matches, which makes `Settings.fee_rate_for` fall back to
    the most expensive rate. Unknown must never look cheap.
    """
    candidates: list[str] = []

    for key in ("category", "categoryLabel", "seriesCategory"):
        v = raw.get(key)
        if isinstance(v, str) and v:
            candidates.append(v)

    for tag in _as_list(raw.get("tags")):
        if isinstance(tag, str):
            candidates.append(tag)
        elif isinstance(tag, dict):
            for k in ("slug", "label", "name"):
                if isinstance(tag.get(k), str):
                    candidates.append(tag[k])

    for event in _as_list(raw.get("events")):
        if not isinstance(event, dict):
            continue
        for k in ("category", "slug", "title"):
            if isinstance(event.get(k), str):
                candidates.append(event[k])
        for tag in _as_list(event.get("tags")):
            if isinstance(tag, dict):
                for k in ("slug", "label", "name"):
                    if isinstance(tag.get(k), str):
                        candidates.append(tag[k])
            elif isinstance(tag, str):
                candidates.append(tag)

    for cand in candidates:
        key = cand.strip().lower()
        if key in _CATEGORY_ALIASES:
            return _CATEGORY_ALIASES[key]
        if key in DEFAULT_FEE_RATES:
            return key

    # Substring pass, for compound slugs like "nba-finals-2026".
    for cand in candidates:
        key = cand.strip().lower()
        for alias, category in _CATEGORY_ALIASES.items():
            if alias in key:
                return category
    return ""


def parse_market(raw: dict[str, Any]) -> Market | None:
    """Convert one Gamma market payload into a `Market`, or None if unusable."""
    condition_id = raw.get("conditionId") or raw.get("condition_id")
    if not condition_id:
        return None

    token_ids = [str(t) for t in _as_list(raw.get("clobTokenIds") or raw.get("clob_token_ids"))]
    outcomes = [str(o) for o in _as_list(raw.get("outcomes"))]

    # Binary markets only, and we need a token id for each outcome.
    if len(token_ids) != 2 or len(outcomes) != 2:
        return None

    # Never assume YES is index 0 — map by label. Getting this backwards would have
    # the bot buying the same side twice and booking it as a hedged pair.
    lowered = [o.strip().lower() for o in outcomes]
    if "yes" in lowered and "no" in lowered:
        yes_idx = lowered.index("yes")
        no_idx = lowered.index("no")
    else:
        return None

    tick = _as_float(
        raw.get("orderPriceMinTickSize") or raw.get("order_price_min_tick_size"), 0.01
    )
    if tick <= 0:
        tick = 0.01

    return Market(
        condition_id=str(condition_id),
        question=str(raw.get("question") or raw.get("title") or ""),
        slug=str(raw.get("slug") or condition_id),
        yes_token_id=token_ids[yes_idx],
        no_token_id=token_ids[no_idx],
        category=infer_category(raw),
        tick_size=tick,
        min_order_size=_as_float(raw.get("orderMinSize") or raw.get("order_min_size"), 5.0),
        neg_risk=_as_bool(raw.get("negRisk") or raw.get("neg_risk")),
        closed=_as_bool(raw.get("closed")),
        liquidity=_as_float(raw.get("liquidityNum") or raw.get("liquidity")),
        volume_24h=_as_float(raw.get("volume24hr") or raw.get("volume24hrClob")),
    )


def filter_markets(markets: Iterable[Market], cfg: DiscoveryConfig) -> list[Market]:
    """Apply configured filters and rank the survivors.

    Ranking favours cheap-to-trade markets: zero-fee categories first, then liquidity.
    """
    out = []
    wanted = {c.lower() for c in cfg.categories}
    for m in markets:
        if m.closed:
            continue
        if cfg.exclude_neg_risk and m.neg_risk:
            continue
        if wanted and m.category not in wanted:
            continue
        if m.liquidity < cfg.min_liquidity:
            continue
        out.append(m)

    out.sort(
        key=lambda m: (
            DEFAULT_FEE_RATES.get(m.category, 1.0),  # cheapest fee category first
            -m.liquidity,
        )
    )
    return out[: cfg.max_markets]


class GammaClient:
    """Thin paginating client for Gamma market listings."""

    def __init__(self, base_url: str = GAMMA_API, timeout: float = 20.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout, http2=True)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "GammaClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def fetch_markets(self, *, limit: int = 500, max_pages: int = 20) -> list[Market]:
        """Page through active, open markets and parse them."""
        markets: list[Market] = []
        offset = 0
        for _ in range(max_pages):
            resp = await self._client.get(
                f"{self.base_url}/markets",
                params={
                    "active": "true",
                    "closed": "false",
                    "archived": "false",
                    "limit": limit,
                    "offset": offset,
                },
            )
            resp.raise_for_status()
            payload = resp.json()
            # Gamma returns a bare array; some deployments wrap it in {"data": [...]}.
            rows = payload if isinstance(payload, list) else payload.get("data", [])
            if not rows:
                break
            for raw in rows:
                m = parse_market(raw)
                if m is not None:
                    markets.append(m)
            if len(rows) < limit:
                break
            offset += limit
        return markets


async def discover(cfg: DiscoveryConfig, base_url: str = GAMMA_API) -> list[Market]:
    """Fetch, parse, filter and rank tradable binary markets."""
    async with GammaClient(base_url) as client:
        raw_markets = await client.fetch_markets()
    selected = filter_markets(raw_markets, cfg)
    log.info("discovered %d markets, %d selected", len(raw_markets), len(selected))
    return selected
