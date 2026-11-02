// Grades the simulation's player lines against real box scores. Props live or die on these: the
// bias of each player's simulated average, how often the actual line lands inside the simulation's
// middle 80%, and CRPS (a proper score over every possible line; lower is better). Pure functions.
import type { GameData } from '../model/types';
import type { PlayerOutcomes } from '../sim/players';

export const PLAYER_STATS = ['pts', 'reb', 'ast', 'pra'] as const;
export type PlayerStat = (typeof PLAYER_STATS)[number];

/** Players the app prices props for: projected at least this many minutes (MIN_MINUTES). */
export const PROP_MINUTES = 15;

/** One player in one game: [simulated mean, actual, CRPS, inside the middle 80%] per stat. */
export interface PlayerEval {
  game: string;
  id: string;
  /** Projected minutes (the simulation's target), mean simulated minutes and actual minutes. */
  proj: number;
  simMin: number;
  min: number;
  /** "star": one of his team's two highest simulated scorers; "bench": projected under 20 minutes. */
  tier: 'star' | 'rotation' | 'bench';
  stats: Record<PlayerStat, [mean: number, actual: number, crps: number, inside: 0 | 1]>;
}

/** CRPS of a sample against one outcome: E|X − y| − ½·E|X − X'|. Sorts `xs` in place. */
export function crps(xs: Float64Array, y: number): number {
  const n = xs.length;
  if (!n) return NaN;
  xs.sort();
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    a += Math.abs(xs[i] - y);
    b += (2 * i - n + 1) * xs[i];
  }
  return a / n - b / (n * n);
}

const quantile = (sorted: Float64Array, q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * Every player who played in `game` (its box score) and was in the simulation, graded against his
 * simulated lines. `proj` gives each player's projected minutes (the spec's targets).
 */
export function evaluatePlayers(game: GameData, po: PlayerOutcomes, proj: Map<string, number>): PlayerEval[] {
  const P = po.ids.length;
  if (!P) return [];
  const n = po.pts.length / P;
  const index = new Map(po.ids.map((id, j) => [id, j]));
  const out: PlayerEval[] = [];
  for (const team of [game.home, game.away]) {
    const rows: PlayerEval[] = [];
    for (const p of team.players) {
      const a = p.actual;
      const j = index.get(p.id);
      const target = proj.get(p.id) ?? 0;
      if (!a?.played || j == null || target <= 0) continue;
      const actual: Record<PlayerStat, number> = { pts: a.pts, reb: a.oreb + a.dreb, ast: a.ast, pra: a.pts + a.oreb + a.dreb + a.ast };
      const stats = {} as PlayerEval['stats'];
      for (const k of PLAYER_STATS) {
        const xs = new Float64Array(n);
        for (let s = 0; s < n; s++) {
          const o = s * P + j;
          xs[s] = k === 'pts' ? po.pts[o] : k === 'reb' ? po.reb[o] : k === 'ast' ? po.ast[o] : po.pts[o] + po.reb[o] + po.ast[o];
        }
        let mean = 0;
        for (const x of xs) mean += x;
        mean /= n;
        const c = crps(xs, actual[k]); // sorts xs
        const inside = actual[k] >= quantile(xs, 0.1) && actual[k] <= quantile(xs, 0.9) ? 1 : 0;
        stats[k] = [round(mean, 2), actual[k], round(c, 3), inside];
      }
      rows.push({ game: game.id, id: p.id, proj: round(target, 1), simMin: round(po.min[j], 1), min: round(a.min, 1), tier: target < 20 ? 'bench' : 'rotation', stats });
    }
    // His team's two highest simulated scorers are its stars.
    for (const r of [...rows].sort((x, y) => y.stats.pts[0] - x.stats.pts[0]).slice(0, 2)) r.tier = 'star';
    out.push(...rows);
  }
  return out;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export interface StatSummary {
  /** Simulated mean minus actual, on average (negative = projects low). */
  bias: number;
  mae: number;
  crps: number;
  /** Share of actual lines inside the simulation's middle 80% (0.8 is honest; less = too sure). */
  inside: number;
}

export interface PlayerSummary {
  n: number;
  stats: Record<PlayerStat, StatSummary>;
  /** Points, PRA and simulated-minutes bias for stars and for the bench. */
  starBias: { pts: number; pra: number; min: number; n: number };
  benchBias: { pts: number; pra: number; min: number; n: number };
  /** Mean absolute miss on minutes: the projection, and the simulated average. */
  minutesMae: { proj: number; sim: number };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Averages over players projected at least `minProj` minutes (the ones props are priced for). */
export function summarizePlayers(rows: PlayerEval[], minProj = PROP_MINUTES): PlayerSummary {
  const rs = rows.filter((r) => r.proj >= minProj);
  const stats = {} as PlayerSummary['stats'];
  for (const k of PLAYER_STATS) {
    const v = rs.map((r) => r.stats[k]);
    stats[k] = {
      bias: mean(v.map((x) => x[0] - x[1])),
      mae: mean(v.map((x) => Math.abs(x[0] - x[1]))),
      crps: mean(v.map((x) => x[2])),
      inside: mean(v.map((x) => x[3])),
    };
  }
  const biasOf = (sub: PlayerEval[]) => ({
    pts: mean(sub.map((r) => r.stats.pts[0] - r.stats.pts[1])),
    pra: mean(sub.map((r) => r.stats.pra[0] - r.stats.pra[1])),
    min: mean(sub.map((r) => r.simMin - r.min)),
    n: sub.length,
  });
  return {
    n: rs.length,
    stats,
    starBias: biasOf(rs.filter((r) => r.tier === 'star')),
    benchBias: biasOf(rows.filter((r) => r.tier === 'bench' && r.proj >= 8)),
    minutesMae: { proj: mean(rs.map((r) => Math.abs(r.proj - r.min))), sim: mean(rs.map((r) => Math.abs(r.simMin - r.min))) },
  };
}

/** A markdown table of player summaries side by side (e.g. settings, or base vs branch). */
export function playersMarkdown(cols: { label: string; s: PlayerSummary }[]): string {
  const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const sgn = (x: number) => (x > 0 ? '+' : '') + f(x);
  const line = (name: string, g: (s: PlayerSummary) => string) => `| ${name} | ${cols.map((c) => g(c.s)).join(' | ')} |`;
  const out = [`| | ${cols.map((c) => c.label).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`, line('Players (15+ projected min)', (s) => String(s.n))];
  for (const k of PLAYER_STATS) {
    const name = k.toUpperCase();
    out.push(line(`${name} CRPS (lower is better)`, (s) => f(s.stats[k].crps, 3)));
    out.push(line(`${name} bias`, (s) => sgn(s.stats[k].bias)));
    out.push(line(`${name} inside middle 80%`, (s) => `${f(s.stats[k].inside * 100, 0)}%`));
  }
  out.push(line('Stars: PTS / PRA / minutes bias', (s) => `${sgn(s.starBias.pts)} / ${sgn(s.starBias.pra)} / ${sgn(s.starBias.min)}`));
  out.push(line('Bench (8–20 min): PTS / PRA / minutes bias', (s) => `${sgn(s.benchBias.pts)} / ${sgn(s.benchBias.pra)} / ${sgn(s.benchBias.min)}`));
  out.push(line('Minutes miss: projection / sim avg', (s) => `${f(s.minutesMae.proj, 1)} / ${f(s.minutesMae.sim, 1)}`));
  return out.join('\n') + '\n';
}
