// Shapes of the prediction log (data branch, v1/). Grades are always derived from these entries,
// so a metric can change without rewriting history.
import type { LeagueId, Odds } from '../model/types';

/** A discrete distribution over integers: [lowest value, probabilities from there up]. */
export type Pmf = [lo: number, probs: number[]];

export type LoggedOdds = Odds & { fetchedAt: string };

export interface Prediction {
  model: string;
  takenAt: string;
  minsToTip: number;
  n: number;
  homeWin: number;
  meanMargin: number;
  meanTotal: number;
  otPct: number;
  marginPmf: Pmf;
  totalPmf: Pmf;
  /** Players the model treated as out. */
  outs: string[];
}

export interface Entry {
  id: string;
  league: LeagueId;
  season: number;
  tip: string;
  home: { id: string; abbr: string };
  away: { id: string; abbr: string };
  neutral: boolean;
  status: 'open' | 'final' | 'void';
  pred?: Prediction;
  /** The line when the prediction was taken. */
  line?: LoggedOdds;
  /** What ESPN reports after the game; usually the closing line. */
  closeReported?: LoggedOdds;
  result?: { home: number; away: number; ot: boolean; gradedAt: string };
}

export type LogFile = Record<string, Entry>;
