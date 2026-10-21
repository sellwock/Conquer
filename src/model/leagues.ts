import type { LeagueId, Zone } from './types';

export interface LeagueConfig {
  id: LeagueId;
  label: string;
  espnPath: string; // segment under /sports/basketball/
  periods: number;
  periodSec: number;
  otSec: number;
  shotClock: number;
  orebShotClock: number;
  foulOut: number;
  /** Team fouls in a period before the bonus. NCAA: one-and-one at 7, double bonus at 10. */
  bonusAt: number;
  doubleBonusAt?: number;
  rosterMinutes: number; // 5 * regulation minutes
  playerMinCap: number;
  homeAdvPts: number;
  pace: number; // possessions per team per regulation game
  /** Plays (FGA + 0.44 FTA + TOV) per possession; offensive rebounds make it exceed 1. */
  playsPerPoss: number;
  ppp: number; // points per possession
  ftPct: number;
  orebPct: number;
  ftOrebPct: number;
  tovPct: number;
  /** League shot profile: share of FGA and FG% by zone. */
  zoneShare: Record<Zone, number>;
  zonePct: Record<Zone, number>;
  /** Share of made FGs that are assisted, by zone. */
  assisted: Record<Zone, number>;
  /** Defensive non-shooting fouls per defensive possession. */
  nonShootFoul: number;
  /** Share of FT trips that come from the bonus rather than shooting fouls. */
  bonusTripShare: number;
  /** Per-minute priors by position group for counting stats. */
  priors: Record<'G' | 'F' | 'C', { oreb: number; dreb: number; ast: number; stl: number; blk: number; pf: number; usage: number }>;
  intentionalFoulWindow: number; // seconds
  blowout: number; // margin that triggers garbage time late
}

const per36 = (v: number) => v / 36;
const per40 = (v: number) => v / 40;

export const LEAGUES: Record<LeagueId, LeagueConfig> = {
  nba: {
    id: 'nba',
    label: 'NBA',
    espnPath: 'nba',
    periods: 4,
    periodSec: 720,
    otSec: 300,
    shotClock: 24,
    orebShotClock: 14,
    foulOut: 6,
    bonusAt: 5,
    rosterMinutes: 240,
    playerMinCap: 40,
    homeAdvPts: 2.2,
    pace: 99.5,
    playsPerPoss: 1.12,
    ppp: 1.145,
    ftPct: 0.785,
    orebPct: 0.245,
    ftOrebPct: 0.13,
    tovPct: 0.13,
    zoneShare: { rim: 0.3, paint: 0.13, mid: 0.13, c3: 0.1, ab3: 0.34 },
    zonePct: { rim: 0.665, paint: 0.44, mid: 0.425, c3: 0.385, ab3: 0.356 },
    assisted: { rim: 0.52, paint: 0.36, mid: 0.33, c3: 0.95, ab3: 0.8 },
    nonShootFoul: 0.085,
    bonusTripShare: 0.2,
    priors: {
      G: { oreb: per36(0.7), dreb: per36(3.3), ast: per36(4.8), stl: per36(1.15), blk: per36(0.3), pf: per36(2.3), usage: 0.2 },
      F: { oreb: per36(1.3), dreb: per36(5.0), ast: per36(2.7), stl: per36(1.0), blk: per36(0.6), pf: per36(2.6), usage: 0.18 },
      C: { oreb: per36(2.9), dreb: per36(7.6), ast: per36(2.3), stl: per36(0.8), blk: per36(1.5), pf: per36(3.2), usage: 0.17 },
    },
    intentionalFoulWindow: 45,
    blowout: 20,
  },
  ncaam: {
    id: 'ncaam',
    label: "Men's college",
    espnPath: 'mens-college-basketball',
    periods: 2,
    periodSec: 1200,
    otSec: 300,
    shotClock: 30,
    orebShotClock: 20,
    foulOut: 5,
    bonusAt: 7,
    doubleBonusAt: 10,
    rosterMinutes: 200,
    playerMinCap: 38,
    homeAdvPts: 3.0,
    pace: 68,
    playsPerPoss: 1.16,
    ppp: 1.04,
    ftPct: 0.715,
    orebPct: 0.29,
    ftOrebPct: 0.14,
    tovPct: 0.165,
    zoneShare: { rim: 0.33, paint: 0.1, mid: 0.17, c3: 0.08, ab3: 0.32 },
    zonePct: { rim: 0.6, paint: 0.4, mid: 0.37, c3: 0.36, ab3: 0.33 },
    assisted: { rim: 0.45, paint: 0.3, mid: 0.3, c3: 0.92, ab3: 0.78 },
    nonShootFoul: 0.1,
    bonusTripShare: 0.15,
    priors: {
      G: { oreb: per40(0.8), dreb: per40(2.8), ast: per40(3.2), stl: per40(1.3), blk: per40(0.3), pf: per40(2.5), usage: 0.2 },
      F: { oreb: per40(1.6), dreb: per40(4.2), ast: per40(1.8), stl: per40(1.1), blk: per40(0.7), pf: per40(2.8), usage: 0.19 },
      C: { oreb: per40(2.8), dreb: per40(5.6), ast: per40(1.2), stl: per40(0.8), blk: per40(1.6), pf: per40(3.4), usage: 0.18 },
    },
    intentionalFoulWindow: 60,
    blowout: 18,
  },
};

export const regulationSec = (lg: LeagueConfig) => lg.periods * lg.periodSec;
