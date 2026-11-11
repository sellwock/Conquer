// Fits the pick model (src/model/propFit.ts) to the logged props, and tests it the only honest
// way: each day's lines are scored by a fit that saw only earlier days. Pure functions; the
// scheduled job writes the result to v1/fit/{league}.json and the site reads it.
import { makeRng } from '../lib/rng';
import { noVig, onePerPlayer, toDecimal } from '../model/parlays';
import { PARTS } from '../model/props';
import { TRUST_BOOK, fitFeatures, fittedFrom, type FitCoef, type FitFeatures, type PropFits } from '../model/propFit';
import type { LeagueId, PropStat } from '../model/types';
import { easternYmd } from './dates';
import { BOX, lineMove } from './propGrade';
import type { PropEntry } from './types';

/** Games a fit must have seen before its picks are scored, and before the site uses it. */
export const MIN_TRAIN_GAMES = 20;
/** A pick needs this expected return per unit staked, at the posted price, by the fitted chance. */
export const MIN_EDGE = 0.03;
/** Pull toward "the book is right", in the weight of this many average lines. */
export const RIDGE = 25;

/** The pre-game fit also scores each game's first snapshot ("open"); live has its own fit. */
export type FitWhen = 'pre' | 'live';

export interface FitRow {
  gameId: string;
  /** Eastern date of tip-off (yyyymmdd): the unit the walk-forward test steps by. */
  day: string;
  athleteId: string;
  stat: PropStat;
  line: number;
  over: number;
  under: number;
  /** Chances of the over, pushes left out: the book's without its margin, and the simulation's. */
  pMarket: number;
  pSim: number;
  won: 0 | 1;
  x: FitFeatures;
  model: string;
  /** Set on a game's second live snapshot, so its lines are bets of their own. */
  snap?: string;
}

/** Decided lines of final games from one kind of snapshot; players who sat are void, as at the book. */
export function fitRows(entries: PropEntry[], key: 'open' | 'pre' | 'live' | 'live2'): FitRow[] {
  const out: FitRow[] = [];
  for (const e of entries) {
    const snap = e[key];
    if (e.status !== 'final' || !e.box || !snap) continue;
    const day = easternYmd(new Date(e.tip));
    for (const [athleteId, stat, line, over, under, pOver, pPush] of snap.rows) {
      const b = e.box[athleteId];
      if (!b) continue;
      const final = PARTS[stat].reduce((a, k) => a + b[BOX.indexOf(k)], 0);
      if (final === line) continue;
      const pMarket = noVig(over, under)[0];
      const pSim = pPush < 1 ? pOver / (1 - pPush) : 0.5;
      out.push({ gameId: e.id, day, athleteId, stat, line, over, under, pMarket, pSim, won: final > line ? 1 : 0, x: fitFeatures(pMarket, pSim), model: snap.model, ...(key === 'live2' ? { snap: key } : {}) });
    }
  }
  return out;
}

/** Solves A·d = g in place (Gauss-Jordan with pivoting); null when A is singular. */
function solve(A: number[][], g: number[]): number[] | null {
  const k = g.length;
  const M = A.map((r, i) => [...r, g[i]]);
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < 1e-12) return null;
    [M[i], M[p]] = [M[p], M[i]];
    for (let c = k; c >= i; c--) M[i][c] /= M[i][i];
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = M[r][i];
      if (f) for (let c = i; c <= k; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((r) => r[k]);
}

/**
 * Logistic regression of "the over won" on a row's features, by Newton's method. Every coefficient
 * but the constant is pulled toward "the book is right" (TRUST_BOOK) with weight `ridge`, so a
 * small sample can't swing the fit.
 */
