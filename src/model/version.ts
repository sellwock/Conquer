// Bump whenever simulation output changes for the same inputs. Logged predictions and cached
// backtests record it, so results from different models are never mixed.
// tests/model-version.test.ts fails when the output changes without a bump.
export const MODEL_VERSION = '1.2.0';
