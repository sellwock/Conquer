// Grades logged player props against the final box score and the market. Pure functions only.
import { HIT_FLOOR, MAX_PRICE, PROP_SIM_WEIGHT, noVig, toDecimal } from '../model/parlays';
import { PARTS } from '../model/props';
import type { PropStat } from '../model/types';
import { bootstrapMean, record, type BetResult, type Record3 } from './grade';
import type { PropEntry, PropRow, PropSnap } from './types';

export type PropWhen = 'pre' | 'live';

/** The sim's top picks per game: as many as the Outlook tab's Live bets panel lists. */
export const TOP_PER_GAME = 5;

export interface GradedProp {
  gameId: string;
  tip: string;
  label: string;
  model: string;
  athleteId: string;
  player: string;
  stat: PropStat;
  line: number;
  side: 'over' | 'under';
  price: number;
  /** The sim's chance this side wins, pushes left out. */
  pSim: number;
  /** The book's no-vig chance this side wins. */
  pMarket: number;
  /** The chance the app ranks by: the sim's mixed with the book's (PROP_SIM_WEIGHT). */
  pPick: number;
  /** Expected return per unit staked, by that chance. */
  ev: number;
  final: number;
  result: BetResult;
  mean: number;
  now?: number;
  at?: PropSnap['at'];
}

export interface GradedSnap {
  gameId: string;
  /** Every line, on the side the sim favors. */
  lines: GradedProp[];
  /** The top picks, ranked and filtered as the app ranks single bets now. */
  top: GradedProp[];
  /** Over/under chances on lines that didn't push: [sim, market, over won]. */
  brier: [number, number, 0 | 1][];
}

interface Side {
  side: 'over' | 'under';
  price: number;
  pSim: number;
  pMarket: number;
  pPick: number;
  pHit: number;
  ev: number;
}

/**
 * Both sides of one logged line, priced the way `legsForGame` and `evaluate` price a single bet,
 * with the simulation weighted `w` against the book (the app's current weight by default).
 */
export function sidesOf(r: PropRow, w = PROP_SIM_WEIGHT): [Side, Side] {
  const [, , , over, under, pOver, pPush] = r;
  const pOverDecided = pPush < 1 ? pOver / (1 - pPush) : 0;
  const pUnder = Math.max(0, 1 - pOver - pPush);
  const [mOver, mUnder] = noVig(over, under);
  const side = (s: 'over' | 'under', price: number, p: number, pm: number, pWin: number): Side => {
    const pPick = w * p + (1 - w) * pm;
    // As `evaluate` scales a leg's simulated outcomes to its blended chance.
    const scale = p > 0 ? pPick / p : 1;
    return { side: s, price, pSim: p, pMarket: pm, pPick, pHit: Math.min(1, (pWin + pPush) * scale), ev: (pWin * toDecimal(price) + pPush) * scale - 1 };
  };
  return [side('over', over, pOverDecided, mOver, pOver), side('under', under, 1 - pOverDecided, mUnder, pUnder)];
}

/** Order of a logged box line. */
export const BOX = ['pts', 'reb', 'ast', 'tpm'] as const;

const settle = (v: number): BetResult => (v > 0 ? 'win' : v < 0 ? 'loss' : 'push');

/** One snapshot of a final game, graded; null until the box score is in. */
export function gradeProps(e: PropEntry, when: PropWhen): GradedSnap | null {
  const snap = e[when];
  if (e.status !== 'final' || !e.box || !snap) return null;
  const label = `${e.away.abbr} @ ${e.home.abbr}`;
  const lines: GradedProp[] = [];
  const brier: GradedSnap['brier'] = [];
  const picks: { s: Side; grade: (s: Side) => GradedProp }[] = [];
  for (const r of snap.rows) {
    const [athleteId, stat, line, , , , , mean, now] = r;
    const b = e.box[athleteId];
    if (!b) continue;
    const final = PARTS[stat].reduce((a, k) => a + b[BOX.indexOf(k)], 0);
    const [over, under] = sidesOf(r);
    const base = { gameId: e.id, tip: e.tip, label, model: snap.model, athleteId, player: e.players[athleteId] ?? athleteId, stat, line, final, mean, ...(now != null ? { now } : {}), ...(snap.at ? { at: snap.at } : {}) };
    const grade = (s: Side): GradedProp => ({
      ...base,
      side: s.side,
      price: s.price,
      pSim: s.pSim,
      pMarket: s.pMarket,
      pPick: s.pPick,
      ev: s.ev,
      result: settle(s.side === 'over' ? final - line : line - final),
    });
    lines.push(grade(over.pSim >= 0.5 ? over : under));
    if (final !== line) brier.push([over.pSim, over.pMarket, final > line ? 1 : 0]);
    for (const s of [over, under]) if (s.ev > 0 && s.pHit >= HIT_FLOOR[1] && s.price <= MAX_PRICE[1]) picks.push({ s, grade });
  }
  const top = picks
    .sort((a, b) => b.s.ev - a.s.ev)
    .slice(0, TOP_PER_GAME)
    .map(({ s, grade }) => grade(s));
  return { gameId: e.id, lines, top, brier };
}

export interface PropSummary {
  games: number;
  lines: number;
  top: Record3;
  every: Record3;
  /** Brier on the over (lower is better), averaged per game, then over games. Negative diff = sim better. */
  vsMarket?: { n: number; model: number; market: number; diff: number; lo: number; hi: number };
}

export function summarizeProps(snaps: GradedSnap[]): PropSummary {
  const perGame = snaps
    .filter((s) => s.brier.length)
    .map((s) => {
      const k = s.brier.length;
      const model = s.brier.reduce((a, [p, , y]) => a + (p - y) ** 2, 0) / k;
      const market = s.brier.reduce((a, [, q, y]) => a + (q - y) ** 2, 0) / k;
      return { model, market, diff: model - market };
    });
  let vsMarket: PropSummary['vsMarket'];
  if (perGame.length) {
    const b = bootstrapMean(perGame.map((g) => g.diff), 1000, 'props');
    const mean = (f: (g: (typeof perGame)[number]) => number) => perGame.reduce((a, g) => a + f(g), 0) / perGame.length;
    vsMarket = { n: perGame.length, model: mean((g) => g.model), market: mean((g) => g.market), diff: b.mean, lo: b.lo, hi: b.hi };
  }
  return {
    games: snaps.length,
    lines: snaps.reduce((a, s) => a + s.lines.length, 0),
    top: record(snaps.flatMap((s) => s.top)),
    every: record(snaps.flatMap((s) => s.lines)),
    vsMarket,
  };
}
