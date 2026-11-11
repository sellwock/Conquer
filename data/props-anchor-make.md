## Props backtest, NBA: 169 games, 14681 decided closing lines, 1000 sims per game (model 1.2.0)

Games by month: 2026-01 12, 2026-10 81, 2026-11 76. Left out: 225 no prop lines kept.

### The pick model, each day scored by a fit of earlier days (picks need 3% expected return)

- **With the simulation:** 14681 lines, 168 games. Coefficients [constant, book, simulation's disagreement]: -0.0295, 0.9835, 0.1275
  - At the close: 136-116 (54.0% won, fit said 55.3%), 3.7% per bet (-8.3% to 16.0%), 97% unders · Brier fit 0.2475 vs book 0.2480 (-0.0014 to 0.0004) · 146 games, 19 days · close moved toward 0, away 0, same 252
  - At the open: 168-122 (57.9% won, fit said 55.3%), 10.6% per bet (0.2% to 21.6%), 97% unders · Brier fit 0.2461 vs book 0.2475 (-0.0022 to -0.0005) · 146 games, 19 days · close moved toward 176, away 85, same 29
- **Book's odds only:** 14681 lines, 168 games. Coefficients [constant, book, simulation's disagreement]: -0.0946, 0.9833, 0
  - At the close: 3-16 (15.8% won, fit said 41.5%), -60.2% per bet (-100.0% to -3.4%), 100% unders · Brier fit 0.2477 vs book 0.2480 (-0.0010 to 0.0004) · 146 games, 19 days · close moved toward 0, away 0, same 19
  - At the open: 4-13 (23.5% won, fit said 40.8%), -37.5% per bet (-100.0% to 36.7%), 100% unders · Brier fit 0.2470 vs book 0.2475 (-0.0011 to 0.0002) · 146 games, 19 days · close moved toward 7, away 8, same 2

Simulation alone on every closing line: Brier 0.2667 vs the book's 0.2480. Its average score sat 0.7 points from the book's spread and 1.1 from its total (root mean square, 169 games). Anchored to the book's spread and total in 169 games (pace share 0).

### Flat bets, no model (record, return per bet, 95% range by game)

| Rule | At the close | At the open |
|---|---|---|
| Every under | 7745-6936 (52.8%), -1.9% per bet (-4.8% to 1.0%) | 7783-6898 (53.0%), -1.4% per bet (-4.3% to 1.6%) |
| Every over | 6936-7745 (47.2%), -10.7% per bet (-13.6% to -7.8%) | 6898-7783 (47.0%), -11.4% per bet (-14.4% to -8.3%) |
| Unders on small scoring lines (under 80% of typical) | 1192-1037 (53.5%), 0.5% per bet (-5.0% to 6.3%) | 1177-1047 (52.9%), -0.5% per bet (-5.9% to 5.2%) |
| Unders on small other lines | 1094-1063 (50.7%), -4.2% per bet (-8.9% to 0.4%) | 1077-1084 (49.8%), -5.6% per bet (-10.2% to -1.1%) |
| Unders on points lines under 12 | 518-452 (53.4%), 0.9% per bet (-4.3% to 6.0%) | 515-462 (52.7%), -0.2% per bet (-5.5% to 5.0%) |
| Overs on points lines of 24 or more | 66-87 (43.1%), -18.3% per bet (-33.4% to -4.0%) | 57-87 (39.6%), -25.3% per bet (-39.9% to -11.0%) |
| The simulation's side when it disagrees by 15+ points of chance | 3252-2756 (54.1%), 1.3% per bet (-3.2% to 5.8%) | 3443-2664 (56.4%), 5.3% per bet (1.1% to 9.8%) |

### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)

| Stat | Small lines | Typical | Large lines |
|---|---|---|---|
| pts | 48% [50%] of 635 | 46% [50%] of 809 | 50% [50%] of 729 |
| reb | 49% [50%] of 814 | 50% [49%] of 664 | 47% [49%] of 573 |
| ast | 50% [50%] of 685 | 44% [49%] of 525 | 44% [49%] of 397 |
| tpm | 52% [56%] of 196 | 46% [47%] of 1058 | 48% [47%] of 527 |
| pra | 43% [50%] of 487 | 47% [50%] of 867 | 46% [50%] of 376 |
| pr | 48% [50%] of 583 | 46% [50%] of 948 | 47% [50%] of 529 |
| pa | 46% [50%] of 524 | 49% [50%] of 693 | 46% [50%] of 430 |
| ar | 48% [50%] of 462 | 48% [50%] of 794 | 47% [50%] of 376 |

From open to close, 2946 lines fell, 2798 rose and 9015 stayed (14681 decided opening lines).