export function fitLogistic(rows: Pick<FitRow, 'x' | 'won'>[], ridge = RIDGE): FitCoef {
  const K = TRUST_BOOK.length;
  let b: number[] = [...TRUST_BOOK];
  if (!rows.length) return TRUST_BOOK;
  for (let it = 0; it < 30; it++) {
    const g = Array<number>(K).fill(0);
    const H = Array.from({ length: K }, () => Array<number>(K).fill(0));
    for (const r of rows) {
      const p = fittedFrom(b as FitCoef, r.x);
      const w = p * (1 - p);
      for (let a = 0; a < K; a++) {
        g[a] += (r.won - p) * r.x[a];
        for (let c = 0; c < K; c++) H[a][c] += w * r.x[a] * r.x[c];
      }
    }
    for (let a = 1; a < K; a++) {
      g[a] -= ridge * (b[a] - TRUST_BOOK[a]);
      H[a][a] += ridge;
    }
    const d = solve(H, g);
    if (!d) break;
    b = b.map((v, i) => v + d[i]);
    if (Math.max(...d.map(Math.abs)) < 1e-9) break;
  }
  return b as FitCoef;
}

export interface Scored {
  row: FitRow;
  /** The fitted chance of the over, from a fit that saw only earlier days. */
  pOver: number;
}

/**
 * Scores each day of `score` with a fit of `train`'s earlier days, once those hold enough games.
 * Scoring a different set (each game's first snapshot) by the pre-game rows' fit tests the same
 * model on earlier lines.
 */
export function walkForward(train: FitRow[], score: FitRow[] = train): Scored[] {
  const out: Scored[] = [];
  const days = [...new Set(score.map((r) => r.day))].sort();
  for (const day of days) {
    const seen = train.filter((r) => r.day < day);
    if (new Set(seen.map((r) => r.gameId)).size < MIN_TRAIN_GAMES) continue;
    const coef = fitLogistic(seen);
    for (const row of score) if (row.day === day) out.push({ row, pOver: fittedFrom(coef, row.x) });
  }
  return out;
}

export interface FitPick {
  gameId: string;
  athleteId: string;
  row: FitRow;
  side: 'over' | 'under';
  price: number;
  /** The fitted chance this side wins, and the expected return per unit staked at its price. */
  p: number;
  ev: number;
  won: boolean;
}

/**
 * The bets a fit would make, by the rule the site lists its best bets with (`onePerPlayer`): at
 * most one per player per game, the side and stat with the best expected return, if that clears
 * MIN_EDGE at a price no longer than the app's cap for single bets.
 */
export function picksOf(scored: Scored[], minEdge = MIN_EDGE): FitPick[] {
  const cands: FitPick[] = [];
  for (const { row, pOver } of scored) {
    for (const side of ['over', 'under'] as const) {
      const p = side === 'over' ? pOver : 1 - pOver;
      const price = side === 'over' ? row.over : row.under;
      cands.push({ gameId: `${row.gameId}${row.snap ?? ''}`, athleteId: row.athleteId, row, side, price, p, ev: p * toDecimal(price) - 1, won: (side === 'over') === (row.won === 1) });
    }
  }
  return onePerPlayer(cands, minEdge);
}

