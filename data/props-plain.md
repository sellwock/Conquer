## Props backtest, NBA: 169 games, 14662 decided closing lines, 1000 sims per game (model 1.2.0)

Games by month: 2026-01 12, 2026-10 81, 2026-11 76. Left out: 225 no prop lines kept.

### The pick model, each day scored by a fit of earlier days (picks need 3% expected return)

- **With the simulation:** 14662 lines, 168 games. Coefficients [constant, book, simulation's disagreement]: -0.0308, 0.9791, 0.1342
  - At the close: 145-128 (53.1% won, fit said 55.1%), 2.3% per bet (-8.1% to 13.4%), 96% unders · Brier fit 0.2474 vs book 0.2480 (-0.0014 to 0.0003) · 146 games, 19 days · close moved toward 0, away 0, same 273
  - At the open: 176-135 (56.6% won, fit said 54.9%), 9.1% per bet (-0.9% to 20.2%), 97% unders · Brier fit 0.2460 vs book 0.2475 (-0.0023 to -0.0006) · 146 games, 19 days · close moved toward 179, away 94, same 38
- **Book's odds only:** 14662 lines, 168 games. Coefficients [constant, book, simulation's disagreement]: -0.0957, 0.9798, 0
  - At the close: 3-16 (15.8% won, fit said 41.6%), -60.2% per bet (-100.0% to 0.3%), 100% unders · Brier fit 0.2477 vs book 0.2480 (-0.0010 to 0.0004) · 146 games, 19 days · close moved toward 0, away 0, same 19
  - At the open: 6-14 (30.0% won, fit said 41.3%), -23.6% per bet (-76.7% to 31.4%), 100% unders · Brier fit 0.2470 vs book 0.2475 (-0.0012 to 0.0002) · 146 games, 19 days · close moved toward 10, away 8, same 2

Simulation alone on every closing line: Brier 0.2656 vs the book's 0.2480. Its average score sat 5.3 points from the book's spread and 5.2 from its total (root mean square, 169 games).

### Flat bets, no model (record, return per bet, 95% range by game)

| Rule | At the close | At the open |
|---|---|---|
| Every under | 7739-6923 (52.8%), -1.8% per bet (-4.7% to 1.1%) | 7777-6885 (53.0%), -1.3% per bet (-4.3% to 1.7%) |
| Every over | 6923-7739 (47.2%), -10.7% per bet (-13.7% to -7.8%) | 6885-7777 (47.0%), -11.4% per bet (-14.6% to -8.4%) |
| Unders on small scoring lines (under 80% of typical) | 1190-1030 (53.6%), 0.8% per bet (-5.0% to 6.2%) | 1174-1041 (53.0%), -0.3% per bet (-5.8% to 5.1%) |
| Unders on small other lines | 1093-1060 (50.8%), -4.2% per bet (-8.9% to 0.4%) | 1077-1080 (49.9%), -5.4% per bet (-10.1% to -0.9%) |
| Unders on points lines under 12 | 516-448 (53.5%), 1.1% per bet (-4.2% to 6.4%) | 513-458 (52.8%), 0.0% per bet (-5.0% to 5.5%) |
| Overs on points lines of 24 or more | 66-87 (43.1%), -18.3% per bet (-33.4% to -4.0%) | 57-87 (39.6%), -25.3% per bet (-39.9% to -11.0%) |
| The simulation's side when it disagrees by 15+ points of chance | 3156-2645 (54.4%), 1.8% per bet (-2.6% to 6.3%) | 3337-2593 (56.3%), 5.1% per bet (0.8% to 9.7%) |

### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)

| Stat | Small lines | Typical | Large lines |
|---|---|---|---|
| pts | 48% [50%] of 630 | 46% [50%] of 808 | 50% [50%] of 729 |
| reb | 49% [50%] of 812 | 50% [49%] of 664 | 47% [49%] of 572 |
| ast | 50% [50%] of 684 | 44% [49%] of 524 | 44% [49%] of 397 |
| tpm | 52% [56%] of 195 | 46% [47%] of 1057 | 48% [47%] of 527 |
| pra | 43% [50%] of 486 | 47% [50%] of 867 | 46% [50%] of 376 |
| pr | 48% [50%] of 582 | 46% [50%] of 947 | 47% [50%] of 529 |
| pa | 46% [50%] of 522 | 49% [50%] of 693 | 46% [50%] of 430 |
| ar | 48% [50%] of 462 | 48% [50%] of 793 | 47% [50%] of 376 |

From open to close, 2941 lines fell, 2796 rose and 9003 stayed (14662 decided opening lines).
