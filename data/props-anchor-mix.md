## Props backtest, NBA: 169 games, 14688 decided closing lines, 1000 sims per game (model 1.2.0)

Games by month: 2026-01 12, 2026-10 81, 2026-11 76. Left out: 225 no prop lines kept.

### The pick model, each day scored by a fit of earlier days (picks need 3% expected return)

- **With the simulation:** 14688 lines, 168 games. Coefficients [constant, book, simulation's disagreement]: -0.0283, 0.9805, 0.1304
  - At the close: 141-126 (52.8% won, fit said 55.3%), 1.7% per bet (-9.0% to 12.3%), 97% unders · Brier fit 0.2474 vs book 0.2480 (-0.0014 to 0.0004) · 146 games, 19 days · close moved toward 0, away 0, same 267
  - At the open: 176-137 (56.2% won, fit said 55.1%), 8.2% per bet (-1.9% to 17.6%), 96% unders · Brier fit 0.2461 vs book 0.2475 (-0.0023 to -0.0006) · 146 games, 19 days · close moved toward 187, away 92, same 34
- **Book's odds only:** 14688 lines, 168 games. Coefficients [constant, book, simulation's disagreement]: -0.0954, 0.9803, 0
  - At the close: 3-16 (15.8% won, fit said 41.5%), -60.2% per bet (-100.0% to -4.6%), 100% unders · Brier fit 0.2477 vs book 0.2480 (-0.0009 to 0.0004) · 146 games, 19 days · close moved toward 0, away 0, same 19
  - At the open: 5-14 (26.3% won, fit said 41.1%), -31.8% per bet (-84.9% to 21.4%), 100% unders · Brier fit 0.2470 vs book 0.2475 (-0.0012 to 0.0002) · 146 games, 19 days · close moved toward 9, away 8, same 2

Simulation alone on every closing line: Brier 0.2667 vs the book's 0.2480. Its average score sat 0.7 points from the book's spread and 1.0 from its total (root mean square, 169 games). Anchored to the book's spread and total in 169 games (pace share 0.5).

### Flat bets, no model (record, return per bet, 95% range by game)

| Rule | At the close | At the open |
|---|---|---|
| Every under | 7752-6936 (52.8%), -1.9% per bet (-4.8% to 1.0%) | 7790-6898 (53.0%), -1.3% per bet (-4.3% to 1.6%) |
| Every over | 6936-7752 (47.2%), -10.7% per bet (-13.7% to -7.7%) | 6898-7790 (47.0%), -11.4% per bet (-14.4% to -8.3%) |
| Unders on small scoring lines (under 80% of typical) | 1194-1037 (53.5%), 0.6% per bet (-5.2% to 6.0%) | 1179-1047 (53.0%), -0.4% per bet (-6.1% to 4.7%) |
| Unders on small other lines | 1096-1062 (50.8%), -4.2% per bet (-8.6% to 0.4%) | 1079-1083 (49.9%), -5.5% per bet (-10.4% to -0.8%) |
| Unders on points lines under 12 | 518-452 (53.4%), 0.9% per bet (-4.3% to 5.9%) | 515-462 (52.7%), -0.2% per bet (-5.4% to 5.0%) |
| Overs on points lines of 24 or more | 66-87 (43.1%), -18.3% per bet (-33.4% to -4.0%) | 57-87 (39.6%), -25.3% per bet (-39.9% to -11.0%) |
| The simulation's side when it disagrees by 15+ points of chance | 3282-2742 (54.5%), 1.9% per bet (-2.5% to 6.4%) | 3467-2681 (56.4%), 5.3% per bet (1.1% to 9.6%) |

### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)

| Stat | Small lines | Typical | Large lines |
|---|---|---|---|
| pts | 48% [50%] of 635 | 46% [50%] of 810 | 50% [50%] of 729 |
| reb | 49% [50%] of 813 | 50% [49%] of 664 | 47% [49%] of 574 |
| ast | 50% [50%] of 686 | 44% [49%] of 525 | 44% [49%] of 397 |
| tpm | 52% [56%] of 196 | 46% [47%] of 1059 | 48% [47%] of 527 |
| pra | 43% [50%] of 488 | 47% [50%] of 867 | 46% [50%] of 376 |
| pr | 48% [50%] of 583 | 46% [50%] of 949 | 47% [50%] of 529 |
| pa | 46% [50%] of 525 | 49% [50%] of 693 | 46% [50%] of 430 |
| ar | 48% [50%] of 463 | 48% [50%] of 794 | 47% [50%] of 376 |

From open to close, 2949 lines fell, 2798 rose and 9019 stayed (14688 decided opening lines).