export interface FitTest {
  /** Lines, games and days scored out of sample. */
  lines: number;
  games: number;
  days: number;
  /** Brier score on the over (lower is better); diff is fit minus book, with a 95% range by game. */
  brier: { fit: number; market: number; diff: number; lo: number; hi: number };
  picks: {
    win: number;
    loss: number;
    units: number;
    /** Return per unit staked, with a 95% range from resampling whole games. */
    roi: number;
    lo: number;
    hi: number;
    /** The fit's average stated chance for these picks, to set against the share that won. */
    said: number;
    unders: number;
  };
  /** Picks with a closing line: how the book's line had moved by just before tip. */
  moved?: { toward: number; away: number; same: number };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** One unit on every line's over, or every line's under, at the posted price. */
export interface Flat {
  win: number;
  loss: number;
  /** Return per unit staked. */
  roi: number;
}

/** What betting blind costs: every over and every under among these lines, with no model at all. */
export function flatOf(rows: FitRow[]): { over: Flat; under: Flat } {
  const side = (over: boolean): Flat => {
    let win = 0, units = 0;
    for (const r of rows) {
      const won = (r.won === 1) === over;
      if (won) win++;
      units += won ? toDecimal(over ? r.over : r.under) - 1 : -1;
    }
    return { win, loss: rows.length - win, roi: r4(rows.length ? units / rows.length : 0) };
  };
  return { over: side(true), under: side(false) };
}

/** `entries` supplies closing lines for pre-game picks; leave it out for live ones, which a pre-game close can't judge. */
export function testOf(scored: Scored[], entries: PropEntry[] = [], minEdge = MIN_EDGE): FitTest {
  const picks = picksOf(scored, minEdge);
  const games = [...new Set(scored.map((s) => s.row.gameId))];
  // Per game: [pick units, picks, sum of (fit − book) squared-error differences, lines].
  const per = new Map(games.map((g) => [g, [0, 0, 0, 0]]));
  let fit = 0, market = 0;
  for (const { row, pOver } of scored) {
    const f = (pOver - row.won) ** 2, m = (row.pMarket - row.won) ** 2;
    fit += f;
    market += m;
    const p = per.get(row.gameId)!;
    p[2] += f - m;
    p[3]++;
  }
  let win = 0, units = 0, said = 0, unders = 0;
  for (const k of picks) {
    const u = k.won ? toDecimal(k.price) - 1 : -1;
    if (k.won) win++;
    units += u;
    said += k.p;
    if (k.side === 'under') unders++;
    const p = per.get(k.row.gameId)!;
    p[0] += u;
    p[1]++;
  }
  // Lines in one game rise and fall together, so the ranges resample whole games.
  const rng = makeRng('fit', scored.length);
  const B = 2000;
  const rois: number[] = [], diffs: number[] = [];
  const all = [...per.values()];
  for (let b = 0; b < B && all.length > 1; b++) {
    let u = 0, n = 0, d = 0, l = 0;
    for (let i = 0; i < all.length; i++) {
      const p = all[Math.floor(rng() * all.length)];
      u += p[0];
      n += p[1];
      d += p[2];
      l += p[3];
    }
    rois.push(n ? u / n : 0);
    diffs.push(l ? d / l : 0);
  }
  rois.sort((a, b) => a - b);
  diffs.sort((a, b) => a - b);
  const range = (xs: number[], v: number) => (xs.length ? { lo: r4(xs[Math.floor(B * 0.025)]), hi: r4(xs[Math.ceil(B * 0.975) - 1]) } : { lo: r4(v), hi: r4(v) });
  const n = scored.length || 1;
  const roi = picks.length ? units / picks.length : 0;
  const diff = (fit - market) / n;

  const byId = new Map(entries.map((e) => [e.id, e]));
  const moved = { toward: 0, away: 0, same: 0 };
  for (const k of picks) {
    const m = lineMove(byId.get(k.row.gameId)?.close?.lines, { athleteId: k.row.athleteId, stat: k.row.stat, line: k.row.line, side: k.side, pMarket: k.side === 'over' ? k.row.pMarket : 1 - k.row.pMarket });
    if (m) moved[m]++;
  }
  return {
    lines: scored.length,
    games: games.length,
    days: new Set(scored.map((s) => s.row.day)).size,
    brier: { fit: r4(fit / n), market: r4(market / n), diff: r4(diff), ...range(diffs, diff) },
    picks: { win, loss: picks.length - win, units: Math.round(units * 100) / 100, roi: r4(roi), ...range(rois, roi), said: r4(picks.length ? said / picks.length : 0), unders },
    ...(moved.toward + moved.away + moved.same ? { moved } : {}),
  };
}

export interface FitPart {
  /** Fitted on every graded line so far: what the site prices today's lines with. */
  coef: FitCoef;
  lines: number;
  games: number;
  /** Lines by the model version that simulated them. */
  models: Record<string, number>;
  /** Pre-game only: how many of the games were re-simulated history, not logged in real time. */
  resimulated?: number;
  /** Every over and every under among the lines, bet blind: the baseline a pick has to beat. */
  flat?: { over: Flat; under: Flat };
  /** The walk-forward test, once any day could be scored. */
  test?: FitTest;
  /** Pre-game only: the same test on each game's first snapshot, usually hours earlier. */
  open?: FitTest;
}

/**
 * v1/history/props/{league}.json: the season's finished games re-simulated with one model version
 * against the closing prop lines the book's feed keeps (scripts/props-backtest.ts). A new model
 * version changes what the simulation says about every line, so the lines the log priced with an
 * older version can't train the fit that prices today's; this replays them with the current one.
 */
export interface PropHistory {
  model: string;
  updatedAt: string;
  entries: PropEntry[];
}

export interface FitOptions {
  /** The model version pricing lines now. */
  model?: string;
  /** Used for the pre-game fit only when it was simulated by `model`. */
  history?: PropHistory;
}

/** Bumped when the file gains something the site reads, so the job rewrites an older one. 2: `flat`. */
export const FIT_FILE_VERSION = 2;

/** v1/fit/{league}.json */
export interface FitFile {
  /** FIT_FILE_VERSION when it was written; absent in the first files. */
  v?: number;
  updatedAt: string;
  league: LeagueId;
  /** The model version the pre-game fit's rows were simulated with, when they all were. */
  model?: string;
  /** The re-simulated history behind the pre-game fit. */
  history?: { model: string; updatedAt: string };
  minEdge: number;
  minTrainGames: number;
  pre?: FitPart;
  live?: FitPart;
}

/**
 * The fit and its test from the logged props. With a history re-simulated by the current model,
 * the pre-game fit trains on that model's rows only: games the log itself priced with it in real
 * time, and the history for every other game. Without one, every logged pre-game line counts,
 * whatever model priced it. The test on each game's first snapshot only ever uses real-time rows,
 * because a re-simulation knows who went on to play, which opening lines didn't. Live lines can't
 * be replayed, so the live fit pools every version, and both of a game's live snapshots.
 */
export function buildFit(entries: PropEntry[], league: LeagueId, now: Date, opts: FitOptions = {}): FitFile {
  const history = opts.model && opts.history?.model === opts.model && opts.history.entries.length ? opts.history : undefined;
  const fresh = history ? entries.filter((e) => e.pre?.model === opts.model) : entries;
  const freshIds = new Set(fresh.map((e) => e.id));
  const replayed = history ? history.entries.filter((e) => !freshIds.has(e.id)) : [];
  const part = (key: FitWhen): FitPart | undefined => {
    const rows = key === 'pre' ? [...fitRows(replayed, 'pre'), ...fitRows(fresh, 'pre')] : [...fitRows(entries, 'live'), ...fitRows(entries, 'live2')];
    const games = new Set(rows.map((r) => r.gameId)).size;
    if (games < MIN_TRAIN_GAMES) return undefined;
    const models: Record<string, number> = {};
    for (const r of rows) models[r.model] = (models[r.model] ?? 0) + 1;
    const scored = walkForward(rows);
    const first = key === 'pre' ? walkForward(rows, fitRows(fresh, 'open')) : [];
    const replayedIds = new Set(replayed.map((e) => e.id));
    return {
      coef: fitLogistic(rows).map(r4) as FitCoef,
      lines: rows.length,
      games,
      models,
      flat: flatOf(rows),
      ...(key === 'pre' && history ? { resimulated: new Set(rows.filter((r) => replayedIds.has(r.gameId)).map((r) => r.gameId)).size } : {}),
      // Closing lines only judge picks made before them: the log's own, not replayed closes or live ones.
      ...(scored.length ? { test: testOf(scored, key === 'pre' ? fresh : []) } : {}),
      ...(first.length ? { open: testOf(first, fresh) } : {}),
    };
  };
  const pre = part('pre'), live = part('live');
  return {
    v: FIT_FILE_VERSION,
    updatedAt: now.toISOString(),
    league,
    ...(history ? { model: history.model, history: { model: history.model, updatedAt: history.updatedAt } } : {}),
    minEdge: MIN_EDGE,
    minTrainGames: MIN_TRAIN_GAMES,
    ...(pre ? { pre } : {}),
    ...(live ? { live } : {}),
  };
}

/**
 * The coefficients the site may price with under model version `model`. The pre-game fit counts
 * only when that version simulated every line behind it: a new version changes what the simulation
 * says about each line, and until the season is replayed with it the old fit doesn't apply. Live
 * lines can't be replayed, so the live fit pools versions and always counts.
 */
export function fitsFor(file: FitFile | undefined, model: string): PropFits | undefined {
  if (!file) return undefined;
  const sameModel = !!file.pre && (file.model === model || Object.keys(file.pre.models).every((m) => m === model));
  const pre = sameModel ? file.pre!.coef : undefined;
  const live = file.live?.coef;
  if (!pre && !live) return undefined;
  return { ...(pre ? { pre } : {}), ...(live ? { live } : {}), minEdge: file.minEdge };
}
