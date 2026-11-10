## Props backtest, NBA: 163 games, 13954 decided closing lines, 1000 sims per game (model 1.2.0, with usagePriorMin=120 ratePriorMin=180 minutesNoise=0 creationPriorMin=120)

Games by month: 2026-01 12, 2026-10 81, 2026-11 70. Left out: 225 no prop lines kept.

### The pick model, each day scored by a fit of earlier days (picks need 3% expected return)

- **With the simulation:** 13954 lines, 162 games. Coefficients [constant, book, simulation's disagreement, line size]: -0.0382, 1.0197, 0.099, 0.1029
  - At the close: 174-158 (52.4% won, fit said 55.5%), 0.3% per bet (-9.8% to 10.8%), 92% unders · Brier fit 0.2477 vs book 0.2479 (-0.0012 to 0.0007) · 140 games, 18 days · close moved toward 0, away 0, same 332
  - At the open: 196-143 (57.8% won, fit said 55.2%), 10.9% per bet (-0.0% to 21.7%), 93% unders · Brier fit 0.2465 vs book 0.2475 (-0.0021 to -0.0002) · 140 games, 18 days · close moved toward 192, away 109, same 38
- **Book's odds and line size only:** 13954 lines, 162 games. Coefficients [constant, book, simulation's disagreement, line size]: -0.0868, 0.9961, 0, 0.0046
  - At the close: 77-84 (47.8% won, fit said 53.7%), -7.9% per bet (-21.5% to 5.3%), 96% unders · Brier fit 0.2479 vs book 0.2479 (-0.0009 to 0.0008) · 140 games, 18 days · close moved toward 0, away 0, same 161
  - At the open: 84-80 (51.2% won, fit said 53.7%), -0.6% per bet (-15.2% to 13.9%), 98% unders · Brier fit 0.2472 vs book 0.2475 (-0.0012 to 0.0004) · 140 games, 18 days · close moved toward 77, away 59, same 28

### Flat bets, no model (record, return per bet, 95% range by game)

| Rule | At the close | At the open |
|---|---|---|
| Every under | 7333-6621 (52.6%), -2.3% per bet (-5.2% to 0.8%) | 7371-6583 (52.8%), -1.7% per bet (-4.9% to 1.5%) |
| Every over | 6621-7333 (47.4%), -10.3% per bet (-13.5% to -7.3%) | 6583-7371 (47.2%), -11.0% per bet (-14.3% to -7.8%) |
| Unders on small scoring lines (under 80% of typical) | 1097-945 (53.7%), 1.0% per bet (-5.1% to 6.8%) | 1081-955 (53.1%), -0.2% per bet (-5.7% to 5.2%) |
| Unders on small other lines | 1029-999 (50.7%), -4.2% per bet (-8.8% to 0.8%) | 1011-1017 (49.9%), -5.5% per bet (-10.5% to -0.9%) |
| Unders on points lines under 12 | 483-416 (53.7%), 1.6% per bet (-3.9% to 6.9%) | 479-427 (52.9%), 0.1% per bet (-5.3% to 5.9%) |
| Overs on points lines of 24 or more | 63-83 (43.2%), -18.3% per bet (-33.4% to -2.5%) | 57-82 (41.0%), -22.6% per bet (-37.0% to -7.4%) |
| The simulation's side when it disagrees by 15+ points of chance | 3347-2994 (52.8%), -1.4% per bet (-5.9% to 3.1%) | 3535-2896 (55.0%), 2.5% per bet (-1.6% to 6.7%) |

### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)

| Stat | Small lines | Typical | Large lines |
|---|---|---|---|
| pts | 47% [50%] of 575 | 47% [50%] of 778 | 50% [50%] of 703 |
| reb | 49% [50%] of 766 | 50% [49%] of 634 | 47% [49%] of 548 |
| ast | 50% [50%] of 649 | 45% [49%] of 505 | 46% [49%] of 380 |
| tpm | 51% [56%] of 179 | 46% [47%] of 1008 | 47% [47%] of 504 |
| pra | 44% [50%] of 445 | 47% [50%] of 837 | 47% [50%] of 363 |
| pr | 47% [50%] of 535 | 46% [50%] of 910 | 48% [50%] of 510 |
| pa | 46% [50%] of 487 | 49% [50%] of 664 | 46% [50%] of 418 |
| ar | 48% [50%] of 434 | 48% [50%] of 758 | 47% [50%] of 364 |

From open to close, 2827 lines fell, 2644 rose and 8561 stayed (13954 decided opening lines).
