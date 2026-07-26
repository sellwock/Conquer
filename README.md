# polyarb

Binary-complement arbitrage bot for Polymarket (CLOB V2).

## What it does

In a binary market, YES and NO must sum to exactly $1.00 at resolution. When they
trade for less than that, you can buy both and call `mergePositions()` to turn the
pair straight back into $1 of collateral — no waiting for the market to resolve, no
resolution risk, and the capital immediately recycles.

    ask(YES) + ask(NO) < $1.00   ->  buy both, merge for $1          (CONVERGE)
    bid(YES) + bid(NO) > $1.00   ->  split $1 into a pair, sell both (DIVERGE)

That is the entire strategy. It is a true arbitrage: both legs are known at entry and
the payoff does not depend on how the market resolves.

## Read this before you fund it

**Fees, not spreads, decide whether this makes money.** Polymarket charges a
taker-only fee per share of `rate × price × (1 − price)`, on *each* leg. That curve
peaks at 50¢ and collapses at the extremes, which changes the strategy completely:

| price | geopolitics (0) | politics (0.04) | sports (0.05) | crypto (0.07) |
|------:|----------------:|----------------:|--------------:|--------------:|
| 0.50  | 0.00¢ | 2.00¢ | 2.50¢ | 3.50¢ |
| 0.75  | 0.00¢ | 1.50¢ | 1.88¢ | 2.63¢ |
| 0.90  | 0.00¢ | 0.72¢ | 0.90¢ | 1.26¢ |
| 0.95  | 0.00¢ | 0.38¢ | 0.48¢ | 0.67¢ |
| 0.99  | 0.00¢ | 0.08¢ | 0.10¢ | 0.14¢ |

*(gross gap needed just to break even — `polyarb doctor` prints this live)*

A 1¢ gap at 50/50 in a sports market is not an opportunity; it is a 1.5¢ loss. The
same 1¢ gap at 95/5, or anywhere in geopolitics, is real money. The bot is built to
hunt exactly where the fee curve is cheap, and it refuses trades that look profitable
on screen but are not after fees.

**Honest expectations.** This space is contested by professional bots. The edge that
survives fees is thin and infrequent, and most detected gaps will close before an
order lands. A well-built bot here is a grinder, not a windfall. The verification
ladder below exists to measure whether real edge exists *before* any capital is at
risk — and "no, it doesn't" is a legitimate and valuable answer. Do not skip it.

## Install

    python -m venv .venv && source .venv/bin/activate
    pip install -e '.[dev]'          # paper, replay, record, tests
    pip install -e '.[live]'         # adds py-clob-client-v2 + web3 for live trading

Copy the config and secrets templates:

    cp polyarb.example.yaml polyarb.yaml
    cp .env.example .env             # never commit this

## Try it right now, offline

A synthetic recording is committed so the whole pipeline runs with no network:

    polyarb analyze tests/fixtures/sample-frames.jsonl
    polyarb replay  tests/fixtures/sample-frames.jsonl --capital 500

It contains a 3¢ gap in a fee-free geopolitics market (which should be taken) and a
1¢ gap in a crypto market (which must be rejected, because fees cost ~3.5¢ there).

## The verification ladder

Each rung answers a question the next depends on. **Do not skip rungs**, and do not
put real money on the last one until the middle ones say it is worth it.

| # | Command | Question it answers |
|---|---------|---------------------|
| 1 | `polyarb doctor` | Can I reach the API, are my credentials good, are the fee assumptions right, **and is my configured latency honest**? |
| 2 | `polyarb discover` | Which markets are cheap enough to be worth watching? |
| 3 | `polyarb record --minutes 2880` | Capture real market data. Rotates hourly, so multi-day captures are safe. |
| 4 | `polyarb analyze <recording>` | **How long do gaps last, and could I reach them?** |
| 5 | `polyarb replay <recording>` | Did the full pipeline turn those gaps into profit? |
| 6 | `polyarb paper` | Would I have captured them live, given real latency? |
| 7 | `polyarb live --i-understand-the-risks --capital N` | Real money. |

`polyarb report` summarises journals at any point.

### `analyze` is the gate

This is the measurement everything else depends on, and it is worth understanding why
it exists separately from `replay`.

Detecting an arbitrage is easy. The question that decides whether the strategy is
viable is *how long the gap stays open compared to how long it takes you to reach it*.
If gaps close in 40ms and your round trip is 150ms, no amount of engineering helps —
every "opportunity" the detector reports is one you would have missed, and you are
looking at light from dead stars.

`analyze` runs **detection only**: no trading, no execution model, nothing consumed.
That separation matters, because the paper engine deliberately eats the liquidity it
fills, so lifetimes measured there would confuse "the market closed the gap" with
"I closed it". Here a lifetime means how long the opportunity existed for anyone.

It reports gap lifetimes, the fraction that outlived your latency, opportunities per
hour by category, and edge broken down by price extremity — which checks the fee-curve
thesis against real data instead of assuming it. It ends with a plain-language verdict.

