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
| Live games | n/a | simulate the rest of the game from the current score, clock, fouls and minutes; refreshes from ESPN every 30 seconds while the tab is open |
| Any moment | n/a | tap the real win-probability chart to simulate from that play |
| Who matters | n/a | ranks every rotation player by how much his team's win chance drops without him |
| Officials | Runs & Whistles: ref studies | whistle slider that changes foul calls, bonus free throws, foul trouble and rotations |
| Props | RotoBot: chat | line checker for points, rebounds, assists, threes and PRA from the full distributions |
| Parlays | RotoBot: parlay generator | suggested 1 to 3 leg parlays for one game or the whole slate, same-game legs scored jointly from the sims, capped hit chance and price |
| Slate board | RotoBot: slate view | every game on the date in one sortable table: model line, total and win chance next to the market's, the best single, and for started games the prediction saved before tip-off |
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

`.github/workflows/forward.yml` runs on a schedule. It saves each game's prediction before tip-off into the `data` branch, grades the game once it ends, and records every final score (`src/track/job.ts`, run by `scripts/forward.ts`):

- NBA games are logged, plus college games with a posted line.
- GitHub drops most scheduled runs on quiet repos (on the first day they came 3 to 4 hours apart), so an external cron service starts the workflow every 15 minutes through GitHub's API (setup below). The workflow's own 15-minute schedule stays as a backup, and the windows are wide enough to cope with gaps.
- The first snapshot comes within 30 hours of tip (within the next Eastern day's slate). It's refreshed within 3 hours of tip if it's more than 45 minutes old, and at any point before tip if it was taken before the book posted a line and one has since appeared. Each prediction records when it was taken (`takenAt`, `minsToTip`).
- Nothing is written after tip and nothing is backfilled, so the record has no hindsight.
- Each prediction stores the model version (`src/model/version.ts`), the line at that moment, and the full margin and total distributions.
- `src/track/grade.ts` derives the record from those entries: winners, against the spread, over/under, Brier score vs the market's no-vig odds with a bootstrap interval, calibration and closing-line value.
- **Player props** go to `v1/props/{league}/{season}/{yyyy-mm}.json`, apart from the game log:
  - Before tip-off, each snapshot also saves the book's posted prop lines with the simulation's over and push chances (the last refresh with lines wins).
  - Once per game, mid-game, the job saves the in-game book's prop lines, priced from the current score and box score, with the period, clock and score. That's NBA 2nd and 3rd quarters, or college from 10:00 left in the first half to 10:00 left in the second.
  - **Injury news (NBA):** every run reads ESPN's league-wide injury report (one request) and compares it with the previous run's report, kept in `v1/injuries/nba.json` with the last 48 hours of news. A player newly ruled out for a game that hasn't tipped, projected 12+ minutes, gets his game's prop lines priced twice on the same random numbers, with him out and with him in (`priceNews` in `src/model/news.ts`). Those are saved as a news snapshot (`news[]`, one per player). In the last 20 minutes before tip, games with news get the pre-game book's lines once more (`close`), to see whether the lines moved after the news.
  - After the final, each logged player's box line is added, or `null` if they sat, which voids their props.
  - The Track record's After news view grades news snapshots: its picks are only the side the news points to (the over when the scratch lifts a player's simulated line), and "Line moved toward the pick" counts how often the book's closing line moved their way, which says directly whether props lag the news.
  - `src/track/propGrade.ts` grades the simulation's side of every line and the top five picks per game, ranked as the app ranks single bets now (props at `PROP_SIM_WEIGHT`). It also gives a Brier comparison of the simulation's own chances with the market on the over, averaged per game because props in one game move together. That comparison is what decides when the simulation earns more weight.

`v1/index.json` lists the log files, since the site can't list folders on raw.githubusercontent.com. To run the job by hand (dry run writes nothing): Actions → Forward log → Run workflow.

