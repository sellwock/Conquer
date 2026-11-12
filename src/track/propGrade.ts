// Grades logged player props against the final box score and the market. Pure functions only.
import { HIT_FLOOR, MAX_PRICE, PROP_SIM_WEIGHT, noVig, toDecimal } from '../model/parlays';
import { PARTS } from '../model/props';
import type { PropStat } from '../model/types';
import { bootstrapMean, record, type BetResult, type Record3 } from './grade';
import type { CloseLine, NewsSnap, PropEntry, PropRow, PropSnap } from './types';

/** Before tip-off, mid-game, or right after a player was ruled out. */
export type PropWhen = 'pre' | 'live' | 'news';

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
  /** News picks: the scratched player, and how the book's line moved by just before tip. */
  news?: { name: string; shift: number; moved?: 'toward' | 'away' | 'same' };
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
  const [mOver, mUnder] = noVig(over, under);
  const side = (s: 'over' | 'under', price: number, p: number, pm: number): Side => {
    const pPick = w * p + (1 - w) * pm;
    // A push hands the stake back; otherwise the bet wins at the blended chance.
    const decided = 1 - pPush;
    return { side: s, price, pSim: p, pMarket: pm, pPick, pHit: pPush + decided * pPick, ev: pPush + decided * pPick * toDecimal(price) - 1 };
  };
  return [side('over', over, pOverDecided, mOver), side('under', under, 1 - pOverDecided, mUnder)];
}

/** Order of a logged box line. */
export const BOX = ['pts', 'reb', 'ast', 'tpm'] as const;

const settle = (v: number): BetResult => (v > 0 ? 'win' : v < 0 ? 'loss' : 'push');

/** One snapshot of a final game, graded; null until the box score is in. News snapshots: gradeNews. */
export function gradeProps(e: PropEntry, when: 'pre' | 'live'): GradedSnap | null {
  const snap = e[when];
  if (e.status !== 'final' || !e.box || !snap) return null;
  return gradeSnap(e, snap);
}

/**
 * Each news snapshot of a final game, graded. Its top picks are the props the news points to (the
 * over when the scratch lifts a player's simulated line, the under when it lowers it), ranked as the
 * app ranks them, and each records whether the book's line moved its way by just before tip.
 */
export function gradeNews(e: PropEntry): GradedSnap[] {
  if (e.status !== 'final' || !e.box || !e.news?.length) return [];
  return e.news.map((n) => gradeSnap(e, n, n));
}

/**
 * How the closing line moved for a pick: a higher line (or a dearer over) favors an over.
 * `pMarket` is the book's no-vig chance of the pick's side when it was made.
 */
export function lineMove(close: CloseLine[] | undefined, p: Pick<GradedProp, 'athleteId' | 'stat' | 'line' | 'side' | 'pMarket'>): 'toward' | 'away' | 'same' | undefined {
  const c = close?.find(([id, stat]) => id === p.athleteId && stat === p.stat);
  if (!c) return undefined;
  const [, , line, over, under] = c;
  let dir = Math.sign(line - p.line);
  if (!dir) {
    // Same line: compare the book's no-vig chance of the over then and now.
    const was = p.side === 'over' ? p.pMarket : 1 - p.pMarket;
    const now = noVig(over, under)[0];
    dir = Math.abs(now - was) < 0.005 ? 0 : Math.sign(now - was);
  }
  if (!dir) return 'same';
  return (dir > 0) === (p.side === 'over') ? 'toward' : 'away';
}

const movedFor = (e: PropEntry, p: GradedProp) => lineMove(e.close?.lines, p);

function gradeSnap(e: PropEntry, snap: PropSnap, news?: NewsSnap): GradedSnap {
  const box = e.box!;
  const label = `${e.away.abbr} @ ${e.home.abbr}`;
  const lines: GradedProp[] = [];
  const brier: GradedSnap['brier'] = [];
  const picks: { s: Side; grade: (s: Side) => GradedProp }[] = [];
  for (const [i, r] of snap.rows.entries()) {
    const [athleteId, stat, line, , , , , mean, now] = r;
    const b = box[athleteId];
    if (!b) continue;
    // News: only the side the scratch points to can be a pick.
    const shift = news ? mean - news.meanWith[i] : NaN;
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
    for (const s of [over, under]) {
      if (news && !(Math.abs(shift) >= (stat === 'tpm' ? 0.2 : 0.5) && (s.side === 'over') === shift > 0)) continue;
      if (s.ev > 0 && s.pHit >= HIT_FLOOR[1] && s.price <= MAX_PRICE[1]) picks.push({ s, grade: news ? (x) => ({ ...grade(x), news: { name: news.out.name, shift } }) : grade });
    }
  }
  const top = picks
    .sort((a, b) => b.s.ev - a.s.ev)
    .slice(0, TOP_PER_GAME)
    .map(({ s, grade }) => grade(s))
    .map((p) => (p.news ? { ...p, news: { ...p.news, moved: movedFor(e, p) } } : p));
  return { gameId: e.id, lines, top, brier };
}

export interface PropSummary {
  games: number;
  lines: number;
  top: Record3;
  every: Record3;
  /** News picks with a closing line: how often the book's line moved their way after the news. */
  moved?: { toward: number; away: number; same: number };
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
  const movedTop = snaps.flatMap((s) => s.top).filter((p) => p.news?.moved);
  return {
    ...(movedTop.length
      ? { moved: { toward: movedTop.filter((p) => p.news!.moved === 'toward').length, away: movedTop.filter((p) => p.news!.moved === 'away').length, same: movedTop.filter((p) => p.news!.moved === 'same').length } }
      : {}),
    games: snaps.length,
    lines: snaps.reduce((a, s) => a + s.lines.length, 0),
    top: record(snaps.flatMap((s) => s.top)),
    every: record(snaps.flatMap((s) => s.lines)),
    vsMarket,
  };
}
