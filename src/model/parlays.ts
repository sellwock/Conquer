// Suggested parlays (1 to 3 legs) from simulated outcomes and posted prices.
//
// Legs in the same game are scored jointly from that game's simulations, so correlation (a
// favorite covering and the game going over, say) comes from the sims rather than an assumption.
// Legs from different games are independent. Model probabilities are blended with the market's
// no-vig probabilities before ranking, weighted by how much the model has earned in backtests,
// because a model that disagrees sharply with a liquid market is usually the one that is wrong.
// Where that leaves the market alone on every bet (NBA), picks can be ranked by the simulation
// alone instead, labeled as such. Player props have their own evidence: a pick model fitted to
// graded lines (propFit.ts), which prices them wherever it has been fitted.
import { impliedFromAmerican } from '../lib/stats';
import { fittedOver, type PropFits } from './propFit';
import type { LeagueId, Odds, PropStat } from './types';

export interface GameMarket {
  gameId: string;
  league: LeagueId;
  /** e.g. "MIL @ WSH" */
  label: string;
  home: string;
  away: string;
  tip?: string;
  /** Set when the outcomes come from a scenario the user changed (players ruled out etc.). */
  note?: string;
  odds: Odds;
  margin: Int16Array;
  total: Int16Array;
  /** Posted player props, each scored in every simulation. */
  props?: PropMarket[];
  /** When the prop lines were fetched, and from which book. */
  propsAt?: number;
  propsProvider?: string;
  /** A game in progress, priced from the in-game book and a simulation from the current score. */
  live?: boolean;
}

export interface PropMarket {
  athleteId: string;
  /** e.g. "A. Reaves" */
  player: string;
  stat: PropStat;
  line: number;
  /** American prices. */
  over: number;
  under: number;
  /** The over's result in each simulation, aligned with margin and total: 0 loss, 1 win, 2 push. */
  hits: Uint8Array;
  /** Simulated average. */
  mean: number;
  /** Live games: what the player has so far. */
  now?: number;
  /** When the book last changed this line or its prices (ISO), where the feed says. */
  updated?: string;
}

export type LegKind = 'ml' | 'spread' | 'total' | 'prop';

export interface Leg {
  key: string;
  gameId: string;
  game: string;
  kind: LegKind;
  side: 'home' | 'away' | 'over' | 'under';
  label: string;
  price: number;
  decimal: number;
  /** Model chance the leg wins, given it doesn't push. */
  pModel: number;
  pPush: number;
  /** Market's no-vig chance. */
  pFair: number;
  /** Blend of model and market used for ranking. */
  pBlend: number;
  /** Expected profit per 1 unit staked, using the blend. */
  ev: number;
  /** Per simulation: 0 lose, 1 win, 2 push. */
  outcome: Uint8Array;
  /** Player props only. */
  prop?: { athleteId: string; player: string; stat: PropStat; line: number; mean: number; now?: number; updated?: string };
  /** A prop whose `pBlend` is the fitted pick model's chance. */
  fitted?: boolean;
}

export interface Parlay {
  legs: Leg[];
  price: number;
  decimal: number;
  /** Chance no leg loses (blended). */
  pHit: number;
  /** Chance every leg wins (blended): no leg pushes either. */
  pWin: number;
  /** The chance no leg loses, straight from the simulations. */
  pModel: number;
  /** What the price implies. */
  pImplied: number;
  ev: number;
  sameGame: boolean;
  /** Most legs that come from a single game. */
  maxFromOneGame: number;
  /** Joint vs. independent for same-game legs: +0.08 means the legs win together 8% more often. */
  correlation?: number;
}

export const DEFAULT_JUICE = -110;

export type BlendWeights = Record<LegKind, number> & {
  /** Prices player props by the fitted pick model wherever it has coefficients, in place of `prop`. */
  fit?: PropFits;
};

/**
 * How much the simulation counts next to the market's no-vig odds, by league and bet type. Fitted
 * with the backtest's "Best model weight" rows (scripts/backtest.ts, model 1.2.0, 600 games per
 * league): the market alone scored best on every NBA bet and on college moneylines, while college
 * spreads and totals did slightly better with a fifth of the model mixed in (a quarter under
 * 1.1.0). Refit whenever MODEL_VERSION changes.
 */
