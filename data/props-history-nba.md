## Props backtest, NBA: 164 games, 14074 decided closing lines, 1000 sims per game (model 1.2.0)

Games by month: 2026-01 12, 2026-03 1, 2026-10 81, 2026-11 70. Left out: 113 another book (ESPN BET); 926 no prop lines kept.

### The pick model, each day scored by a fit of earlier days (picks need 3% expected return)

- **With the simulation:** 14074 lines, 163 games. Coefficients [constant, book, simulation's disagreement, line size]: -0.0238, 1.0077, 0.1354, 0.0773
  - At the close: 178-142 (55.6% won, fit said 54.7%), 7.8% per bet (-1.5% to 16.7%), 94% unders · Brier fit 0.2476 vs book 0.2479 (-0.0012 to 0.0006) · 140 games, 18 days · close moved toward 0, away 0, same 320
  - At the open: 197-148 (57.1% won, fit said 54.7%), 10.2% per bet (0.9% to 20.1%), 95% unders · Brier fit 0.2462 vs book 0.2475 (-0.0022 to -0.0004) · 140 games, 18 days · close moved toward 201, away 102, same 42
- **Book's odds and line size only:** 14074 lines, 163 games. Coefficients [constant, book, simulation's disagreement, line size]: -0.0894, 0.9897, 0, 0.0054
  - At the close: 75-82 (47.8% won, fit said 53.6%), -7.5% per bet (-21.8% to 5.2%), 99% unders · Brier fit 0.2479 vs book 0.2479 (-0.0009 to 0.0008) · 140 games, 18 days · close moved toward 0, away 0, same 157
  - At the open: 84-82 (50.6% won, fit said 53.2%), -1.0% per bet (-16.5% to 13.9%), 99% unders · Brier fit 0.2471 vs book 0.2475 (-0.0012 to 0.0004) · 140 games, 18 days · close moved toward 81, away 59, same 26

### Flat bets, no model (record, return per bet, 95% range by game)

| Rule | At the close | At the open |
|---|---|---|
| Every under | 7406-6668 (52.6%), -2.1% per bet (-5.1% to 0.8%) | 7446-6628 (52.9%), -1.6% per bet (-4.6% to 1.4%) |
| Every over | 6668-7406 (47.4%), -10.5% per bet (-13.5% to -7.4%) | 6628-7446 (47.1%), -11.2% per bet (-14.3% to -8.0%) |
| Unders on small scoring lines (under 80% of typical) | 1132-968 (53.9%), 1.4% per bet (-4.1% to 7.0%) | 1117-978 (53.3%), 0.3% per bet (-5.4% to 5.7%) |
| Unders on small other lines | 1042-1011 (50.8%), -4.2% per bet (-8.8% to 0.5%) | 1026-1027 (50.0%), -5.3% per bet (-10.1% to -0.4%) |
| Unders on points lines under 12 | 498-426 (53.9%), 1.9% per bet (-3.5% to 7.5%) | 495-436 (53.2%), 0.6% per bet (-4.9% to 6.0%) |
| Overs on points lines of 24 or more | 63-83 (43.2%), -18.3% per bet (-33.4% to -2.5%) | 57-82 (41.0%), -22.6% per bet (-37.0% to -7.4%) |
| The simulation's side when it disagrees by 15+ points of chance | 3036-2606 (53.8%), 0.7% per bet (-3.7% to 5.2%) | 3211-2547 (55.8%), 4.1% per bet (-0.4% to 8.7%) |

### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)

| Stat | Small lines | Typical | Large lines |
|---|---|---|---|
| pts | 47% [50%] of 598 | 47% [50%] of 783 | 50% [50%] of 703 |
| reb | 49% [50%] of 778 | 50% [49%] of 639 | 47% [49%] of 552 |
| ast | 50% [50%] of 653 | 45% [49%] of 507 | 46% [49%] of 380 |
| tpm | 51% [56%] of 184 | 46% [47%] of 1019 | 47% [47%] of 504 |
| pra | 43% [50%] of 454 | 47% [50%] of 839 | 47% [50%] of 363 |
| pr | 48% [50%] of 555 | 46% [50%] of 912 | 48% [50%] of 511 |
| pa | 46% [50%] of 493 | 49% [50%] of 666 | 46% [50%] of 418 |
| ar | 48% [50%] of 438 | 48% [50%] of 760 | 47% [50%] of 365 |

From open to close, 2839 lines fell, 2657 rose and 8656 stayed (14074 decided opening lines).
