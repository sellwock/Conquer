// A season-long test of the pick model. ESPN keeps the book's prop lines for finished games, with
// each line's opening and closing price, so this rebuilds finished games as of tip-off, simulates
// them, prices those lines, and runs the same fit and walk-forward test the forward log gets
// (src/track/fit.ts) over hundreds of games instead of a few weeks' worth.
//
//   npx tsx scripts/props-backtest.ts --league nba --ranges 20251201-20260412 [--max 1200]
//       [--sims 1000] [--book draft] [--cache .cache/bt] [--out props.md] [--json entries.json]
//       [--tuning "usagePriorMin=120,ratePriorMin=180,minutesNoise=0"]   (PLAYER_TUNING overrides)
//
// Two caveats when reading it. The rebuilt games know who actually played (the box score), which
// the simulation wouldn't have known for sure before tip, so the simulation's term here is an upper
// bound. And closing lines are the hardest to beat; the "open" rows show the same picks at the
// book's first prices.
import { appendFileSync, writeFileSync } from 'node:fs';
import { mapLimit, requestCount, setStore } from '../src/data/espn/client';
import { loadGame, loadScoreboard, pregameView } from '../src/data/espn/load';
import { loadProps, type PropLine } from '../src/data/espn/props';
import { makeRng } from '../src/lib/rng';
import { buildSpec, PLAYER_TUNING } from '../src/model/build';
import { noVig, toDecimal } from '../src/model/parlays';
import { REF_LINE } from '../src/model/propFit';
import { PARTS, propMarkets, rosterNames } from '../src/model/props';
import { seasonYear } from '../src/data/espn/parse';
import type { GameData, LeagueId, PropStat } from '../src/model/types';
import { MODEL_VERSION } from '../src/model/version';
import { runOutcomes } from '../src/sim/quick';
import { buildFit, fitRows, type FitPart, type FitRow, type FitTest } from '../src/track/fit';
import { propRows } from '../src/track/job';
import { evenly, finalsToGrade } from '../src/track/rebuild';
import type { PropEntry, PropRow } from '../src/track/types';
import { args, fileStore } from './cli';