export const MODEL_WEIGHT: Record<LeagueId, BlendWeights> = {
  // Player props have no backtest yet, so the blend leaves them to the market.
  nba: { ml: 0, spread: 0, total: 0, prop: 0 },
  ncaam: { ml: 0, spread: 0.2, total: 0.2, prop: 0 },
};

/** False when the market alone ranks every bet in this league, so no leg can beat the vig. */
export const modelHasSay = (league: LeagueId) => (['ml', 'spread', 'total', 'prop'] as const).some((k) => MODEL_WEIGHT[league][k] > 0);

/** The simulation's chances alone on every bet, ignoring the market. The track record grades these. */
export const SIM_ONLY: BlendWeights = { ml: 1, spread: 1, total: 1, prop: 1 };

/**
 * How much the simulation counts on player props in its own ranking; the rest is the book's no-vig
 * odds. The first graded props (two NBA games, 310 lines, Nov 1 2026) scored worse than the book's
 * odds by Brier (0.307 vs 0.251, where 25% simulation scored 0.258), and its top picks went 7–13 at
 * simulated chances of 78% to 98%: it projected stars under their lines and was far too sure of
 * itself. So props lean on the book until the track record shows the simulation earns more say.
 */
export const PROP_SIM_WEIGHT = 0.25;

/** The simulation's own ranking: its chances on game lines, and on props mixed with the book's. */
export const SIM_PICKS: BlendWeights = { ml: 1, spread: 1, total: 1, prop: PROP_SIM_WEIGHT };

/**
 * "blend" ranks by the evidence: game lines by the backtested weights and, given a fitted pick
 * model, props by that. "sim" ranks by the simulation (SIM_PICKS).
 */
export type PickMode = 'blend' | 'sim';

const withFit = new WeakMap<PropFits, Partial<Record<LeagueId, BlendWeights>>>();

/** The same object comes back for the same fit, so the result can key a memo. */
export function weightsFor(league: LeagueId, mode: PickMode, fit?: PropFits): BlendWeights {
  if (mode === 'sim') return SIM_PICKS;
  if (!fit) return MODEL_WEIGHT[league];
  const byLeague = withFit.get(fit) ?? {};
  withFit.set(fit, byLeague);
  return (byLeague[league] ??= { ...MODEL_WEIGHT[league], fit });
}

/** The evidence where it can find anything (a backtested weight or a fitted pick model), else the simulation's own picks. */
export const defaultPickMode = (league: LeagueId, fit?: PropFits): PickMode => (modelHasSay(league) || fit?.pre || fit?.live ? 'blend' : 'sim');

/** Minimum blended hit chance and maximum price by number of legs: no longshots. */
export const HIT_FLOOR: Record<number, number> = { 1: 0.4, 2: 0.25, 3: 0.15 };
export const MAX_PRICE: Record<number, number> = { 1: 200, 2: 400, 3: 700 };

export const toDecimal = (american: number) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);
export const toAmerican = (decimal: number) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1)));

export function noVig(a: number, b: number): [number, number] {
  const pa = impliedFromAmerican(a), pb = impliedFromAmerican(b);
  return [pa / (pa + pb), pb / (pa + pb)];
}

function fmtLine(x: number) {
  return x > 0 ? `+${x}` : `${x}`;
}

