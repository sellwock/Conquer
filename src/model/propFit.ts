// The chance a prop's over wins, as fitted to the forward log (src/track/fit.ts): a small logistic
// model of the book's own odds and how far the simulation disagrees with them. This file is the
// model's shape only, with no data, so pricing and training share it.

/**
 * The over's log-odds are coef · [1, the book's no-vig log-odds, the simulation's log-odds minus
 * the book's]. Deliberately small. A line-size term looked strong on the first 66 logged games
 * (unders on small scoring lines won 59%) and vanished on the next 98, so it was dropped: the
 * shape only grows when an effect holds on games it wasn't found on.
 */
export type FitCoef = [constant: number, market: number, sim: number];

/** "The book is right": what a fit is pulled toward, and what little data falls back to. */
export const TRUST_BOOK: FitCoef = [0, 1, 0];

export type FitFeatures = [number, number, number];

const clampP = (p: number) => Math.min(0.98, Math.max(0.02, p));
export const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** `pMarket` and `pSim` are chances of the over among decided outcomes (pushes left out). */
export function fitFeatures(pMarket: number, pSim: number): FitFeatures {
  // Capped, so one wild simulated chance can't swamp a fit.
  return [1, logit(pMarket), Math.max(-2.5, Math.min(2.5, logit(pSim) - logit(pMarket)))];
}

export function fittedFrom(coef: FitCoef, x: ArrayLike<number>): number {
  let z = 0;
  for (let i = 0; i < coef.length; i++) z += coef[i] * x[i];
  return sigmoid(z);
}

/** The fitted chance of the over, pushes left out. */
export function fittedOver(coef: FitCoef, pMarket: number, pSim: number): number {
  return fittedFrom(coef, fitFeatures(pMarket, pSim));
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
