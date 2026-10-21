import { makeRng } from '../lib/rng';
import { simulateGame } from './engine';
import type { SimSpec } from './types';

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