export function legsForGame(g: GameMarket, weights: BlendWeights = MODEL_WEIGHT[g.league]): Leg[] {
  const o = g.odds;
  const n = g.margin.length;
  const legs: Leg[] = [];
  // Props go by the pick model fitted to this kind of line (pre-game or live), when there is one.
  const coef = g.live ? weights.fit?.live : weights.fit?.pre;
  const add = (kind: LegKind, side: Leg['side'], label: string, price: number, pFairRaw: number, test: (m: number, t: number, s: number) => number, prop?: Leg['prop']) => {
    const outcome = new Uint8Array(n);
    let win = 0, push = 0;
    for (let s = 0; s < n; s++) {
      const r = test(g.margin[s], g.total[s], s);
      outcome[s] = r;
      if (r === 1) win++;
      else if (r === 2) push++;
    }
    const decided = n - push;
    const pModel = decided > 0 ? win / decided : 0;
    const pPush = n > 0 ? push / n : 0;
    const fitted = !!prop && !!coef;
    let pBlend = weights[kind] * pModel + (1 - weights[kind]) * pFairRaw;
    if (prop && coef) {
      // The fit models the over, so an under is what the over's fitted chance leaves.
      const pSim = decided > 0 ? pModel : 0.5;
      pBlend = side === 'over' ? fittedOver(coef, pFairRaw, pSim) : 1 - fittedOver(coef, 1 - pFairRaw, 1 - pSim);
    }
    const decimal = toDecimal(price);
    const ev = pPush + (1 - pPush) * pBlend * decimal - 1;
    const key = prop ? `${g.gameId}:prop:${prop.athleteId}:${prop.stat}:${side}` : `${g.gameId}:${kind}:${side}`;
    legs.push({ key, gameId: g.gameId, game: g.label, kind, side, label, price, decimal, pModel, pPush, pFair: pFairRaw, pBlend, ev, outcome, prop, ...(fitted ? { fitted } : {}) });
  };
  const sign = (v: number) => (v > 0 ? 1 : v < 0 ? 0 : 2);

  if (o.homeML != null && o.awayML != null) {
    const [ph, pa] = noVig(o.homeML, o.awayML);
    add('ml', 'home', `${g.home} moneyline`, o.homeML, ph, (m) => (m > 0 ? 1 : 0));
    add('ml', 'away', `${g.away} moneyline`, o.awayML, pa, (m) => (m < 0 ? 1 : 0));
  }
  if (o.spread != null) {
    const hp = o.homeSpreadOdds ?? DEFAULT_JUICE, ap = o.awaySpreadOdds ?? DEFAULT_JUICE;
    const [ph, pa] = noVig(hp, ap);
    const L = o.spread;
    add('spread', 'home', `${g.home} ${fmtLine(L)}`, hp, ph, (m) => sign(m + L));
    add('spread', 'away', `${g.away} ${fmtLine(-L)}`, ap, pa, (m) => sign(-(m + L)));
  }
  if (o.total != null) {
    const op = o.overOdds ?? DEFAULT_JUICE, up = o.underOdds ?? DEFAULT_JUICE;
    const [po, pu] = noVig(op, up);
    const T = o.total;
    add('total', 'over', `Over ${T}`, op, po, (_m, t) => sign(t - T));
    add('total', 'under', `Under ${T}`, up, pu, (_m, t) => sign(T - t));
  }
  for (const pm of g.props ?? []) {
    if (pm.hits.length !== n) continue;
    const [po, pu] = noVig(pm.over, pm.under);
    const info = { athleteId: pm.athleteId, player: pm.player, stat: pm.stat, line: pm.line, mean: pm.mean, now: pm.now, updated: pm.updated };
    const what = `${pm.line} ${PROP_WORDS[pm.stat]}`;
    const h = pm.hits;
    add('prop', 'over', `${pm.player} over ${what}`, pm.over, po, (_m, _t, s) => h[s], info);
    add('prop', 'under', `${pm.player} under ${what}`, pm.under, pu, (_m, _t, s) => (h[s] === 2 ? 2 : 1 - h[s]), info);
  }
  return legs;
}

export const PROP_WORDS: Record<PropStat, string> = {
  pts: 'points',
  reb: 'rebounds',
  ast: 'assists',
  tpm: 'threes',
  pra: 'pts + reb + ast',
  pr: 'pts + reb',
  pa: 'pts + ast',
  ar: 'reb + ast',
};

/**
 * Legs that can't share a parlay: both sides of a market, a moneyline and spread of one game, or
 * two props on one player (they overlap too much to add anything).
 */
