// When in a game the live pick model's record applies. The scheduled job logs each game's in-game
// lines at set points (src/track/job.ts), and the live fit trains and is tested on the lines from
// a quarter of regulation played to three quarters. Lines outside that stretch are logged too, and
// scored apart, so the site can say when a pick comes from a part of the game the record hasn't
// tested.
import { LEAGUES } from './leagues';
import type { LeagueId } from './types';

/** The tested stretch: NBA 2nd and 3rd quarters; college 10:00 left in the 1st half to 10:00 left in the 2nd. */
export const LIVE_FROM = 0.25;
export const LIVE_TO = 0.75;
/** The early and late looks: after the opening minutes, and before garbage time. */
export const EARLY_FROM = 0.08;
export const LATE_TO = 0.92;

/** Share of regulation played; 1 once in overtime. */
export function playedShare(league: LeagueId, period: number, clockSec: number): number {
  const L = LEAGUES[league];
  if (period > L.periods) return 1;
  return ((Math.max(1, period) - 1) * L.periodSec + (L.periodSec - clockSec)) / (L.periods * L.periodSec);
}

/** Where a game is against the live record: before the tested stretch, in it, or after it. */
export type LiveStage = 'early' | 'tested' | 'late';

export function liveStage(league: LeagueId, period: number, clockSec: number): LiveStage {
  const x = playedShare(league, period, clockSec);
  return x < LIVE_FROM ? 'early' : x < LIVE_TO ? 'tested' : 'late';
}

/** A live market's stage; one without a game clock counts as tested, as every live market did before. */
export const stageOf = (m: { league: LeagueId; clock?: { period: number; clockSec: number } }): LiveStage =>
  m.clock ? liveStage(m.league, m.clock.period, m.clock.clockSec) : 'tested';
