// Plain, structured-clone-friendly inputs and outputs of the simulator.
import type { LeagueConfig } from '../model/leagues';
import type { PosGroup } from '../model/types';

export interface SimPlayer {
  id: string;
  name: string;
  short: string;
  group: PosGroup;
  starter: boolean;
  /** Projected regulation minutes; 0 means unavailable. */
  targetMin: number;
  /** Share of team possessions this player ends while on the floor (usage rate). */
  usage: number;
  /** Given the player ends the possession: turnover / shooting-foul trip probabilities. FGA is the rest. */
  pTO: number;
  pTrip: number;
  /** Cumulative shot-zone shares (rim, paint, mid, c3, ab3). */
  zoneCum: number[];
  zonePct: number[];
  ft: number;
  /** Multiplier on the league assisted rate for this player's makes. */
  assistedFactor: number;
  /** Per-minute rates. */
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  pf: number;
  /** Passing network: relative weight of this player assisting teammate j. */
  assistTo: number[];
  initFouls: number;
  initSec: number;
}

export interface SimTeam {
  id: string;
  abbr: string;
  name: string;
  players: SimPlayer[];
  /** Multiplier on own make probabilities (home court x team calibration). */
  makeMult: number;
  /** Multiplier on the opponent's make probability by zone. */
  zoneDefMult: number[];
  /** Multiplier on the opponent's turnover probability. */
  toForce: number;
}

export interface SimStart {
  period: number;
  clockSec: number;
  homeScore: number;
  awayScore: number;
  prior?: [number, number][];
  periodStart?: [number, number];
}

export interface SimSpec {
  league: LeagueConfig;
  home: SimTeam;
  away: SimTeam;
  /** Expected possessions per team over a regulation game. */
  pace: number;
  /** Referee whistle multiplier (1 = league average). */
  whistle: number;
  start?: SimStart;
}

export const BOX_FIELDS = ['sec', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf'] as const;
export type BoxField = (typeof BOX_FIELDS)[number];
export const BF: Record<BoxField, number> = Object.fromEntries(BOX_FIELDS.map((f, i) => [f, i])) as Record<BoxField, number>;
export const NBF = BOX_FIELDS.length;

export interface LogEvent {
  period: number;
  clockSec: number;
  team: 0 | 1 | -1; // 0 home, 1 away, -1 neutral
  text: string;
  home: number;
  away: number;
  pts: number;
  /** Set on the scoring play that extends a run to >= 8 unanswered points. */
  run?: number;
}

export interface GameResult {
  score: [number, number];
  periodScores: [number, number][];
  ot: number;
  /** Per team, flat [player * NBF + field]. */
  box: [Float64Array, Float64Array];
  maxRun: [number, number];
  leadChanges: number;
  largestLead: [number, number];
  fouledOut: [number[], number[]];
  possessions: [number, number];
  log?: LogEvent[];
}
