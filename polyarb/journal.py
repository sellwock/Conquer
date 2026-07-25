"""Append-only JSONL journal and reporting.

Every opportunity seen, every trade attempted, every rejection and its reason lands
here. The point is to be able to answer, after a week of paper trading, the only
question that matters: *did real, net-of-fee edge actually exist, and would we have
captured it?* A bot that cannot answer that honestly is a bot that loses money
slowly while looking busy.
"""

from __future__ import annotations

import json
import statistics
import time
from collections import Counter
from contextlib import suppress
from pathlib import Path
from typing import Any

from .models import Opportunity, TradeResult, q6


def _opportunity_row(opp: Opportunity) -> dict[str, Any]:
    return {
        "condition_id": opp.market.condition_id,
        "slug": opp.market.slug,
        "category": opp.market.category,
        "direction": opp.direction.value,
        "size": q6(opp.size),
        "edge_bps": round(opp.edge_bps, 4),
        "gross_edge_per_pair": q6(opp.gross_edge_per_pair),
        "fee_per_pair": q6(opp.fee_per_pair),
        "gas_cost": q6(opp.gas_cost),
        "expected_profit": q6(opp.total_profit),
        "book_age_ms": round(opp.book_age_ms, 1),
        "legs": [
            {
                "token_id": leg.token_id,
                "outcome": leg.outcome.value,
                "side": leg.side.value,
                "limit_price": leg.limit_price,
                "size": q6(leg.size),
                "expected_vwap": q6(leg.expected_vwap),
            }
            for leg in opp.legs
        ],
    }


class Journal:
    """Writes newline-delimited JSON events. One file per run."""

    def __init__(self, directory: str | Path, run_id: str | None = None) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.run_id = run_id or time.strftime("%Y%m%d-%H%M%S")
        self.path = self.dir / f"run-{self.run_id}.jsonl"
        self._fh = self.path.open("a", encoding="utf-8")
        self.counts: Counter[str] = Counter()

    def _write(self, kind: str, payload: dict[str, Any]) -> None:
        rec = {"ts": time.time(), "kind": kind, **payload}
        self._fh.write(json.dumps(rec, separators=(",", ":"), default=str) + "\n")
        self._fh.flush()
        self.counts[kind] += 1

    def opportunity(self, opp: Opportunity) -> None:
        self._write("opportunity", _opportunity_row(opp))

    def rejected(self, opp: Opportunity, reason: str) -> None:
        self._write("rejected", {"reason": reason, **_opportunity_row(opp)})

    def trade(self, result: TradeResult) -> None:
        self._write(
            "trade",
            {
                "slug": result.opportunity.market.slug,
                "category": result.opportunity.market.category,
                "direction": result.opportunity.direction.value,
                "expected_profit": q6(result.opportunity.total_profit),
                "realised_pnl": q6(result.realised_pnl),
                "one_legged": result.one_legged,
                "unwound": result.unwound,
                "ok": result.ok,
                "error": result.error,
                "fills": [
                    {
                        "token_id": f.token_id,
                        "outcome": f.outcome.value,
                        "side": f.side.value,
                        "filled_size": q6(f.filled_size),
                        "avg_price": q6(f.avg_price),
                        "fee_paid": q6(f.fee_paid),
                        "ok": f.ok,
                        "error": f.error,
                    }
                    for f in result.fills
                ],
            },
        )

    def event(self, name: str, **fields: Any) -> None:
        self._write("event", {"event": name, **fields})

    def close(self) -> None:
        with suppress(Exception):
            self._fh.flush()
            self._fh.close()

    def __enter__(self) -> "Journal":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def read_journal(path: str | Path) -> list[dict[str, Any]]:
    rows = []
    p = Path(path)
    if not p.exists():
        return rows
    with p.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn a journal into the numbers that decide whether to fund this thing."""
    opps = [r for r in rows if r.get("kind") == "opportunity"]
    trades = [r for r in rows if r.get("kind") == "trade"]
    rejects = [r for r in rows if r.get("kind") == "rejected"]

    edges = [r["edge_bps"] for r in opps if "edge_bps" in r]
    realised = [r["realised_pnl"] for r in trades if "realised_pnl" in r]
    expected = [r["expected_profit"] for r in trades if "expected_profit" in r]

    filled = [r for r in trades if r.get("ok")]
    one_legged = [r for r in trades if r.get("one_legged")]

    summary: dict[str, Any] = {
        "opportunities_detected": len(opps),
        "trades_attempted": len(trades),
        "trades_filled": len(filled),
        "trades_one_legged": len(one_legged),
        "fill_rate": round(len(filled) / len(trades), 4) if trades else 0.0,
        "one_legged_rate": round(len(one_legged) / len(trades), 4) if trades else 0.0,
        "rejected": len(rejects),
        "rejection_reasons": dict(Counter(r.get("reason", "?") for r in rejects).most_common(10)),
        "total_realised_pnl": q6(sum(realised)),
        "total_expected_profit": q6(sum(expected)),
        "by_category": {},
    }

    if edges:
        summary["edge_bps"] = {
            "count": len(edges),
            "min": round(min(edges), 2),
            "median": round(statistics.median(edges), 2),
            "mean": round(statistics.fmean(edges), 2),
            "max": round(max(edges), 2),
        }

    if realised and expected:
        # How much of the modelled edge actually survived contact with the market.
        total_expected = sum(expected)
        if total_expected != 0:
            summary["capture_ratio"] = round(sum(realised) / total_expected, 4)

    by_cat: dict[str, dict[str, float]] = {}
    for r in trades:
        cat = r.get("category") or "unknown"
        entry = by_cat.setdefault(cat, {"trades": 0, "pnl": 0.0})
        entry["trades"] += 1
        entry["pnl"] = q6(entry["pnl"] + r.get("realised_pnl", 0.0))
    summary["by_category"] = by_cat

    return summary


def summarise_dir(directory: str | Path) -> dict[str, Any]:
    """Summarise every run file in a journal directory."""
    d = Path(directory)
    rows: list[dict[str, Any]] = []
    if d.exists():
        for f in sorted(d.glob("run-*.jsonl")):
            rows.extend(read_journal(f))
    return summarise(rows)
