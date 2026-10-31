// Suggested parlays (1 to 3 legs) from simulated outcomes and posted prices.
//
// Legs in the same game are scored jointly from that game's simulations, so correlation (a
// favorite covering and the game going over, say) comes from the sims rather than an assumption.
// Legs from different games are independent. Model probabilities are blended with the market's
// no-vig probabilities before ranking, weighted by how much the model has earned in backtests,
// because a model that disagrees sharply with a liquid market is usually the one that is wrong.
// Where that leaves the market alone on every bet (NBA), picks can be ranked by the simulation
// alone instead, labeled as such.
import { impliedFromAmerican } from '../lib/stats';
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
  prop?: { athleteId: string; player: string; stat: PropStat; line: number; mean: number; now?: number };
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

export type BlendWeights = Record<LegKind, number>;

/**
 * How much the simulation counts next to the market's no-vig odds, by league and bet type. Fitted
 * with the backtest's "Best model weight" rows (scripts/backtest.ts, model 1.1.0, 600 games per
 * league): the market alone scored best on every NBA bet and on college moneylines, while college
 * spreads and totals did slightly better with a quarter of the model mixed in. Refit whenever
 * MODEL_VERSION changes.
 */
export const MODEL_WEIGHT: Record<LeagueId, BlendWeights> = {
  // Player props have no backtest yet, so the blend leaves them to the market.
  nba: { ml: 0, spread: 0, total: 0, prop: 0 },
  ncaam: { ml: 0, spread: 0.25, total: 0.25, prop: 0 },
};

/** False when the market alone ranks every bet in this league, so no leg can beat the vig. */
export const modelHasSay = (league: LeagueId) => Object.values(MODEL_WEIGHT[league]).some((w) => w > 0);

/** The simulation's chances alone, ignoring the market: its own picks, unproven against the market. */
export const SIM_ONLY: BlendWeights = { ml: 1, spread: 1, total: 1, prop: 1 };

/** "blend" ranks by the backtested weights; "sim" by the simulation alone. */
export type PickMode = 'blend' | 'sim';

export const weightsFor = (league: LeagueId, mode: PickMode): BlendWeights => (mode === 'sim' ? SIM_ONLY : MODEL_WEIGHT[league]);

/** The blend where it can find anything, else the simulation's own picks. */
export const defaultPickMode = (league: LeagueId): PickMode => (modelHasSay(league) ? 'blend' : 'sim');

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

export function legsForGame(g: GameMarket, weights: BlendWeights = MODEL_WEIGHT[g.league]): Leg[] {
  const o = g.odds;
  const n = g.margin.length;
  const legs: Leg[] = [];
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
    const pBlend = weights[kind] * pModel + (1 - weights[kind]) * pFairRaw;
    const decimal = toDecimal(price);
    const ev = pPush + (1 - pPush) * pBlend * decimal - 1;
    const key = prop ? `${g.gameId}:prop:${prop.athleteId}:${prop.stat}:${side}` : `${g.gameId}:${kind}:${side}`;
    legs.push({ key, gameId: g.gameId, game: g.label, kind, side, label, price, decimal, pModel, pPush, pFair: pFairRaw, pBlend, ev, outcome, prop });
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
    const info = { athleteId: pm.athleteId, player: pm.player, stat: pm.stat, line: pm.line, mean: pm.mean, now: pm.now };
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
export function suggestParlays(games: GameMarket[], perSize = 3, weights?: BlendWeights): Suggestions {
  const legs = games.flatMap((g) => legsForGame(g, weights));
  // Game legs and props compete for separate places, so a game with dozens of props can't crowd
  // out the lines, and the pool stays small enough to score every three-leg combination.
  const best = (xs: Leg[], k: number) => xs.filter((l) => l.pBlend >= 0.3 && l.ev > -0.06).sort((a, b) => b.ev - a.ev).slice(0, k);
  const gameLegs = legs.filter((l) => !l.prop);
  // A pool of props alone (live games) gets every place.
  const pool = [...best(gameLegs, 30), ...best(legs.filter((l) => !!l.prop), gameLegs.length ? 12 : 30)].sort((a, b) => b.ev - a.ev);
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
