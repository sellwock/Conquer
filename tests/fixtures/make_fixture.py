"""Generate the synthetic recording used by tests and by the offline replay demo.

Real recordings come from `polyarb record` on a networked machine. This one is
hand-built so the whole pipeline can be exercised anywhere, and so the test suite has
a scenario with a known-correct answer.

The scenario deliberately contains both outcomes that matter:

  * a **geopolitics** market (fee rate 0) where a 3c gap opens and should be traded
  * a **crypto** market (fee rate 0.07) with a 1c gap that must be *rejected*,
    because the fee curve costs ~3.5c per pair at those prices

If a change ever makes the bot trade the crypto market, the fee model has broken.

Run:  python tests/fixtures/make_fixture.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
T0 = 1_700_000_000_000  # epoch ms

MARKETS = [
    {
        "condition_id": "0xgeo",
        "question": "Will the treaty be signed before year end?",
        "slug": "treaty-signed",
        "yes_token_id": "GEO_YES",
        "no_token_id": "GEO_NO",
        "category": "geopolitics",
        "tick_size": 0.01,
        "min_order_size": 5.0,
        "neg_risk": False,
        "closed": False,
        "liquidity": 50_000.0,
        "volume_24h": 12_000.0,
    },
    {
        "condition_id": "0xcry",
        "question": "Will BTC close above 100k?",
        "slug": "btc-above-100k",
        "yes_token_id": "CRY_YES",
        "no_token_id": "CRY_NO",
        "category": "crypto",
        "tick_size": 0.01,
        "min_order_size": 5.0,
        "neg_risk": False,
        "closed": False,
        "liquidity": 80_000.0,
        "volume_24h": 40_000.0,
    },
]


def book(token: str, bids, asks, ts: int) -> dict:
    return {
        "event_type": "book",
        "asset_id": token,
        "market": "0xgeo" if token.startswith("GEO") else "0xcry",
        "bids": [{"price": f"{p:.2f}", "size": f"{s:.2f}"} for p, s in bids],
        "asks": [{"price": f"{p:.2f}", "size": f"{s:.2f}"} for p, s in asks],
        "timestamp": str(ts),
        "hash": f"h{ts}",
    }


def price_change(token: str, changes, ts: int) -> dict:
    return {
        "event_type": "price_change",
        "asset_id": token,
        "changes": [
            {"price": f"{p:.2f}", "side": side, "size": f"{s:.2f}"} for p, side, s in changes
        ],
        "timestamp": str(ts),
        "hash": f"h{ts}",
    }


def build_frames() -> list[dict]:
    frames: list[tuple[int, dict]] = []

    # --- opening snapshots: nothing tradable anywhere ---------------------
    frames.append((T0, book("GEO_YES", [(0.44, 500)], [(0.45, 500)], T0)))
    frames.append((T0, book("GEO_NO", [(0.54, 500)], [(0.55, 500)], T0)))
    # Crypto: asks sum to 0.99 — a 1c gross gap that fees make unprofitable.
    frames.append((T0, book("CRY_YES", [(0.48, 500)], [(0.49, 500)], T0)))
    frames.append((T0, book("CRY_NO", [(0.49, 500)], [(0.50, 500)], T0)))

    # Some quiet churn so the run looks like a real stream.
    for i in range(1, 6):
        ts = T0 + i * 100
        frames.append((ts, price_change("CRY_YES", [(0.47, "BUY", 100 + i)], ts)))

    # --- the geopolitics arb opens: YES offered down to 0.42 --------------
    # A seller sweeps the 0.44 bid and reloads the offer at 0.42, so the whole YES
    # book steps down together. The bid MUST move too: an ask at 0.42 resting under
    # a 0.44 bid is a crossed book, which cannot exist on a live matching engine and
    # which the desync guard correctly refuses to trade.
    # Asks now sum to 0.42 + 0.55 = 0.97, a 3c gap in a zero-fee category.
    t_open = T0 + 1_000
    # The cheap offer is exactly 50 shares — one trade at the default max size takes
    # all of it, so the paper engine's impact model should make the gap disappear
    # rather than letting it be traded repeatedly.
    frames.append((
        t_open,
        price_change(
            "GEO_YES",
            [(0.44, "BUY", 0.0), (0.41, "BUY", 400.0), (0.42, "SELL", 50.0)],
            t_open,
        ),
    ))

    # Frames after the latency window so the paper engine settles the fill.
    for i in range(1, 5):
        ts = t_open + 50 * i
        frames.append((ts, price_change("GEO_NO", [(0.54, "BUY", 500.0 + i)], ts)))

    # --- the arb closes again: the cheap offer is lifted ------------------
    t_close = t_open + 400
    frames.append((
        t_close,
        price_change("GEO_YES", [(0.42, "SELL", 0.0), (0.45, "SELL", 500.0)], t_close),
    ))

    # --- tail churn -------------------------------------------------------
    for i in range(1, 8):
        ts = t_close + i * 100
        frames.append((ts, price_change("GEO_NO", [(0.54, "BUY", 400.0 + i)], ts)))

    return [{"received_at": ts / 1000.0, "frame": f} for ts, f in frames]


def main() -> None:
    frames_path = HERE / "sample-frames.jsonl"
    markets_path = HERE / "sample-markets.json"

    with frames_path.open("w", encoding="utf-8") as fh:
        for rec in build_frames():
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")

    markets_path.write_text(json.dumps(MARKETS, indent=2) + "\n")
    print(f"wrote {frames_path} and {markets_path}")


if __name__ == "__main__":
    main()
