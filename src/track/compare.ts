// Compares two backtest runs of the same games (a branch and its base) game by game. Paired
// differences cancel out the luck of which games were in the sample, so they settle much sooner
// than comparing two records side by side.
import { bootstrapMean, gradeEntry, summarize, type Graded, type Summary } from './grade';
import type { Entry } from './types';

export interface RunStats {
  model: string;
  summary: Summary;
  /** Mean of (predicted - actual): positive means the model runs high. */
  totalBias: number;
  marginBias: number;
  /** Predicted overtime chance vs how often games went to overtime. */
  otPredicted: number;
  otActual: number;
}

export interface PairedDiff {
  mean: number;
  lo: number;
  hi: number;
}

export interface Comparison {
  head: RunStats;
  base?: RunStats;
  /** head minus base on the games both graded; negative is better for every metric here. */
  paired?: { n: number; brier: PairedDiff; logLoss: PairedDiff; marginAbs: PairedDiff; totalAbs: PairedDiff };
}

const clamp = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const sq = (g: Graded) => (g.pHome - g.homeWon) ** 2;
const ll = (g: Graded) => -(g.homeWon ? Math.log(clamp(g.pHome)) : Math.log(1 - clamp(g.pHome)));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function runStats(entries: Entry[]): RunStats {
  const graded = entries.map(gradeEntry).filter((g): g is Graded => !!g);
  const finals = entries.filter((e) => e.pred && e.result);
  return {
    model: [...new Set(graded.map((g) => g.model))].join(', '),
    summary: summarize(graded),
    totalBias: mean(finals.map((e) => e.pred!.meanTotal - (e.result!.home + e.result!.away))),
    marginBias: mean(finals.map((e) => e.pred!.meanMargin - (e.result!.home - e.result!.away))),
    otPredicted: mean(finals.map((e) => e.pred!.otPct)),
    otActual: mean(finals.map((e) => (e.result!.ot ? 1 : 0))),
  };
}

export function compareRuns(head: Entry[], base?: Entry[]): Comparison {
  const out: Comparison = { head: runStats(head) };
  if (!base) return out;
  out.base = runStats(base);
  const b = new Map(base.map(gradeEntry).filter((g): g is Graded => !!g).map((g) => [g.id, g]));
  const pairs = head
    .map(gradeEntry)
    .filter((g): g is Graded => !!g && b.has(g.id))
    .map((h) => [h, b.get(h.id)!] as const);
  const diff = (f: (g: Graded) => number, seed: string) => bootstrapMean(pairs.map(([h, x]) => f(h) - f(x)), 2000, seed);
  out.paired = {
    n: pairs.length,
    brier: diff(sq, 'brier'),
    logLoss: diff(ll, 'logloss'),
    marginAbs: diff((g) => Math.abs(g.marginError), 'margin'),
    totalAbs: diff((g) => Math.abs(g.totalError), 'total'),
  };
  return out;
}

/** "better" / "worse" only when the 95% interval excludes zero. */
export function verdict(d: PairedDiff): 'better' | 'worse' | 'no clear change' {
  return d.hi < 0 ? 'better' : d.lo > 0 ? 'worse' : 'no clear change';
}

const f3 = (x: number) => x.toFixed(3);
const f1 = (x: number) => x.toFixed(1);
const signed = (x: number, d: number) => `${x > 0 ? '+' : ''}${x.toFixed(d)}`;
const rec = (r: { win: number; loss: number; push: number }) => `${r.win}-${r.loss}${r.push ? `-${r.push}` : ''} (${r.win + r.loss ? ((100 * r.win) / (r.win + r.loss)).toFixed(1) : '–'}%)`;

export function comparisonMarkdown(title: string, c: Comparison): string {
  const runs = [['Branch', c.head], ...(c.base ? [['Base', c.base]] : [])] as [string, RunStats][];
  const rows: [string, (s: RunStats) => string][] = [
    ['Model version', (s) => s.model || '–'],
    ['Games graded', (s) => String(s.summary.n)],
    ['Brier (win prob)', (s) => f3(s.summary.brier)],
    ['Log loss', (s) => f3(s.summary.logLoss)],
    ['Brier vs market', (s) => (s.summary.vsMarket ? `${signed(s.summary.vsMarket.diff, 3)} (${signed(s.summary.vsMarket.lo, 3)} to ${signed(s.summary.vsMarket.hi, 3)})` : '–')],
    ['Against the spread', (s) => rec(s.summary.ats)],
    ['Over/under', (s) => rec(s.summary.ou)],
    ['Margin error (MAE)', (s) => f1(s.summary.marginMAE)],
    ['Total error (MAE)', (s) => f1(s.summary.totalMAE)],
    ['Total bias', (s) => signed(s.totalBias, 1)],
    ['Overtime: predicted vs actual', (s) => `${(100 * s.otPredicted).toFixed(1)}% vs ${(100 * s.otActual).toFixed(1)}%`],
  ];
  const lines = [`### ${title}`, '', `| | ${runs.map(([n]) => n).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`];
  for (const [label, f] of rows) lines.push(`| ${label} | ${runs.map(([, s]) => f(s)).join(' | ')} |`);
  if (c.paired) {
    const p = c.paired;
    const row = (label: string, d: PairedDiff, digits: number) => `| ${label} | ${signed(d.mean, digits)} | ${signed(d.lo, digits)} to ${signed(d.hi, digits)} | ${verdict(d)} |`;
    lines.push(
      '',
      `Paired on ${p.n} games (branch minus base; negative is better):`,
      '',
      '| Metric | Difference | 95% interval | Verdict |',
      '|---|---|---|---|',
      row('Brier', p.brier, 4),
      row('Log loss', p.logLoss, 4),
      row('Margin abs error', p.marginAbs, 2),
      row('Total abs error', p.totalAbs, 2),
    );
  }
  return lines.join('\n') + '\n';
}