**The external trigger.** A free [cron-job.org](https://cron-job.org) job calls GitHub's `workflow_dispatch` API every 15 minutes. Extra runs are harmless: the `forward-log` concurrency group keeps them from overlapping, and a run with nothing due changes nothing. To set it up or move it:

1. Create a fine-grained personal access token (GitHub → Settings → Developer settings → Fine-grained tokens). Give it access to this repository only, with **Actions: Read and write** and nothing else, and an expiry date.
2. Create a cron job:
   - URL: `https://api.github.com/repos/sellwock/Conquer/actions/workflows/forward.yml/dispatches`
   - Schedule: every 15 minutes
   - Request method: `POST`. Body: `{"ref":"main"}`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Turn on failure notifications, so an expired token gets noticed.
3. A working call returns `204 No Content` and a new run appears under Actions → Forward log. A `401` means the token expired or was revoked. To rotate it, create a new token, swap the header, then delete the old token.

`v1/status.json` records each run's time (`lastRun`). If it's more than an hour old, the trigger has stopped.

**Judging model changes.** Any change to simulation output bumps `MODEL_VERSION` (`tests/model-version.test.ts` fails otherwise). Label the pull request `backtest` and `.github/workflows/backtest.yml` runs `scripts/backtest.ts`:

- About 600 NBA and 600 college games from last season are rebuilt as of tip-off (`src/track/rebuild.ts`).
- They run once with the branch's model and once with the base's model, on the same games.
- The job summary (`src/track/compare.ts`) gives the paired Brier and log-loss differences with bootstrap intervals, plus the against-the-spread and over/under records, margin and total errors, total bias and overtime rate.

Merge a model change only when nothing gets significantly worse and the metric it targets improves.

## Model

`src/sim/engine.ts` plays one game a possession at a time:

- **Rotations** follow projected minutes. Starters open halves, players sit with foul trouble, closers play the last five minutes of close games, and benches empty in blowouts.
- **Possession enders** are chosen by usage among the five on the floor. The result is a turnover (live-ball steals lead to transition), a shooting foul (and-ones included), or a shot from one of five zones. Each zone's make rate is shrunk toward league norms and adjusted for the opponent's zone defense, home court, rim protection on the floor, and lineup shot creation.
- **Usage/efficiency trade-off:** lineups short on creators shoot worse and turn it over more. This is why losing a star costs more than his points.
- **Assists** come from each passer's actual assist network. Blocks, offensive rebounds (lineup vs lineup), team fouls and the bonus, foul-outs, clock milking, last-shot holds, and intentional fouling are all modeled.
- **Minutes redistribution:** an absent player's minutes go to teammates with headroom. Players at his position absorb more.

**Last 5** (`src/ui/recent.tsx`, `src/model/recent.ts`) shows each player's per-game averages over the last five games they played for the team: minutes, points, rebounds, assists, PRA, 3s, steals, blocks, turnovers and FG% (total makes over total attempts). The lines come from the box scores the game view already loads for each team's last 10 games, so the tab costs no extra requests; someone who changed teams shows only games with the new team, and early-season samples that reach back into last season are marked. Tapping a player shows each game and tonight's simulated line.

**Parlays** (`src/model/parlays.ts`) use only legs with a posted price: moneylines, spreads and totals. Legs from one game are scored together from that game's simulations, so correlation comes from the sims; legs from different games are independent. Model chances are weighted against the market's no-vig odds by how much the model earned in backtests (`MODEL_WEIGHT`, fitted from the backtest's "Best model weight" rows and refit whenever `MODEL_VERSION` changes). For model 1.1.0 the market alone ranked best on every NBA bet and on college moneylines, so no weighted NBA suggestion can beat the vig; college spreads and totals blend 25% simulation with 75% market. A switch on the tab ranks by the simulation instead (`SIM_PICKS`), and that's the default where the blend finds nothing (NBA). Game lines there use the simulation's chances alone; player props count 25% simulation and 75% the book's no-vig odds (`PROP_SIM_WEIGHT`), because the first graded props (two games, 310 lines) scored worse than the book's odds (Brier 0.307 vs 0.251; 25% simulation scored 0.258) and its top picks went 7–13 at simulated chances of 78% to 98%. Those picks carry a "Sim only" label (or "Sim + book" with prop legs) and a note that the market was more accurate, so their expected returns are likely overstated. A suggestion needs positive expected value, a hit chance of at least 40%, 25% or 15%, and a price no longer than +200, +400 or +700 for one, two or three legs. "Across the slate" and the Slate view share one scan of every upcoming game on the date (2,000 outcome-only sims each, two games at a time, cached for 30 minutes per model version); the board shows two picks per game in the parlays tab's default ranking: the best single on the game's own lines ("Line pick") and, once props are priced, the best player prop ("Prop pick"), each clearing the singles bar. The tab carries a disclaimer: suggestions, not advice. **Player props** come from ESPN's odds feed (`src/data/espn/props.ts`, DraftKings lines on sports.core.api.espn.com): points, rebounds, assists, threes and the PRA, P+R, P+A and R+A combos. Each over/under arrives as two unlabeled items, the over first. The simulator keeps every player's line in every simulation (`outcomes.players`), so a prop is scored together with the game's margin and total (`src/model/props.ts`). Props have no backtest, so the backtest blend leaves them to the market and only the simulation's ranking can pick them, at 25% simulation. Players projected under 15 minutes are left out. The slate scan fetches every game's props as well and runs its 2,000 sims with per-player lines (`runOutcomes(..., { players: true })`), so props cover the whole slate. A prop keeps only the over's result in each simulation (`hits`: 1 win, 0 loss, 2 push), which packs into 2 bits per sim in the 30-minute slate cache (about 55 KB per game). Fetching a game's props costs about 1 MB, for two pages of ESPN's feed. **Live props:** once a game starts, ESPN lists a second book, the in-game feed ("DraftKings - Live Odds"), whose lines move with the game. With the game simulated from now, the Parlays tab's Live props card reads that feed every two minutes and prices each prop as the player's stats so far plus the simulated rest of the game (`soFarOf`, `propMarkets(..., soFar)`); rows show what the player has now. Live props are ranked the same way, 25% simulation. The card's "All live games" view prices every other game in progress too (`src/ui/liveSlate.ts`): each game's in-game lines and 2,000 sims from its current state (`snapshotFromGame`), refreshed with one uncached summary request per game every two minutes while the view is open and the tab is visible, with Pause and Refresh now. It costs about 1 MB per live game per refresh. Singles and 2- and 3-leg live parlays mix props from every live game; legs from different games are treated as independent, and props in one game are scored together. When the pool holds only props, they get all 30 places in it. **Live game lines:** the in-game book's item in ESPN's odds feed also carries its live moneyline, spread and total, in the same fields as the game page's odds (`oddsFromItem`). A check during LAC@GS on Nov 2, 2026 confirmed they move with the game (GS −2.5, total 221.5 early, then LAC −3.5, total 232.5 after LAC went up 6 in a fast first quarter), but ESPN's copy refreshed only about every 10 minutes and first appeared about 10 minutes in, so the app tells users live prices can lag the book's by several minutes. Live markets use them as the game's lines, priced from the simulation from now, whose finals start at the current score, so they match the full-game lines books write live. Live singles show game lines next to props, and live parlays mix them, scoring a game's lines and props together. A game in progress now opens simulated from its current score (a link without `from` means `auto`: from now when live, from tip otherwise; `effectiveFrom` in `src/ui/state.ts`), so its live lines and props load on their own, and the Outlook tab leads with the top live bets (`LiveBetsPreview`): two game lines and five props, linking to the full Live bets card. **Injury news** (`src/ui/news.ts`, `src/ui/newsCard.tsx`): while the slate board is open, the app reads ESPN's league-wide injury report every two minutes (about 150 KB compressed) and compares it with the last report the scheduled job saved. Anyone newly ruled out for an upcoming NBA game, plus news the job logged in the last 48 hours, gets his game repriced with and without him in the simulation worker. The News card at the top of the board lists each one with the props his absence moves most: the side the news points to, the book's price, the shift in the player's simulated average, the hit chance (25% simulation) and return, and, when the forward log saved the line before the news, whether it has moved since. "Notify me" asks for browser notification permission once; with it on, the scanner keeps polling in a background tab and a new scratch raises a notification naming the top affected prop. Players projected under 12 minutes are listed without repricing. The slate board shows the same live picks for games in progress: the best live line in the Line pick column and the best live prop (with what the player has so far) in the Prop pick column, tagged Live. The board prices live games while it's open, every two minutes, with Pause; the open game is priced by its own simulation from now when it has one.

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
