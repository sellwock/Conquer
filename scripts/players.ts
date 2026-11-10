// Fits the player-level knobs (PLAYER_TUNING[league] in src/model/build.ts) against real box scores. Each
// finished game is rebuilt as it looked at tip-off, simulated with every setting, and each player's
// simulated lines are graded against what he did (src/track/players.ts). By default, stage 1 tries
// how hard usage and per-minute rates are pulled toward position averages, and stage 2 adds
// game-to-game variation in minutes and usage on top of stage 1's best. --full tries every
// combination of the lists instead, and --try runs just the settings given (the first is the
// reference). Every setting's game predictions are graded too, paired against the first setting's,
// since a change that sharpens player lines can still blunt the game lines.
//
//   npx tsx scripts/players.ts --league nba --ranges 20261020-20261101,20260105-20260331
//       [--max 120] [--sims 1000] [--cache .cache/bt] [--out players.md]
//       [--usage 120,60,30] [--rate 180,90,45] [--minutes 0,1,1.5] [--usage-noise 0,0.12,0.2] [--full]
//       [--try "usagePriorMin=120,ratePriorMin=180,minutesNoise=0;usagePriorMin=15"]
import { appendFileSync, writeFileSync } from 'node:fs';
import { setStore, mapLimit, requestCount } from '../src/data/espn/client';
import { loadGame, loadScoreboard, pregameView } from '../src/data/espn/load';
import { buildSpec, PLAYER_TUNING, type PlayerTuning } from '../src/model/build';
import { LEAGUES } from '../src/model/leagues';
import type { GameData, LeagueId } from '../src/model/types';
import { seasonYear } from '../src/data/espn/parse';
import { runOutcomes } from '../src/sim/quick';
import { compareRuns, runStats, verdict, type PairedDiff } from '../src/track/compare';
import { predictionFromOutcomes } from '../src/track/predict';
import { evenly, finalsToGrade } from '../src/track/rebuild';
import { evaluatePlayers, playersMarkdown, summarizePlayers, type PlayerEval, type PlayerSummary } from '../src/track/players';
import type { Entry } from '../src/track/types';
import { args, fileStore } from './cli';

type Setting = Partial<PlayerTuning>;

