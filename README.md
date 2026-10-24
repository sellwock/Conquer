# Conquer prediction log

Written by `.github/workflows/forward.yml` on `main`. Do not edit by hand.

- `v1/{league}/{season}/{yyyy-mm}.json`: one entry per game, keyed by ESPN event id. Each holds the
  prediction saved before tip-off (`pred`, with the model version), the line at that moment, and,
  once the game ends, the result and the line ESPN reports afterwards.
- `v1/results/{league}/{season}.json`: every final score, `[yyyymmdd, homeId, awayId, homeScore, awayScore, neutral, overtime]`.
- `v1/status.json`: the last run's time, model version and counts. Written every run.

Predictions are never changed after tip-off and never backfilled.