function days(from: string, to: string): string[] {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const out: string[] = [];
  for (let t = d(from); t <= d(to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}

const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** A flat bet on `side` of every row `pick` chooses: record, return, and a 95% range by game. */
function flat(rows: FitRow[], pick: (r: FitRow) => 'over' | 'under' | null): string {
  const per = new Map<string, [number, number]>();
  let win = 0, n = 0, units = 0;
  for (const r of rows) {
    const side = pick(r);
    if (!side) continue;
    const won = (side === 'over') === (r.won === 1);
    const u = won ? toDecimal(side === 'over' ? r.over : r.under) - 1 : -1;
    n++;
    if (won) win++;
    units += u;
    const p = per.get(r.gameId) ?? [0, 0];
    per.set(r.gameId, [p[0] + u, p[1] + 1]);
  }
  if (!n) return '–';
  const all = [...per.values()], rng = makeRng('flat', n), rois: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let u = 0, k = 0;
    for (let i = 0; i < all.length; i++) {
      const p = all[Math.floor(rng() * all.length)];
      u += p[0];
      k += p[1];
    }
    rois.push(k ? u / k : 0);
  }
  rois.sort((x, y) => x - y);
  return `${win}-${n - win} (${pct(win / n)}), ${pct(units / n)} per bet (${pct(rois[50])} to ${pct(rois[1949])})`;
}

function testLine(t?: FitTest): string {
  if (!t) return 'not enough days';
  const p = t.picks, n = p.win + p.loss;
  return `${p.win}-${p.loss} (${pct(n ? p.win / n : 0)} won, fit said ${pct(p.said)}), ${pct(p.roi)} per bet (${pct(p.lo)} to ${pct(p.hi)}), ${n ? pct(p.unders / n, 0) : '–'} unders · Brier fit ${t.brier.fit.toFixed(4)} vs book ${t.brier.market.toFixed(4)} (${t.brier.lo.toFixed(4)} to ${t.brier.hi.toFixed(4)}) · ${t.games} games, ${t.days} days${t.moved ? ` · close moved toward ${t.moved.toward}, away ${t.moved.away}, same ${t.moved.same}` : ''}`;
}

function partLines(name: string, p?: FitPart): string {
  if (!p) return `- **${name}:** too few games\n`;
  return `- **${name}:** ${p.lines} lines, ${p.games} games. Coefficients [constant, book, simulation's disagreement, line size]: ${p.coef.join(', ')}\n  - At the close: ${testLine(p.test)}\n  - At the open: ${testLine(p.open)}\n`;
}

/** The same entries with the simulation's chance replaced by the book's, so its term can't matter. */
const withoutSim = (entries: PropEntry[]): PropEntry[] =>
  entries.map((e) => {
    const blind = (rows: PropRow[]): PropRow[] => rows.map((r) => [r[0], r[1], r[2], r[3], r[4], noVig(r[3], r[4])[0], 0, r[7]]);
    return { ...e, pre: e.pre && { ...e.pre, rows: blind(e.pre.rows) }, open: e.open && { ...e.open, rows: blind(e.open.rows) } };
  });

async function main() {
  const a = args(process.argv.slice(2));
  const league = (a.league === 'ncaam' ? 'ncaam' : 'nba') as LeagueId;
  const sims = Number(a.sims ?? 1000);
  const max = Number(a.max ?? 1200);
  const book = new RegExp(String(a.book ?? 'draft'), 'i');
  const store = fileStore(String(a.cache ?? '.cache/bt'));
  setStore(store);
  const tuning = typeof a.tuning === 'string' ? Object.fromEntries(a.tuning.split(',').map((kv) => [kv.split('=')[0].trim(), Number(kv.split('=')[1])])) : {};
  Object.assign(PLAYER_TUNING[league], tuning);
  const ranges = String(a.ranges ?? '20260105-20260331').split(',').map((r) => r.split('-') as [string, string]);

  // --- Finished games ------------------------------------------------------------------------------
  const found = new Map<string, { id: string; date: string }>();
  for (const [from, to] of ranges) {
    await mapLimit(days(from, to), 3, async (ymd: string) => {
      try {
        for (const g of finalsToGrade(await loadScoreboard(league, ymd), league)) found.set(g.id, { id: g.id, date: g.date });
      } catch (e) {
        console.log(`scoreboard ${ymd}: ${(e as Error).message}`);
      }
    });
  }
  const refs = evenly([...found.values()].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id)), max);
  console.log(`${league}: ${found.size} finished games; using ${refs.length}.`);

  // --- Each game as of tip-off, with the book's prop lines ----------------------------------------
  const loaded: { g: GameData; lines: PropLine[]; provider: string }[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  let done = 0;
  const t0 = Date.now();
  await mapLimit(refs, 3, async (r) => {
    try {
      // Closed games' lines never change, so one fetch per game is kept in the cache.
      const key = `props-history:${league}:${r.id}`;
      let board = JSON.parse(store.get(key) ?? 'null') as { provider?: string; lines: PropLine[] } | null;
      if (!board) {
        const b = await loadProps(league, r.id);
        board = { provider: b.provider, lines: b.lines };
        store.set(key, JSON.stringify(board));
      }
      if (!board.lines.length) skip('no prop lines kept');
      else if (!book.test(board.provider ?? '')) skip(`another book (${board.provider})`);
      else {
        const g = await loadGame(league, r.id, { sampleGames: 10, asOf: r.date });
        if (g.homeScore == null) skip('no final score');
        else loaded.push({ g, lines: board.lines, provider: board.provider ?? '' });
      }
    } catch (e) {
      skip((e as { status?: number }).status === 404 ? 'no odds kept' : `error: ${(e as Error).message.slice(0, 60)}`);
    }
    if (++done % 50 === 0 || done === refs.length) console.log(`${done}/${refs.length} · ${loaded.length} with props · ${requestCount()} requests · ${Math.round((Date.now() - t0) / 1000)}s`);
  });
  loaded.sort((x, y) => x.g.date.localeCompare(y.g.date) || x.g.id.localeCompare(y.g.id));

  // --- Simulate and price ---------------------------------------------------------------------------
  const entries: PropEntry[] = [];
  for (const { g, lines, provider } of loaded) {
    const { spec } = buildSpec(pregameView(g), { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
    const o = runOutcomes(spec, sims, g.id, { players: true });
    if (!o.players) continue;
    const names = rosterNames(g);
    const close = propMarkets(lines, o.players, names);
    const open = propMarkets(lines.filter((l) => l.open).map((l) => ({ ...l, ...l.open! })), o.players, names);
    if (!close.length) continue;
    const box: NonNullable<PropEntry['box']> = {};
    for (const p of [...g.home.players, ...g.away.players]) box[p.id] = p.actual?.played ? [p.actual.pts, p.actual.oreb + p.actual.dreb, p.actual.ast, p.actual.tpm] : null;
    const snap = (rows: PropRow[]) => ({ model: MODEL_VERSION, takenAt: g.date, provider, n: sims, rows });
    entries.push({
      id: g.id,
      league,
      season: seasonYear(g.date, league),
      tip: g.date,
      home: { id: g.home.id, abbr: g.home.abbr },
      away: { id: g.away.id, abbr: g.away.abbr },
      status: 'final',
      players: Object.fromEntries(close.map((m) => [m.athleteId, m.player])),
      pre: snap(propRows(close)),
      ...(open.length ? { open: snap(propRows(open)) } : {}),
      close: { takenAt: g.date, lines: lines.map((l) => [l.athleteId, l.stat, l.line, l.over, l.under]) },
      box,
    });
  }

  // --- Report ----------------------------------------------------------------------------------------
  const now = new Date();
  const fit = buildFit(entries, league, now);
  const blind = buildFit(withoutSim(entries), league, now);
  const closeRows = fitRows(entries, 'pre'), openRows = fitRows(entries, 'open');
  const byMonth: Record<string, number> = {};
  for (const e of entries) byMonth[e.tip.slice(0, 7)] = (byMonth[e.tip.slice(0, 7)] ?? 0) + 1;

  const tuned = Object.keys(tuning).length ? `, with ${Object.entries(tuning).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
  let md = `## Props backtest, ${league.toUpperCase()}: ${entries.length} games, ${closeRows.length} decided closing lines, ${sims} sims per game (model ${MODEL_VERSION}${tuned})\n\n`;
  md += `Games by month: ${Object.entries(byMonth).map(([m, n]) => `${m} ${n}`).join(', ')}. Left out: ${Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join('; ') || 'none'}.\n\n`;
  md += `### The pick model, each day scored by a fit of earlier days (picks need ${pct(fit.minEdge, 0)} expected return)\n\n`;
  md += partLines('With the simulation', fit.pre);
  md += partLines("Book's odds and line size only", blind.pre);

  const scoring = (s: PropStat) => PARTS[s].includes('pts');
  const small = (r: FitRow) => r.line < REF_LINE[r.stat] * 0.8;
  md += `\n### Flat bets, no model (record, return per bet, 95% range by game)\n\n| Rule | At the close | At the open |\n|---|---|---|\n`;
  const rules: [string, (r: FitRow) => 'over' | 'under' | null][] = [
    ['Every under', () => 'under'],
    ['Every over', () => 'over'],
    ['Unders on small scoring lines (under 80% of typical)', (r) => (scoring(r.stat) && small(r) ? 'under' : null)],
    ['Unders on small other lines', (r) => (!scoring(r.stat) && small(r) ? 'under' : null)],
    ['Unders on points lines under 12', (r) => (r.stat === 'pts' && r.line < 12 ? 'under' : null)],
    ['Overs on points lines of 24 or more', (r) => (r.stat === 'pts' && r.line >= 24 ? 'over' : null)],
    ['The simulation\'s side when it disagrees by 15+ points of chance', (r) => (Math.abs(r.pSim - r.pMarket) >= 0.15 ? (r.pSim > r.pMarket ? 'over' : 'under') : null)],
  ];
  for (const [name, pick] of rules) md += `| ${name} | ${flat(closeRows, pick)} | ${flat(openRows, pick)} |\n`;

  md += `\n### Overs won, by stat and line size, at the close (book's average chance for the over in brackets)\n\n| Stat | Small lines | Typical | Large lines |\n|---|---|---|---|\n`;
  for (const stat of Object.keys(REF_LINE) as PropStat[]) {
    const cell = (f: (r: FitRow) => boolean) => {
      const x = closeRows.filter((r) => r.stat === stat && f(r));
      return x.length ? `${pct(mean(x.map((r) => r.won)), 0)} [${pct(mean(x.map((r) => r.pMarket)), 0)}] of ${x.length}` : '–';
    };
    const ref = REF_LINE[stat];
    md += `| ${stat} | ${cell((r) => r.line < ref * 0.8)} | ${cell((r) => r.line >= ref * 0.8 && r.line <= ref * 1.3)} | ${cell((r) => r.line > ref * 1.3)} |\n`;
  }

  // How lines moved from open to close.
  let down = 0, up = 0, same = 0;
  for (const e of entries) {
    const opens = new Map((e.open?.rows ?? []).map((r) => [`${r[0]}|${r[1]}`, r[2]]));
    for (const r of e.pre!.rows) {
      const was = opens.get(`${r[0]}|${r[1]}`);
      if (was == null) continue;
      if (r[2] < was) down++;
      else if (r[2] > was) up++;
      else same++;
    }
  }
  md += `\nFrom open to close, ${down} lines fell, ${up} rose and ${same} stayed (${openRows.length} decided opening lines).\n`;

  console.log('\n' + md);
  if (typeof a.out === 'string') writeFileSync(a.out, md);
  if (typeof a.json === 'string') writeFileSync(a.json, JSON.stringify(entries));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