function compatible(a: Leg, b: Leg): boolean {
  if (a.gameId !== b.gameId) return true;
  if (a.prop || b.prop) return !(a.prop && b.prop && a.prop.athleteId === b.prop.athleteId);
  const teamA = a.kind !== 'total', teamB = b.kind !== 'total';
  return teamA !== teamB;
}

/**
 * The pick model's rule for single bets, shared by the site and by the record it is tested on
 * (src/track/fit.ts): at most one bet per player per game (a player's lines move together, so more
 * would be one bet made several times), the candidate with the best expected return, if that
 * clears `minEdge` at a price no longer than the cap for singles.
 */
export function onePerPlayer<T extends { gameId: string; athleteId: string; price: number; ev: number }>(cands: Iterable<T>, minEdge: number): T[] {
  const best = new Map<string, T>();
  for (const c of cands) {
    if (c.ev < minEdge || c.price > MAX_PRICE[1]) continue;
    const key = `${c.gameId}|${c.athleteId}`;
    const had = best.get(key);
    if (!had || c.ev > had.ev) best.set(key, c);
  }
  return [...best.values()];
}

/** A fitted leg's expected return given the bet is decided, which is what the pick rule and its record go by. */
const fitEdge = (l: Leg) => l.pBlend * l.decimal - 1;

/** The legs the pick model would bet as singles (`onePerPlayer`), best first. */
export function fitLegs(legs: Leg[], minEdge: number): Leg[] {
  const cands = legs.filter((l) => l.fitted).map((leg) => ({ gameId: leg.gameId, athleteId: leg.prop!.athleteId, price: leg.price, ev: fitEdge(leg), leg }));
  return onePerPlayer(cands, minEdge)
    .map((c) => c.leg)
    .sort((a, b) => b.ev - a.ev);
}

/** The pick model's single bets among these markets, best first. Empty where no fit prices their props. */
export function fitSingles(markets: GameMarket[], weights: BlendWeights): Parlay[] {
  if (!weights.fit) return [];
  return fitLegs(markets.flatMap((m) => legsForGame(m, weights)), weights.fit.minEdge).map((l) => evaluate([l]));
}

interface GroupValue {
  /** Expected payout multiplier (0 if a leg loses; pushes count as 1). */
  payout: number;
  pNoLoss: number;
  pAllWin: number;
  pModelNoLoss: number;
  correlation?: number;
}

/**
 * Joint value of legs from one game. The simulations say how the legs move together; each leg's
 * own chance is its blend. Where the two differ, the simulated joint outcomes are reweighted until
 * every leg's chances match its blend (iterative proportional fitting), which keeps the
 * simulations' dependence between the legs whichever way the blend moved each one.
 */
function groupValue(legs: Leg[]): GroupValue {
  const k = legs.length;
  if (k === 1) {
    const l = legs[0];
    const decided = 1 - l.pPush;
    return { payout: l.pPush + decided * l.pBlend * l.decimal, pNoLoss: l.pPush + decided * l.pBlend, pAllWin: decided * l.pBlend, pModelNoLoss: l.pPush + decided * l.pModel };
  }
  const n = legs[0].outcome.length;
  // Each simulation lands in one cell: leg i's result (0 loss, 1 win, 2 push) is the cell's i-th base-3 digit.
  const cells = 3 ** k;
  const state = Array.from({ length: cells }, (_, c) => legs.map((_l, i) => Math.floor(c / 3 ** i) % 3));
  const counts = new Float64Array(cells);
  for (let s = 0; s < n; s++) {
    let c = 0;
    for (let i = k - 1; i >= 0; i--) c = c * 3 + legs[i].outcome[s];
    counts[c]++;
  }
  const noLoss = (c: number) => !state[c].includes(0);
  // Every leg winning is the cell whose digits are all 1.
  const every = (cells - 1) / 2;
  let simNoLoss = 0;
  for (let c = 0; c < cells; c++) if (noLoss(c)) simNoLoss += counts[c];

  const w = legs.every((l) => l.pBlend === l.pModel) ? counts.map((x) => x / n) : reweigh(counts, state, legs);
  let payout = 0, pNoLoss = 0;
  for (let c = 0; c < cells; c++) {
    if (!w[c] || !noLoss(c)) continue;
    pNoLoss += w[c];
    payout += w[c] * state[c].reduce((f, st, i) => (st === 1 ? f * legs[i].decimal : f), 1);
  }
  const indep = legs.reduce((x, l) => x * l.pModel * (1 - l.pPush), 1);
  return { payout, pNoLoss, pAllWin: w[every], pModelNoLoss: simNoLoss / n, correlation: indep > 0 ? counts[every] / n / indep - 1 : undefined };
}

