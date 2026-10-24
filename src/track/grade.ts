// Grades logged predictions against results and the market. Pure functions only.
import { makeRng } from '../lib/rng';
import { impliedFromAmerican } from '../lib/stats';
import type { Odds } from '../model/types';
import type { Entry, Pmf } from './types';

const DEFAULT_PRICE = -110;

// --- Distributions ---------------------------------------------------------------------------------

/** Turns integer counts (min..max) into a trimmed, rounded pmf. */
export function pmfFromCounts(min: number, counts: ArrayLike<number>): Pmf {
  let total = 0;
  for (let i = 0; i < counts.length; i++) total += counts[i];
  let lo = 0, hi = counts.length - 1;
  while (lo < hi && !counts[lo]) lo++;
  while (hi > lo && !counts[hi]) hi--;
  const probs: number[] = [];
  for (let i = lo; i <= hi; i++) probs.push(total ? Math.round((counts[i] / total) * 1e5) / 1e5 : 0);
  return [min + lo, probs];
}

/** Pmf of a list of integer outcomes (one per simulation). */
export function pmfFromValues(values: ArrayLike<number>): Pmf {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  if (!Number.isFinite(min)) return [0, []];
  const counts = new Float64Array(max - min + 1);
  for (let i = 0; i < values.length; i++) counts[values[i] - min]++;
  return pmfFromCounts(min, counts);
}

export function pmfProb(p: Pmf, test: (v: number) => boolean): number {
  const [lo, probs] = p;
  let s = 0;
  for (let i = 0; i < probs.length; i++) if (test(lo + i)) s += probs[i];
  return s;
}

export function pmfMean(p: Pmf): number {
  const [lo, probs] = p;
  let s = 0, w = 0;
  for (let i = 0; i < probs.length; i++) {
    s += (lo + i) * probs[i];
    w += probs[i];
  }
  return w ? s / w : 0;
}

/** Market's no-vig home win chance from the moneylines. */
export function marketHomeWin(o?: Odds): number | undefined {
  if (o?.homeML == null || o.awayML == null) return undefined;
  const h = impliedFromAmerican(o.homeML), a = impliedFromAmerican(o.awayML);
  return h / (h + a);
}

const toDecimal = (american: number) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);

// --- One game ----------------------------------------------------------------------------------------

export type BetResult = 'win' | 'loss' | 'push';

export interface Graded {
  id: string;
  league: string;
  tip: string;
  model: string;
  pHome: number;
  homeWon: 0 | 1;
  pMarket?: number;
  /** Against the spread: the side the model favors at the logged line. */
  ats?: { pick: 'home' | 'away'; pCover: number; result: BetResult; price: number; line: number };
  ou?: { pick: 'over' | 'under'; pOver: number; result: BetResult; price: number; line: number };
  marginError: number;
  totalError: number;
  /** Points of closing-line value on the spread pick (positive = the line moved toward the model). */
  clv?: number;
}

const settle = (v: number): BetResult => (v > 0 ? 'win' : v < 0 ? 'loss' : 'push');

export function gradeEntry(e: Entry): Graded | null {
  if (e.status !== 'final' || !e.pred || !e.result) return null;
  const p = e.pred;
  const margin = e.result.home - e.result.away;
  const total = e.result.home + e.result.away;
  const g: Graded = {
    id: e.id,
    league: e.league,
    tip: e.tip,
    model: p.model,
    pHome: p.homeWin,
    homeWon: margin > 0 ? 1 : 0,
    pMarket: marketHomeWin(e.line),
    marginError: p.meanMargin - margin,
    totalError: p.meanTotal - total,
  };
  const line = e.line;
  if (line?.spread != null) {
    const L = line.spread;
    const cover = pmfProb(p.marginPmf, (m) => m + L > 0);
    const push = pmfProb(p.marginPmf, (m) => m + L === 0);
    const pCover = cover / Math.max(1e-9, 1 - push);
    const pick = pCover >= 0.5 ? 'home' : 'away';
    const price = (pick === 'home' ? line.homeSpreadOdds : line.awaySpreadOdds) ?? DEFAULT_PRICE;
    g.ats = { pick, pCover: pick === 'home' ? pCover : 1 - pCover, result: settle(pick === 'home' ? margin + L : -(margin + L)), price, line: L };
    const close = e.closeReported?.spread;
    if (close != null) g.clv = pick === 'home' ? L - close : close - L;
  }
  if (line?.total != null) {
    const T = line.total;
    const over = pmfProb(p.totalPmf, (t) => t > T);
    const push = pmfProb(p.totalPmf, (t) => t === T);
    const pOver = over / Math.max(1e-9, 1 - push);
    const pick = pOver >= 0.5 ? 'over' : 'under';
    const price = (pick === 'over' ? line.overOdds : line.underOdds) ?? DEFAULT_PRICE;
    g.ou = { pick, pOver: pick === 'over' ? pOver : 1 - pOver, result: settle(pick === 'over' ? total - T : T - total), price, line: T };
  }
  return g;
}

