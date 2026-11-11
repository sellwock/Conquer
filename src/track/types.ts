// Shapes of the prediction log (data branch, v1/). Grades are always derived from these entries,
// so a metric can change without rewriting history.
import type { LeagueId, Odds, PropStat } from '../model/types';
import type { NewsEvent } from '../model/news';

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

// --- Player props (v1/props/) ---------------------------------------------------------------------

/**
 * One posted prop line and what the simulation made of it: [athlete id, stat, line, over price,
 * under price, chance of the over, chance of a push, simulated mean, and for a live line what the
 * player had when it was saved].
 */
export type PropRow = [athleteId: string, stat: PropStat, line: number, over: number, under: number, pOver: number, pPush: number, mean: number, now?: number];

export interface PropSnap {
  model: string;
  takenAt: string;
  provider?: string;
  /** Simulations behind each chance. */
  n: number;
  rows: PropRow[];
  /** Live snapshots: the game when the lines were saved. */
  at?: { period: number; clockSec: number; home: number; away: number };
}

export interface PropEntry {
  id: string;
  league: LeagueId;
  season: number;
  tip: string;
  home: { id: string; abbr: string };
  away: { id: string; abbr: string };
  status: 'open' | 'final' | 'void';
  /** Short names of the logged players. */
  players: Record<string, string>;
  /** The first pre-game snapshot, kept as it was: the lines when the job first saw them posted. */
  open?: PropSnap;
  /** Saved before tip-off (the last refresh wins). */
  pre?: PropSnap;
  /** Saved once, mid-game, from the book's in-game feed. */
  live?: PropSnap;
  /** Saved when a player was newly ruled out before tip: one per scratched player. */
  news?: NewsSnap[];
  /** The pre-game book's lines in the last 20 minutes before tip (until model 1.2.0, only for games with news). */
  close?: { takenAt: string; lines: CloseLine[] };
  /** Each logged player's final [pts, reb, ast, tpm], or null if they didn't play (their props are void). */
  box?: Record<string, [number, number, number, number] | null>;
  gradedAt?: string;
}

export type PropLogFile = Record<string, PropEntry>;

/** [athlete id, stat, line, over price, under price] */
export type CloseLine = [athleteId: string, stat: PropStat, line: number, over: number, under: number];

/** The game's prop lines priced with a newly scratched player out, right after the news. */
export interface NewsSnap extends PropSnap {
  out: { athleteId: string; name: string; status: string; since?: string; minutes: number };
  /** Each row's simulated mean had he played, in row order. */
  meanWith: number[];
}

/** v1/injuries/{league}.json: the last report the job saw, and recent news it found. */
export interface InjuryLog {
  updatedAt: string;
  players: Record<string, { status: string; out: boolean; since?: string; team: string }>;
  events: (NewsEvent & { seenAt: string })[];
}