/** Simulations of "unrelated" that the simulated dependence between legs is weighed against. */
const UNRELATED_SIMS = 20;

/**
 * The share of each joint outcome once every leg's own chances match its blend. The simulations'
 * dependence counts only as far as they saw each leg go both ways: a leg that won (or lost) in
 * nearly every simulation says little about what happens when it doesn't, so the result is mixed
 * with "the legs are unrelated" in proportion, and is exactly that when a leg never varied.
 */
function reweigh(counts: Float64Array, state: number[][], legs: Leg[]): Float64Array {
  const cells = counts.length, k = legs.length;
  const target = legs.map((l) => [(1 - l.pPush) * (1 - l.pBlend), (1 - l.pPush) * l.pBlend, l.pPush]);
  const unrelated = Float64Array.from({ length: cells }, (_, c) => state[c].reduce((x, st, i) => x * target[i][st], 1));
  let rarest = Infinity;
  for (let i = 0; i < k; i++) {
    const seen = [0, 0, 0];
    for (let c = 0; c < cells; c++) seen[state[c][i]] += counts[c];
    rarest = Math.min(rarest, seen[0], seen[1]);
  }
  if (rarest === 0) return unrelated;

  // Half a simulation in every decided cell, so the blended chances can always be met.
  const w = new Float64Array(cells);
  let total = 0;
  for (let c = 0; c < cells; c++) total += w[c] = counts[c] + (state[c].includes(2) ? 0 : 0.5);
  for (let c = 0; c < cells; c++) w[c] /= total;
  for (let it = 0; it < 500; it++) {
    let off = 0;
    for (let i = 0; i < k; i++) {
      const have = [0, 0, 0];
      for (let c = 0; c < cells; c++) have[state[c][i]] += w[c];
      for (let st = 0; st < 3; st++) off = Math.max(off, Math.abs(have[st] - target[i][st]));
      for (let c = 0; c < cells; c++) {
        const h = have[state[c][i]];
        if (h > 0) w[c] *= target[i][state[c][i]] / h;
      }
    }
    if (off < 1e-9) break;
  }
  const mix = UNRELATED_SIMS / (UNRELATED_SIMS + rarest);
  for (let c = 0; c < cells; c++) w[c] = (1 - mix) * w[c] + mix * unrelated[c];
  return w;
}

export function evaluate(legs: Leg[]): Parlay {
  const byGame = new Map<string, Leg[]>();
  for (const l of legs) byGame.set(l.gameId, [...(byGame.get(l.gameId) ?? []), l]);
  let payout = 1, pHit = 1, pWin = 1, pModel = 1;
  let correlation: number | undefined;
  for (const group of byGame.values()) {
    const v = groupValue(group);
    payout *= v.payout;
    pHit *= v.pNoLoss;
    pWin *= v.pAllWin;
    pModel *= v.pModelNoLoss;
    if (v.correlation != null) correlation = v.correlation;
  }
  const decimal = legs.reduce((d, l) => d * l.decimal, 1);
  return {
    legs,
    price: toAmerican(decimal),
    decimal,
    pHit,
    pWin,
    pModel,
    pImplied: 1 / decimal,
    ev: payout - 1,
    sameGame: byGame.size < legs.length,
    maxFromOneGame: Math.max(...[...byGame.values()].map((g) => g.length)),
    correlation,
  };
}

