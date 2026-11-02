import { makeRng } from '../lib/rng';
import { simulateGame } from './engine';
import type { SimSpec } from './types';
import { PlayerRecorder, type PlayerOutcomes } from './players';

export interface QuickResult {
  homeWin: number;
  margin: number;
  home: number;
  away: number;
}

/** Lightweight batch used for scenario sweeps (player impact rankings). */
export function runQuick(spec: SimSpec, n: number, seed: string): QuickResult {
  let w = 0, m = 0, h = 0, a = 0;
  for (let s = 0; s < n; s++) {
    const r = simulateGame(spec, makeRng(seed, s));
    if (r.score[0] > r.score[1]) w++;
    m += r.score[0] - r.score[1];
    h += r.score[0];
    a += r.score[1];
  }
  return { homeWin: w / n, margin: m / n, home: h / n, away: a / n };
}

export interface Outcomes {
  margin: Int16Array;
  total: Int16Array;
  homeWin: number;
  otPct: number;
  /** With `players`: each player's line in every simulation, for player props. */
  players?: PlayerOutcomes;
}

/** Final margin and total of every simulation, for backtests, logged predictions and the slate. */
export function runOutcomes(spec: SimSpec, n: number, seed: string, opts: { players?: boolean } = {}): Outcomes {
  const margin = new Int16Array(n), total = new Int16Array(n);
  const recorder = opts.players ? new PlayerRecorder(spec, n) : undefined;
  let w = 0, ot = 0;
  for (let s = 0; s < n; s++) {
    const r = simulateGame(spec, makeRng(seed, s));
    margin[s] = r.score[0] - r.score[1];
    total[s] = r.score[0] + r.score[1];
    if (margin[s] > 0) w++;
    if (r.ot) ot++;
    recorder?.add(s, r);
  }
  return { margin, total, homeWin: w / n, otPct: ot / n, players: recorder?.finish() };
}