// --- Many games --------------------------------------------------------------------------------------

export interface Record3 {
  win: number;
  loss: number;
  push: number;
  /** Profit in units staking 1 unit at the listed price on every pick. Hypothetical. */
  units: number;
}

export interface Summary {
  n: number;
  straightUp: { correct: number; n: number };
  ats: Record3;
  ou: Record3;
  brier: number;
  logLoss: number;
  /** Paired difference on games with a moneyline: model Brier minus market Brier (negative = model better). */
  vsMarket?: { n: number; model: number; market: number; diff: number; lo: number; hi: number };
  calibration: { lo: number; hi: number; n: number; meanP: number; rate: number }[];
  marginMAE: number;
  totalMAE: number;
  clv?: { n: number; mean: number };
}

function record(items: { result: BetResult; price: number }[]): Record3 {
  const r: Record3 = { win: 0, loss: 0, push: 0, units: 0 };
  for (const x of items) {
    r[x.result]++;
    if (x.result === 'win') r.units += toDecimal(x.price) - 1;
    else if (x.result === 'loss') r.units -= 1;
  }
  return r;
}

/** Mean and 95% bootstrap interval of `values`. */
export function bootstrapMean(values: number[], resamples = 1000, seed = 'grade'): { mean: number; lo: number; hi: number } {
  const n = values.length;
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  if (n < 2) return { mean, lo: mean, hi: mean };
  const rng = makeRng(seed, n);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(resamples * 0.025)], hi: means[Math.ceil(resamples * 0.975) - 1] };
}

export function summarize(graded: Graded[], bins = 10): Summary {
  const n = graded.length;
  const clamp = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
  const brier = n ? graded.reduce((s, g) => s + (g.pHome - g.homeWon) ** 2, 0) / n : 0;
  const logLoss = n ? -graded.reduce((s, g) => s + (g.homeWon ? Math.log(clamp(g.pHome)) : Math.log(1 - clamp(g.pHome))), 0) / n : 0;

  const paired = graded.filter((g) => g.pMarket != null);
  let vsMarket: Summary['vsMarket'];
  if (paired.length) {
    const diffs = paired.map((g) => (g.pHome - g.homeWon) ** 2 - (g.pMarket! - g.homeWon) ** 2);
    const b = bootstrapMean(diffs);
    vsMarket = {
      n: paired.length,
      model: paired.reduce((s, g) => s + (g.pHome - g.homeWon) ** 2, 0) / paired.length,
      market: paired.reduce((s, g) => s + (g.pMarket! - g.homeWon) ** 2, 0) / paired.length,
      diff: b.mean,
      lo: b.lo,
      hi: b.hi,
    };
  }

  const calibration = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanP: 0, rate: 0 }));
  for (const g of graded) {
    const b = calibration[Math.min(bins - 1, Math.floor(g.pHome * bins))];
    b.n++;
    b.meanP += g.pHome;
    b.rate += g.homeWon;
  }
  for (const b of calibration) if (b.n) (b.meanP /= b.n), (b.rate /= b.n);

  const clvs = graded.filter((g) => g.clv != null).map((g) => g.clv!);
  return {
    n,
    straightUp: { correct: graded.filter((g) => (g.pHome >= 0.5 ? 1 : 0) === g.homeWon).length, n },
    ats: record(graded.flatMap((g) => (g.ats ? [g.ats] : []))),
    ou: record(graded.flatMap((g) => (g.ou ? [g.ou] : []))),
    brier,
    logLoss,
    vsMarket,
    calibration,
    marginMAE: n ? graded.reduce((s, g) => s + Math.abs(g.marginError), 0) / n : 0,
    totalMAE: n ? graded.reduce((s, g) => s + Math.abs(g.totalError), 0) / n : 0,
    clv: clvs.length ? { n: clvs.length, mean: clvs.reduce((a, b) => a + b, 0) / clvs.length } : undefined,
  };
}