function days(from: string, to: string): string[] {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const out: string[] = [];
  for (let t = d(from); t <= d(to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}

const label = (s: Setting) =>
  Object.entries(s)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || 'current';

async function main() {
  const a = args(process.argv.slice(2));
  const league = (a.league === 'ncaam' ? 'ncaam' : 'nba') as LeagueId;
  const sims = Number(a.sims ?? 1000);
  const max = Number(a.max ?? 120);
  setStore(fileStore(String(a.cache ?? '.cache/bt')));
  const ranges = String(a.ranges ?? '20260105-20260331').split(',').map((r) => r.split('-') as [string, string]);

  // --- Games, as they looked at tip-off ----------------------------------------------------------
  const sets: { name: string; games: GameData[] }[] = [];
  for (const [from, to] of ranges) {
    const found = new Map<string, { id: string; date: string }>();
    await mapLimit(days(from, to), 3, async (ymd: string) => {
      try {
        for (const g of finalsToGrade(await loadScoreboard(league, ymd), league)) found.set(g.id, { id: g.id, date: g.date });
      } catch (e) {
        console.log(`scoreboard ${ymd}: ${(e as Error).message}`);
      }
    });
    const refs = evenly([...found.values()].sort((x, y) => x.date.localeCompare(y.date)), max);
    const games: GameData[] = [];
    let failed = 0;
    await mapLimit(refs, 3, async (r) => {
      try {
        const g = await loadGame(league, r.id, { sampleGames: 10, asOf: r.date });
        if (g.homeScore != null) games.push(g);
      } catch {
        failed++;
      }
    });
    games.sort((x, y) => x.date.localeCompare(y.date));
    console.log(`${from}-${to}: ${found.size} finals, ${games.length} loaded, ${failed} failed · ${requestCount()} requests`);
    sets.push({ name: `${from}–${to}`, games });
  }

  // --- Simulate every game with a setting, and grade the players and the game ---------------------
  const tuning = PLAYER_TUNING[league];
  const defaults = { ...tuning };
  const evaluate = (s: Setting): { rows: Record<string, PlayerEval[]>; entries: Entry[] } => {
    Object.assign(tuning, defaults, s);
    const out: Record<string, PlayerEval[]> = {};
    const entries: Entry[] = [];
    for (const set of sets) {
      out[set.name] = [];
      for (const g of set.games) {
        const built = buildSpec(pregameView(g), { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
        const { spec } = built;
        const proj = new Map([...spec.home.players, ...spec.away.players].map((p) => [p.id, p.targetMin]));
        const o = runOutcomes(spec, sims, g.id, { players: true });
        if (o.players) out[set.name].push(...evaluatePlayers(g, o.players, proj));
        entries.push({
          id: g.id,
          league,
          season: seasonYear(g.date, league),
          tip: g.date,
          home: { id: g.home.id, abbr: g.home.abbr },
          away: { id: g.away.id, abbr: g.away.abbr },
          neutral: g.neutral,
          status: 'final',
          pred: predictionFromOutcomes(o, built, g.date, g.date),
          line: g.odds ? { ...g.odds, fetchedAt: '' } : undefined,
          result: { home: g.homeScore!, away: g.awayScore!, ot: g.period > LEAGUES[league].periods, gradedAt: '' },
        });
      }
    }
    Object.assign(tuning, defaults);
    return { rows: out, entries };
  };
  const results: { s: Setting; rows: Record<string, PlayerEval[]>; entries: Entry[] }[] = [];
  const run = (s: Setting) => {
    const t0 = Date.now();
    const { rows, entries } = evaluate(s);
    results.push({ s, rows, entries });
    const all = summarizePlayers(Object.values(rows).flat());
    const st = runStats(entries);
    console.log(
      `${label(s)}: PRA CRPS ${all.stats.pra.crps.toFixed(3)}, PTS bias ${all.stats.pts.bias.toFixed(2)}, stars ${all.starBias.pts.toFixed(2)}, PTS inside ${(all.stats.pts.inside * 100).toFixed(0)}%` +
        ` · games: Brier ${st.summary.brier.toFixed(4)}, margin MAE ${st.summary.marginMAE.toFixed(2)}, total bias ${st.totalBias.toFixed(2)} (${Math.round((Date.now() - t0) / 1000)}s)`,
    );
    return all;
  };
  /** Mean CRPS over points, rebounds and assists, each relative to the current model's. */
  const score = (x: PlayerSummary, base: PlayerSummary) => (['pts', 'reb', 'ast'] as const).reduce((acc, k) => acc + x.stats[k].crps / base.stats[k].crps, 0) / 3;

  const list = (k: string, d: number[]) => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]).split(',').map(Number) : d);
  const grid = {
    usagePriorMin: list('usage', [120, 60, 30]),
    ratePriorMin: list('rate', [180, 90, 45]),
    minutesNoise: list('minutes', [0, 1, 1.5]),
    usageNoise: list('usage-noise', [0, 0.12, 0.2]),
  };
  // Explicit settings: "key=value,key=value;key=value", the first being the reference.
  const tries =
    typeof a.try === 'string'
      ? a.try.split(';').map((t) => Object.fromEntries(t.split(',').filter(Boolean).map((kv) => [kv.split('=')[0].trim(), Number(kv.split('=')[1])])) as Setting)
      : undefined;
  const reference = tries?.[0] ?? {};
  const base = run(reference);
  let best: { s: Setting; v: number } = { s: reference, v: 1 };
  const tryIt = (s: Setting) => {
    const v = score(run(s), base);
    if (v < best.v) best = { s, v };
  };
  if (tries) {
    for (const t of tries.slice(1)) tryIt(t);
  } else if (a.full) {
    for (const usagePriorMin of grid.usagePriorMin)
      for (const ratePriorMin of grid.ratePriorMin)
        for (const minutesNoise of grid.minutesNoise) for (const usageNoise of grid.usageNoise) tryIt({ usagePriorMin, ratePriorMin, minutesNoise, usageNoise });
  } else {
    // Stage 1: how hard usage and rates are pulled toward position averages.
    for (const usagePriorMin of grid.usagePriorMin)
      for (const ratePriorMin of grid.ratePriorMin) {
        if (usagePriorMin === defaults.usagePriorMin && ratePriorMin === defaults.ratePriorMin) continue;
        tryIt({ usagePriorMin, ratePriorMin });
      }
    // Stage 2: game-to-game variation on top of the best priors.
    const priors = { ...best.s };
    for (const minutesNoise of grid.minutesNoise)
      for (const usageNoise of grid.usageNoise) {
        if (!minutesNoise && !usageNoise) continue;
        tryIt({ ...priors, minutesNoise, usageNoise });
      }
  }

  // --- Report ------------------------------------------------------------------------------------
  const ranked = results
    .map((r) => ({ ...r, all: summarizePlayers(Object.values(r.rows).flat()) }))
    .map((r) => ({ ...r, v: score(r.all, base) }))
    .sort((x, y) => x.v - y.v);
  let md = `## Player lines, ${league.toUpperCase()}: ${sims} sims per game\n\n`;
  md += `Best: **${label(best.s)}** (CRPS ${((1 - best.v) * 100).toFixed(1)}% better than current on points, rebounds and assists).\n\n`;
  md += `### All settings, best first (relative CRPS; 1 = current)\n\n| Setting | Relative CRPS | PRA CRPS | PTS bias | Star PTS bias | PTS inside 80% |\n|---|---|---|---|---|---|\n`;
  for (const r of ranked)
    md += `| ${label(r.s)} | ${r.v.toFixed(3)} | ${r.all.stats.pra.crps.toFixed(3)} | ${r.all.stats.pts.bias.toFixed(2)} | ${r.all.starBias.pts.toFixed(2)} | ${(r.all.stats.pts.inside * 100).toFixed(0)}% |\n`;
  md += gamesMarkdown(results.map((r) => ({ label: label(r.s), entries: r.entries })));
  const top = ranked[0];
  for (const set of sets) {
    md += `\n### ${set.name} (${set.games.length} games): current vs best\n\n`;
    md += playersMarkdown([
      { label: 'Current', s: summarizePlayers(results[0].rows[set.name]) },
      { label: label(top.s), s: summarizePlayers(top.rows[set.name]) },
    ]);
  }
  console.log('\n' + md);
  if (typeof a.out === 'string') writeFileSync(a.out, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

/**
 * Every setting's game predictions, paired against the first setting's. The slope regresses the
 * actual margin on the predicted one: below 1 means the predictions spread teams too far apart,
 * above 1 not far enough.
 */
function gamesMarkdown(runs: { label: string; entries: Entry[] }[]): string {
  const [ref, ...rest] = runs;
  const pd = (d: PairedDiff | undefined, digits: number) => (d ? `${d.mean > 0 ? '+' : ''}${d.mean.toFixed(digits)} (${d.lo.toFixed(digits)} to ${d.hi.toFixed(digits)}, ${verdict(d)})` : '–');
  const slope = (es: Entry[]) => {
    const xs = es.filter((e) => e.pred && e.result).map((e) => [e.pred!.meanMargin, e.result!.home - e.result!.away] as const);
    const mx = xs.reduce((a, [x]) => a + x, 0) / xs.length, my = xs.reduce((a, [, y]) => a + y, 0) / xs.length;
    const sxy = xs.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0), sxx = xs.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    return { slope: sxx > 0 ? sxy / sxx : NaN, sd: Math.sqrt(sxx / Math.max(1, xs.length - 1)) };
  };
  let md = `\n### Game predictions by setting (paired against ${ref.label}; negative is better)\n\n`;
  md += `| Setting | Brier | Brier vs reference | Log loss vs reference | Margin MAE | Margin MAE vs reference | Total MAE vs reference | Total bias | Margin bias | Margin slope | Predicted margin SD |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of [ref, ...rest]) {
    const c = compareRuns(r.entries, r === ref ? undefined : ref.entries);
    const h = c.head;
    const sl = slope(r.entries);
    md += `| ${r.label} | ${h.summary.brier.toFixed(4)} | ${pd(c.paired?.brier, 4)} | ${pd(c.paired?.logLoss, 4)} | ${h.summary.marginMAE.toFixed(2)} | ${pd(c.paired?.marginAbs, 2)} | ${pd(c.paired?.totalAbs, 2)} | ${h.totalBias.toFixed(2)} | ${h.marginBias.toFixed(2)} | ${sl.slope.toFixed(3)} | ${sl.sd.toFixed(2)} |\n`;
  }
  return md;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
