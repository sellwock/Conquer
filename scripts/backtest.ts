// Backtest harness for model changes. `run` rebuilds a fixed set of finished games as of tip-off
// with the model in --root (default: this checkout) and saves the graded entries; `compare` pairs
// a branch's run with its base's, game by game. Used by .github/workflows/backtest.yml.
//
//   npx tsx scripts/backtest.ts run --league nba [--from 20260105 --to 20260331 --max 600]
//       [--games earlier-run.json] [--root ../base] [--sims 2000] [--cache .cache/bt] --out head.json
//   npx tsx scripts/backtest.ts compare --head head.json [--base base.json] [--title NBA] [--out summary.md]
//
// --games reuses another run's game list, so a base run grades exactly the branch's games.
// --root evaluates another checkout's model (its src/ is imported directly; it needs no install).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LeagueId, ScoreboardGame } from '../src/model/types';
import type { Entry } from '../src/track/types';
import { compareRuns, comparisonMarkdown } from '../src/track/compare';
import { evenly, finalsToGrade } from '../src/track/rebuild';
import { args, fileStore } from './cli';

/** Last season's regular season by default: big enough to settle a Brier difference. */
const DEFAULT_RANGE: Record<LeagueId, [string, string]> = {
  nba: ['20260105', '20260331'],
  ncaam: ['20260110', '20260301'],
};

interface GameRef {
  id: string;
  date: string;
}

interface RunFile {
  league: LeagueId;
  model: string;
  sims: number;
  games: GameRef[];
  entries: Entry[];
  failed: number;
  errors: string[];
}

function days(from: string, to: string): string[] {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const out: string[] = [];
  for (let t = d(from); t <= d(to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}

async function run(a: Record<string, string | boolean>) {
  const root = resolve(String(a.root ?? '.'));
  if (!existsSync(join(root, 'src/track/rebuild.ts'))) {
    console.log(`${root} predates the backtest harness; nothing to run.`);
    return;
  }
  const mod = (p: string) => import(pathToFileURL(join(root, p)).href);
  const client = await mod('src/data/espn/client.ts');
  const load = await mod('src/data/espn/load.ts');
  const { rebuildGame } = await mod('src/track/rebuild.ts');
  const { runOutcomes } = await mod('src/sim/quick.ts');
  const { MODEL_VERSION } = await mod('src/model/version.ts');
  client.setStore(fileStore(String(a.cache ?? '.cache/bt')));

  const league = (a.league === 'ncaam' ? 'ncaam' : 'nba') as LeagueId;
  const sims = Number(a.sims ?? 2000);
  let games: GameRef[];
  if (typeof a.games === 'string') {
    games = (JSON.parse(readFileSync(a.games, 'utf8')) as RunFile).games;
  } else {
    const [from, to] = [String(a.from ?? DEFAULT_RANGE[league][0]), String(a.to ?? DEFAULT_RANGE[league][1])];
    const found = new Map<string, GameRef>();
    await client.mapLimit(days(from, to), 3, async (ymd: string) => {
      try {
        const board: ScoreboardGame[] = await load.loadScoreboard(league, ymd);
        for (const g of finalsToGrade(board, league)) found.set(g.id, { id: g.id, date: g.date });
      } catch (e) {
        console.log(`scoreboard ${ymd}: ${(e as Error).message}`);
      }
    });
    const all = [...found.values()].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
    games = evenly(all, Number(a.max ?? 600));
    console.log(`${league}: ${all.length} finished games from ${from} to ${to}; using ${games.length}.`);
  }

  console.log(`Model ${MODEL_VERSION} from ${root}, ${sims} sims per game.`);
  const entries: Entry[] = [];
  const errors: string[] = [];
  let done = 0;
  const started = Date.now();
  await client.mapLimit(games, 3, async (g: GameRef) => {
    try {
      const e: Entry | null = await rebuildGame(league, g, sims, runOutcomes);
      if (e) entries.push(e);
      else errors.push(`${g.id}: no final score`);
    } catch (err) {
      errors.push(`${g.id}: ${(err as Error).message}`);
    }
    if (++done % 25 === 0 || done === games.length)
      console.log(`${done}/${games.length} · ${errors.length} failed · ${client.requestCount()} requests · ${Math.round((Date.now() - started) / 1000)}s`);
  });
  entries.sort((x, y) => x.tip.localeCompare(y.tip) || x.id.localeCompare(y.id));
  const out: RunFile = { league, model: MODEL_VERSION, sims, games, entries, failed: errors.length, errors: errors.slice(0, 50) };
  writeFileSync(String(a.out ?? 'backtest.json'), JSON.stringify(out));
  if (errors.length) console.log(`First failures:\n${errors.slice(0, 10).join('\n')}`);
}

function compare(a: Record<string, string | boolean>) {
  const read = (p: unknown) => (typeof p === 'string' && existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as RunFile) : undefined);
  const head = read(a.head);
  if (!head) throw new Error('compare needs --head <run.json>');
  const base = read(a.base);
  const title = String(a.title ?? head.league.toUpperCase());
  let md = comparisonMarkdown(title, compareRuns(head.entries, base?.entries));
  const failures = [`branch ${head.failed} of ${head.games.length}`, ...(base ? [`base ${base.failed} of ${base.games.length}`] : [])];
  md += `\nGames that failed to load: ${failures.join(', ')}. ${base ? '' : 'No base run, so no paired comparison.'}\n`;
  console.log(md);
  if (typeof a.out === 'string') writeFileSync(a.out, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

const cmd = process.argv[2];
const a = args(process.argv.slice(3));
if (cmd === 'run') {
  run(a).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'compare') {
  compare(a);
} else {
  console.error('usage: backtest.ts run|compare [options]');
  process.exit(2);
}
