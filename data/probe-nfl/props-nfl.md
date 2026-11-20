## Props backtest, NFL: 150 games, 6596 decided closing lines, 1000 sims per game (model nfl-0.1.0)

Games by month: 2026-09 48, 2026-10 60, 2026-11 42. Left out: none.

### The pick model, each day scored by a fit of earlier days (picks need 3% expected return)

- **With the prop model:** 6596 lines, 150 games. Coefficients [constant, book, simulation's disagreement]: -0.0945, 1, 0.0655
  - At the close: 121-121 (50.0% won, fit said 54.9%), -4.5% per bet (-15.9% to 7.6%), 98% unders · Brier fit 0.2495 vs book 0.2500 (-0.0015 to 0.0006) · 119 games, 25 days · close moved toward 0, away 0, same 242
  - At the open: 114-107 (51.6% won, fit said 55.0%), -1.5% per bet (-12.0% to 9.4%), 98% unders · Brier fit 0.2497 vs book 0.2500 (-0.0013 to 0.0008) · 119 games, 25 days · close moved toward 84, away 50, same 87
- **The book's line only (no prices posted; -110 assumed):** 6596 lines, 150 games. Coefficients [constant, book, simulation's disagreement]: -0.1038, 1, 0
  - At the close: 0-0 (0.0% won, fit said 0.0%), 0.0% per bet (0.0% to 0.0%), – unders · Brier fit 0.2494 vs book 0.2500 (-0.0015 to 0.0005) · 119 games, 25 days
  - At the open: 0-0 (0.0% won, fit said 0.0%), 0.0% per bet (0.0% to 0.0%), – unders · Brier fit 0.2499 vs book 0.2500 (-0.0010 to 0.0009) · 119 games, 25 days

### Flat bets, no model (record, return per bet, 95% range by game)

| Rule | At the close | At the open |
|---|---|---|
| Every under | 3469-3127 (52.6%), 0.4% per bet (-3.4% to 4.0%) | 3397-3199 (51.5%), -1.7% per bet (-5.4% to 2.0%) |
| Every over | 3127-3469 (47.4%), -9.5% per bet (-13.1% to -5.7%) | 3199-3397 (48.5%), -7.4% per bet (-11.0% to -3.7%) |
| Unders on small scoring lines (under 80% of typical) | – | – |
| Unders on small other lines | 1666-1523 (52.2%), -0.3% per bet (-4.3% to 3.7%) | 1629-1594 (50.5%), -3.5% per bet (-7.5% to 0.7%) |
| Unders on points lines under 12 | – | – |
| Overs on points lines of 24 or more | – | – |
| The simulation's side when it disagrees by 15+ points of chance | 1129-993 (53.2%), 1.6% per bet (-3.3% to 6.9%) | 1079-967 (52.7%), 0.7% per bet (-3.9% to 5.5%) |

### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)

| Stat | Small lines | Typical | Large lines |
|---|---|---|---|
| passYds | 47% [50%] of 17 | 52% [50%] of 277 | – |
| passComp | 50% [50%] of 6 | 49% [50%] of 290 | – |
| rushAtt | 39% [50%] of 283 | 51% [50%] of 216 | 49% [50%] of 49 |
| rushYds | 42% [50%] of 605 | 42% [50%] of 159 | 54% [50%] of 112 |
| recYds | 50% [50%] of 1095 | 47% [50%] of 425 | 44% [50%] of 271 |
| rec | 51% [50%] of 1003 | 43% [50%] of 615 | 48% [50%] of 164 |
| passAtt | 75% [50%] of 4 | 47% [50%] of 292 | – |
| passRushYds | 14% [50%] of 7 | 49% [50%] of 268 | – |
| rushRecYds | 44% [50%] of 169 | 48% [50%] of 168 | 46% [50%] of 101 |

From open to close, 1791 lines fell, 2277 rose and 2882 stayed (6596 decided opening lines).
