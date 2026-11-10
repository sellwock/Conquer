// The chance a prop's over wins, as fitted to the forward log (src/track/fit.ts): a small logistic
// model of the book's own odds, how far the simulation disagrees with them, and how big the line
// is. This file is the model's shape only, with no data, so pricing and training share it.
import type { PropStat } from './types';

/** A typical posted line per stat (the log's medians, November 2026); a line's size is measured against it. */
export const REF_LINE: Record<PropStat, number> = { pts: 12.5, reb: 4.5, ast: 3.5, tpm: 1.5, pra: 23.5, pr: 18.5, pa: 18.5, ar: 8.5 };

/**
 * The over's log-odds are coef · [1, the book's no-vig log-odds, the simulation's log-odds minus
 * the book's, ln(line / typical line)]. Deliberately small: on the first 66 logged games, a
 * variant with separate size terms for scoring and other stats moved the picks' out-of-sample
 * return by five points, which is noise, so the shape isn't tuned further until there's far more
 * data to tune it on.
 */
export type FitCoef = [constant: number, market: number, sim: number, size: number];

/** "The book is right": what a fit is pulled toward, and what little data falls back to. */
export const TRUST_BOOK: FitCoef = [0, 1, 0, 0];

export type FitFeatures = [number, number, number, number];

const clampP = (p: number) => Math.min(0.98, Math.max(0.02, p));
export const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** `pMarket` and `pSim` are chances of the over among decided outcomes (pushes left out). */
export function fitFeatures(pMarket: number, pSim: number, stat: PropStat, line: number): FitFeatures {
  const disagree = Math.max(-2.5, Math.min(2.5, logit(pSim) - logit(pMarket)));
  return [1, logit(pMarket), disagree, Math.log(Math.max(0.5, line) / REF_LINE[stat])];
}

export function fittedFrom(coef: FitCoef, x: ArrayLike<number>): number {
  let z = 0;
  for (let i = 0; i < coef.length; i++) z += coef[i] * x[i];
  return sigmoid(z);
}

/** The fitted chance of the over, pushes left out. */
export function fittedOver(coef: FitCoef, pMarket: number, pSim: number, stat: PropStat, line: number): number {
  return fittedFrom(coef, fitFeatures(pMarket, pSim, stat, line));
}

/** How far a fit's picks have been borne out on days it never saw. */
export type FitVerdict = 'tested' | 'promising' | 'none';

/** Picks needed, out of sample, before a positive record counts as tested. */
export const TESTED_MIN_PICKS = 300;

/**
 * "tested": enough out-of-sample picks and the whole 95% range of their return is above zero.
 * "promising": ahead so far, but the range still includes zero. "none": behind, or no test yet.
 */
export function fitVerdict(picks: { win: number; loss: number; roi: number; lo: number } | undefined): FitVerdict {
  if (!picks || picks.win + picks.loss === 0 || picks.roi <= 0) return 'none';
  return picks.win + picks.loss >= TESTED_MIN_PICKS && picks.lo > 0 ? 'tested' : 'promising';
}
