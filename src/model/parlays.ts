// Suggested parlays (1 to 3 legs) from simulated outcomes and posted prices.
//
// Legs in the same game are scored jointly from that game's simulations, so correlation (a
// favorite covering and the game going over, say) comes from the sims rather than an assumption.
// Legs from different games are independent. Model probabilities are blended with the market's
// no-vig probabilities before ranking, because a model that disagrees sharply with a liquid
// market is usually the one that is wrong.
import { impliedFromAmerican } from '../lib/stats';
import type { Odds } from './types';

export interface GameMarket {
  gameId: string;
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
}

export type LegKind = 'ml' | 'spread' | 'total';

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
}

export interface Parlay {
  legs: Leg[];
  price: number;
  decimal: number;
  /** Chance no leg loses (blended). */
  pHit: number;
  /** Same, straight from the simulations. */
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
const MODEL_WEIGHT = 0.5;
/** Minimum blended hit chance and maximum price by number of legs: no longshots. */
export const HIT_FLOOR: Record<number, number> = { 1: 0.4, 2: 0.25, 3: 0.15 };
export const MAX_PRICE: Record<number, number> = { 1: 200, 2: 400, 3: 700 };

export const toDecimal = (american: number) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);
export const toAmerican = (decimal: number) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1)));

function noVig(a: number, b: number): [number, number] {
  const pa = impliedFromAmerican(a), pb = impliedFromAmerican(b);
  return [pa / (pa + pb), pb / (pa + pb)];
}

function fmtLine(x: number) {
  return x > 0 ? `+${x}` : `${x}`;
}

export function legsForGame(g: GameMarket): Leg[] {
  const o = g.odds;
  const n = g.margin.length;
  const legs: Leg[] = [];
  const add = (kind: LegKind, side: Leg['side'], label: string, price: number, pFairRaw: number, test: (m: number, t: number) => number) => {
    const outcome = new Uint8Array(n);
    let win = 0, push = 0;
    for (let s = 0; s < n; s++) {
      const r = test(g.margin[s], g.total[s]);
      outcome[s] = r;
      if (r === 1) win++;
      else if (r === 2) push++;
    }
    const decided = n - push;
    const pModel = decided > 0 ? win / decided : 0;
    const pPush = n > 0 ? push / n : 0;
    const pBlend = MODEL_WEIGHT * pModel + (1 - MODEL_WEIGHT) * pFairRaw;
    const decimal = toDecimal(price);
    const ev = pPush + (1 - pPush) * pBlend * decimal - 1;
    legs.push({ key: `${g.gameId}:${kind}:${side}`, gameId: g.gameId, game: g.label, kind, side, label, price, decimal, pModel, pPush, pFair: pFairRaw, pBlend, ev, outcome });
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
  return legs;
}

/** Legs that can't share a parlay: both sides of a market, or a moneyline and spread of one game. */
function compatible(a: Leg, b: Leg): boolean {
  if (a.gameId !== b.gameId) return true;
  const teamA = a.kind !== 'total', teamB = b.kind !== 'total';
  return teamA !== teamB;
}

interface GroupValue {
  /** Expected payout multiplier (0 if a leg loses; pushes count as 1). */
  payout: number;
  pNoLoss: number;
  pModelNoLoss: number;
  correlation?: number;
}

/** Joint value of legs from one game, from that game's simulations, blended toward the market. */
function groupValue(legs: Leg[]): GroupValue {
  const n = legs[0].outcome.length;
  let payout = 0, noLoss = 0, allWin = 0;
  for (let s = 0; s < n; s++) {
    let f = 1, lost = false, every = true;
    for (const l of legs) {
      const r = l.outcome[s];
      if (r === 0) {
        lost = true;
        break;
      }
      if (r === 1) f *= l.decimal;
      else every = false;
    }
    if (lost) continue;
    noLoss++;
    payout += f;
    if (every) allWin++;
  }
  const scale = legs.reduce((k, l) => k * (l.pModel > 0 ? l.pBlend / l.pModel : 1), 1);
  const pModelNoLoss = noLoss / n;
  let correlation: number | undefined;
  if (legs.length > 1) {
    const indep = legs.reduce((k, l) => k * l.pModel * (1 - l.pPush), 1);
    correlation = indep > 0 ? allWin / n / indep - 1 : undefined;
  }
  return { payout: (payout / n) * scale, pNoLoss: Math.min(1, pModelNoLoss * scale), pModelNoLoss, correlation };
}

export function evaluate(legs: Leg[]): Parlay {
  const byGame = new Map<string, Leg[]>();
  for (const l of legs) byGame.set(l.gameId, [...(byGame.get(l.gameId) ?? []), l]);
  let payout = 1, pHit = 1, pModel = 1;
  let correlation: number | undefined;
  for (const group of byGame.values()) {
    const v = groupValue(group);
    payout *= v.payout;
    pHit *= v.pNoLoss;
    pModel *= v.pModelNoLoss;
    if (v.correlation != null) correlation = v.correlation;
  }
  const decimal = legs.reduce((d, l) => d * l.decimal, 1);
  return {
    legs,
    price: toAmerican(decimal),
    decimal,
    pHit,
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
  legs: Leg[];
}

/** Best positive-value parlays of 1, 2 and 3 legs, each clearing a minimum hit chance. */
export function suggestParlays(games: GameMarket[], perSize = 3): Suggestions {
  const legs = games.flatMap(legsForGame);
  const pool = legs
    .filter((l) => l.pBlend >= 0.3 && l.ev > -0.06)
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 30);
  const candidates: Record<1 | 2 | 3, Parlay[]> = { 1: [], 2: [], 3: [] };
  for (let i = 0; i < pool.length; i++) {
    candidates[1].push(evaluate([pool[i]]));
    for (let j = i + 1; j < pool.length; j++) {
      if (!compatible(pool[i], pool[j])) continue;
      candidates[2].push(evaluate([pool[i], pool[j]]));
      for (let k = j + 1; k < pool.length; k++) {
        if (!compatible(pool[i], pool[k]) || !compatible(pool[j], pool[k])) continue;
        candidates[3].push(evaluate([pool[i], pool[j], pool[k]]));
      }
    }
  }
  const bySize = { 1: [], 2: [], 3: [] } as Record<1 | 2 | 3, Parlay[]>;
  for (const size of [1, 2, 3] as const) {
    const ok = candidates[size].filter((p) => p.ev > 0 && p.pHit >= HIT_FLOOR[size] && p.price <= MAX_PRICE[size]).sort((a, b) => b.ev - a.ev);
    // Keep the list varied: a leg appears in at most two suggestions of the same size.
    const uses = new Map<string, number>();
    for (const p of ok) {
      if (bySize[size].length >= perSize) break;
      if (size > 1 && p.legs.some((l) => (uses.get(l.key) ?? 0) >= 2)) continue;
      bySize[size].push(p);
      for (const l of p.legs) uses.set(l.key, (uses.get(l.key) ?? 0) + 1);
    }
  }
  return { bySize, legs };
}