Two deliberate refusals to flatter you:

- **Rates are suppressed on small samples.** Under an hour of data or fewer than ten
  gaps, per-hour figures are reported as meaningless rather than extrapolated. One
  lucky gap in a two-minute capture should not imply an hourly income.
- **A gap seen once has a lifetime of zero.** One sighting is no evidence it persisted.

**The gate.** If `analyze` says few gaps outlive your latency, or `paper` shows a low
`fill_rate` and a high `one_legged_rate`, the correct outcome is not to trade. Someone
faster is taking the edge and going live just donates to them. The tooling is built to
make that answer visible rather than to bury it.

Live mode requires *three* independent confirmations: the `--i-understand-the-risks`
flag, `live_enabled: true` in the config, and an interactive prompt.

## How it works

```
feed.py       websocket -> raw frames        (reconnect, PING/10s, hourly rotation)
book.py       frames -> local order books    (desync guards, impact model)
discovery.py  Gamma API -> tradable markets  (YES/NO pairing, fee category)
fees.py       the fee curve and net edge     <- everything routes through here
sizing.py     books -> optimal trade size    (depth-aware, gas-amortised)
detector.py   books -> priced opportunities
analysis.py   opportunities -> gap lifetimes (the decision gate)
latency.py    measured round trips           (keeps paper results honest)
risk.py       opportunities -> approve/deny  (caps, halts, kill switch)
execution/    opportunities -> fills         (paper | live)
settle.py     matched pairs -> collateral    (batched merges)
runner.py     wires it all together
```

### Design decisions worth knowing

**Sizing consumes both books in lockstep** and stops the moment marginal edge turns
negative, maximising total profit rather than per-share edge. Gas is a fixed cost, so
it is amortised over size — which is why tiny trades get rejected.

**Limit prices cannot fill at a loss.** Each leg's limit is the deepest price the
sizing walk consumed, and every consumed price had positive marginal edge. Book prices
already sit on the tick grid, so no widening is needed. A fill-or-kill order at those
limits therefore either fills profitably or does not fill — even if the book moves
against us in flight. This is the main safety property in the execution path, and it
is tested against randomised books in `tests/test_sizing.py`.

**A stale book is treated as an emergency, not an opportunity.** If our copy desyncs,
two complementary books can appear to sum well under $1.00 — the exact signature of a
huge arbitrage. `book.py` refuses to trade on crossed books, unknown-level removals,
negative sizes, or anything past the staleness window, and forces a re-snapshot.

**The paper engine is built not to flatter itself.** It delays every submission by the
configured latency, matches against the book *as it stands after that delay*, applies
the full fee model, and removes the liquidity its own fills consumed. A paper engine
that fills instantly at the observed price manufactures confidence and loses real
money later.

**One-legged fills are the real risk.** Both legs go out in a single batch request as
fill-or-kill. If one fills and the other does not, the filled leg is reversed at market
immediately and the loss is booked. Repeated one-legged fills halt the bot: it means we
are systematically too slow, and that signal matters more than the individual losses.

**Fee reconciliation is a tripwire.** Every live fill compares the charged fee against
the model. Divergence halts the run, because a wrong fee model turns every "profitable"
trade into a slow loss.

## Safety

- Paper is the default; live needs three separate confirmations.
- Hard caps on trade size, per-market exposure, total exposure and daily loss.
- Kill switch: `touch state/HALT` stops trading without touching the process.
- Halts are sticky and require a human to clear — every halt condition means "the
  world is not what the model thinks it is", and the answer to that is to stop.
- Secrets are read from the environment only, never written to disk or logs.
- Unknown market categories are priced at the *most expensive* fee rate, so an
  unrecognised market can never look cheaper than it is.

## Assumptions that need live verification

This was built in an environment where `*.polymarket.com` was unreachable, so the
following come from official documentation rather than from observed API behaviour.
Each is marked `# VERIFY:` in the source and checked by `polyarb doctor`:

- **Fee model** — `shares × rate × p × (1−p)`, taker only. The live engine halts
  automatically if charged fees diverge from this, so a wrong assumption costs one
  trade rather than a session.
- **Per-category fee rates** — these change; re-check them.
- **pUSD collateral address** — V2 replaced USDC.e. Never hardcoded; set it in config.
- **SDK response shapes** — all confined to `execution/gateway.py`. Unrecognised
  responses are treated as failures, never as silent successes.
- **Book hash algorithm** — undocumented, so no hash check is invented. `book.py`
  exposes a `hash_verifier` hook to switch it on once the algorithm is known.

## Tests

    pytest                    # 395 tests, no network required

Includes hand-computed fee arithmetic, a no-free-money property test (complement
prices at parity must never show a profit), randomised verification of the
limit-price safety property, desync detection, and a full replay-driven end-to-end run.

## Not implemented (deliberately)

Neg-risk multi-outcome and convert arbitrage, maker-side quoting, and cross-market
correlation trades — the last of which is not arbitrage at all, since it carries real
directional risk. The architecture leaves room for each.
