import type { LeagueId } from './types';

// Bump whenever simulation output changes for the same inputs. Logged predictions and cached
// backtests record it, so results from different models are never mixed.
// tests/model-version.test.ts fails when the output changes without a bump.
export const MODEL_VERSION = '1.2.0';

/** The NFL prop model (src/model/nfl/props.ts), versioned apart from the basketball simulator. */
export const NFL_MODEL_VERSION = 'nfl-0.1.0';

/** The version of whatever prices a league's props. */
export const modelVersion = (league: LeagueId) => (league === 'nfl' ? NFL_MODEL_VERSION : MODEL_VERSION);
