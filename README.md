# Conquer Game Sim

Pick any NBA or men's college basketball game, rule players in or out, and simulate it thousands of times, possession by possession. It runs entirely in the browser on ESPN's public data. There is no backend.

It rebuilds the "simulate" tool on Runs & Whistles (`/simulate/#game=…&date=…&out=…`) and borrows the best idea from RotoBot's game sims, a single "most typical" simulated game you can read like a real one. It then goes further:

| | Runs & Whistles / RotoBot | Conquer |
|---|---|---|
| Rule players out | yes | yes, plus clear injured players back in, with live minute redistribution shown per player |
| What it costs | single number | side-by-side with everyone available: win-chance swing and margin change |
| Typical game | RotoBot: summary | full box score, line score and play-by-play with scoring runs flagged |
| Market | RotoBot: win % vs book | moneyline (no-vig), spread cover %, over/under %, fair odds for each |
| Finished games | n/a | how likely the actual result was; re-simulate with as-played minutes |
| Live games | n/a | simulate the rest of the game from the current score, clock, fouls and minutes |
| Any moment | n/a | tap the real win-probability chart to simulate from that play |
| Who matters | n/a | ranks every rotation player by how much his team's win chance drops without him |
| Officials | Runs & Whistles: ref studies | whistle slider that changes foul calls, bonus free throws, foul trouble and rotations |
| Props | RotoBot: chat | line checker for points, rebounds, assists, threes and PRA from the full distributions |
| Parlays | RotoBot: parlay generator | suggested 1 to 3 leg parlays for one game or the whole slate, same-game legs scored jointly from the sims, capped hit chance and price |
| Reproducible | no | seeded; every scenario is a shareable URL |

## Use it

```bash
npm install
npm run dev        # http://localhost:5173 (ESPN is proxied through Vite in dev)
npm test           # engine calibration, minutes, parsers
npm run calibrate  # league-level calibration report
npm run build      # static site in dist/
```

Links keep the original format: `#game=401909088&date=20261020&out=<id>,<id>`. Extra state is optional: `league=ncaam`, `in=<injured id cleared to play>`, `n=1000|5000|10000|25000`, `seed=…`, `whistle=0.8…1.25`, `hca=0`, `mode=actual`, `from=tip|now|<play sequence>`, `tab=outlook|typical|players|flow|method`. Player ids are ESPN athlete ids. Ids from other sites (Runs & Whistles uses NBA.com ids) are ignored, and the app tells you so.

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`. To turn it on, set Settings → Pages → Source to **GitHub Actions**.

## Data

All data comes from ESPN's public JSON (`site.api.espn.com`, with `site.web.api.espn.com` as a fallback mirror):

- Scoreboard by date, game summary (header, box score, play-by-play, injuries, odds, officials, ESPN win probability and predictor), team rosters and schedules.
- Each team's last 10 completed games before tip. Their box scores give minutes, usage, turnovers, free throws, rebounding, assists, steals, blocks and fouls. Their play-by-play gives every shot's zone, assisted makes, the passing network, and each defense's opponent shooting by zone.
- Season averages (`apis/common/v3/.../athletes/{id}/stats`) for players without a recent sample with the team.

Completed-game extracts are cached in `localStorage`. If a host blocks direct calls to ESPN, set a proxy prefix under **Data connection** at the bottom of the page. When ESPN can't be reached at all, the app falls back to a clearly labeled synthetic sample matchup.

## Track record

`.github/workflows/forward.yml` runs twice an hour. It saves each game's prediction before tip-off into the `data` branch, grades the game once it ends, and records every final score (`src/track/job.ts`, run by `scripts/forward.ts`):

- NBA games are logged, plus college games with a posted line.
- The first snapshot comes within 12 hours of tip. It's refreshed within 90 minutes of tip if it's more than 25 minutes old.
- Nothing is written after tip and nothing is backfilled, so the record has no hindsight.
- Each prediction stores the model version (`src/model/version.ts`), the line at that moment, and the full margin and total distributions.
- `src/track/grade.ts` derives the record from those entries: winners, against the spread, over/under, Brier score vs the market's no-vig odds with a bootstrap interval, calibration and closing-line value.

`v1/index.json` lists the log files, since the site can't list folders on raw.githubusercontent.com. To run the job by hand (dry run writes nothing): Actions → Forward log → Run workflow.

## Model

`src/sim/engine.ts` plays one game a possession at a time:

- **Rotations** follow projected minutes. Starters open halves, players sit with foul trouble, closers play the last five minutes of close games, and benches empty in blowouts.
- **Possession enders** are chosen by usage among the five on the floor. The result is a turnover (live-ball steals lead to transition), a shooting foul (and-ones included), or a shot from one of five zones. Each zone's make rate is shrunk toward league norms and adjusted for the opponent's zone defense, home court, rim protection on the floor, and lineup shot creation.
- **Usage/efficiency trade-off:** lineups short on creators shoot worse and turn it over more. This is why losing a star costs more than his points.
- **Assists** come from each passer's actual assist network. Blocks, offensive rebounds (lineup vs lineup), team fouls and the bonus, foul-outs, clock milking, last-shot holds, and intentional fouling are all modeled.
- **Minutes redistribution:** an absent player's minutes go to teammates with headroom. Players at his position absorb more.

**Parlays** (`src/model/parlays.ts`) use only legs with a posted price: moneylines, spreads and totals. Legs from one game are scored together from that game's simulations, so correlation comes from the sims; legs from different games are independent. Model chances are blended 50/50 with the market's no-vig odds before ranking. A suggestion needs positive expected value, a hit chance of at least 40%, 25% or 15%, and a price no longer than +200, +400 or +700 for one, two or three legs. "Across the slate" simulates every upcoming game on the date (2,000 sims each). The tab carries a disclaimer: suggestions, not advice.

`src/sim/run.ts` aggregates the runs into margin, total, first-half, run and lead distributions, plus per-player stat histograms. It picks the typical game (closest to the median margin, total and key scorers) and replays it from its seed with a full log.

Calibration (`npm run calibrate`, 4,000 league-average games):

| | Simulated | Real NBA |
|---|---|---|
| Possessions per team | 99.2 | 99.5 |
| Points per possession | 1.146 | 1.145 |
| Home margin | +2.2 | +2.2 |
| Margin standard deviation | 13.9 | ~13.5 |
| Foul-outs per game | 0.18 | ~0.15 |

In the sample matchup, ruling out the 29-point star drops his team from 59% to 49% and costs about 3.5 points of margin.

### Known gaps

- Overtime comes up in about 3.7% of simulated games against about 6% in the NBA. Endgame tactics are simpler than real coaching.
- No individual defense beyond steals, blocks, rebounding and fouls. No matchups, rest, travel or motivation.
- College play-by-play rarely has shot distances, so college zones are coarser. College priors are less tuned than NBA ones.
- The parser tests use synthetic fixtures built from ESPN's documented shapes (`tests/fixtures/espn`). This repo was built in an environment that couldn't reach ESPN, so the first run against live data is the real integration test. Everything is parsed defensively by key, never by column position.

## Layout

```
src/lib        PRNG (seeded, splittable), histograms, odds math
src/model      domain types, league constants, profile → simulator inputs
src/sim        engine, aggregation, web-worker client
src/data       ESPN client, parsers, loader, synthetic sample game
src/ui         Preact components (scoreboard, lineup sheet, outlook, typical game, players, flow, method)
tests          vitest: engine calibration and behavior, parsers against fixtures
scripts        calibration report
```