export interface Suggestions {
  bySize: Record<1 | 2 | 3, Parlay[]>;
  /**
   * With a fitted pick model: combinations with two or more legs from one game. A book sells those
   * as a same-game parlay at its own price, below the legs multiplied, so they are listed apart
   * from the rest, by how far below it could pay and still be worth taking.
   */
  sameGame: Parlay[];
  legs: Leg[];
}

/**
 * The lowest decimal price at which a parlay returns `minEdge` per unit staked, counting only the
 * outcomes where every leg wins. That is what to hold a same-game parlay's quoted price against.
 */
export const worthAt = (p: Parlay, minEdge: number) => (p.pWin > 0 ? (1 + minEdge) / p.pWin : Infinity);

/**
 * Best positive-value parlays of 1, 2 and 3 legs, each clearing a minimum hit chance. With a
 * fitted pick model in the weights, every leg has to be a bet worth making alone (a prop the fit
 * picks, or a game line with a positive return), singles are game lines only (`fitSingles` lists
 * the props), and same-game combinations are returned separately.
 */
export function suggestParlays(games: GameMarket[], perSize = 3, weights?: BlendWeights): Suggestions {
  const legs = games.flatMap((g) => legsForGame(g, weights));
  const fit = weights?.fit;
  // Game legs and props compete for separate places, so a game with dozens of props can't crowd
  // out the lines, and the pool stays small enough to score every three-leg combination.
  const best = (xs: Leg[], k: number) => xs.filter((l) => l.pBlend >= 0.3 && l.ev > (fit ? 0 : -0.06)).sort((a, b) => b.ev - a.ev).slice(0, k);
  const gameLegs = legs.filter((l) => !l.prop);
  const propLegs = legs.filter((l) => !!l.prop);
  // A pool of props alone (live games) gets every place.
  const props = fit ? fitLegs(propLegs, fit.minEdge).slice(0, 16) : best(propLegs, gameLegs.length ? 12 : 30);
  const pool = [...best(gameLegs, 30), ...props].sort((a, b) => b.ev - a.ev);
  const candidates: Record<1 | 2 | 3, Parlay[]> = { 1: [], 2: [], 3: [] };
  for (let i = 0; i < pool.length; i++) {
    if (!fit || !pool[i].prop) candidates[1].push(evaluate([pool[i]]));
    for (let j = i + 1; j < pool.length; j++) {
      if (!compatible(pool[i], pool[j])) continue;
      candidates[2].push(evaluate([pool[i], pool[j]]));
      for (let k = j + 1; k < pool.length; k++) {
        if (!compatible(pool[i], pool[k]) || !compatible(pool[j], pool[k])) continue;
        candidates[3].push(evaluate([pool[i], pool[j], pool[k]]));
      }
    }
  }
  // Keep each list varied: a leg appears in at most two suggestions of the same size.
  const varied = (ranked: Parlay[], limit: number) => {
    const out: Parlay[] = [];
    const uses = new Map<string, number>();
    for (const p of ranked) {
      if (out.length >= limit) break;
      if (p.legs.length > 1 && p.legs.some((l) => (uses.get(l.key) ?? 0) >= 2)) continue;
      out.push(p);
      for (const l of p.legs) uses.set(l.key, (uses.get(l.key) ?? 0) + 1);
    }
    return out;
  };
  const bar = (p: Parlay) => p.pHit >= HIT_FLOOR[p.legs.length] && p.price <= MAX_PRICE[p.legs.length];
  const bySize = { 1: [], 2: [], 3: [] } as Record<1 | 2 | 3, Parlay[]>;
  for (const size of [1, 2, 3] as const) {
    bySize[size] = varied(candidates[size].filter((p) => p.ev > 0 && bar(p) && !(fit && p.sameGame)).sort((a, b) => b.ev - a.ev), perSize);
  }
  // Same-game combinations of the fit's picks: ranked by the quoted price they'd need next to the legs multiplied.
  const room = (p: Parlay) => worthAt(p, fit!.minEdge) / p.decimal;
  const sameGame = fit ? varied([...candidates[2], ...candidates[3]].filter((p) => p.sameGame && bar(p)).sort((a, b) => room(a) - room(b)), perSize) : [];
  return { bySize, sameGame, legs };
}
