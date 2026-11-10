// Fits the pick model to the logged props and prints its walk-forward test, the same way the
// scheduled job writes v1/fit/{league}.json. For checking the numbers by hand.
//
//   npx tsx scripts/fit.ts [--league nba] [--data data/v1 | --ref origin/data] [--out fit.json]
//
// --data reads a checkout of the `data` branch; --ref reads it straight from git (default origin/data).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeagueId } from '../src/model/types';
import { MODEL_VERSION } from '../src/model/version';
import { buildFit, type FitPart, type FitTest, type PropHistory } from '../src/track/fit';
import type { PropLogFile } from '../src/track/types';
import { args } from './cli';

const a = args();
const league = (a.league === 'ncaam' ? 'ncaam' : 'nba') as LeagueId;
const ref = String(a.ref ?? 'origin/data');
const read = <T>(path: string): T | undefined => {
  if (typeof a.data === 'string') {
    const f = join(a.data, path);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : undefined;
  }
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:v1/${path}`], { maxBuffer: 1 << 29 }).toString()) as T;
  } catch {
    return undefined;
  }
};

const files = (read<{ files: string[] }>('index.json')?.files ?? []).filter((f) => f.startsWith(`props/${league}/`));
const entries = files.flatMap((f) => Object.values(read<PropLogFile>(f) ?? {}));
// The job's inputs: a re-simulated history counts only when the current model made it.
const history = read<PropHistory>(`history/props/${league}.json`);
const fit = buildFit(entries, league, new Date(), { model: MODEL_VERSION, history: history?.model === MODEL_VERSION ? history : undefined });

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const test = (name: string, t?: FitTest) => {
  if (!t) return console.log(`  ${name}: not enough days yet`);
  const p = t.picks, n = p.win + p.loss;
  console.log(`  ${name}: ${t.lines} lines, ${t.games} games, ${t.days} days out of sample`);
  console.log(`    Brier: fit ${t.brier.fit.toFixed(4)} vs book ${t.brier.market.toFixed(4)} (diff ${t.brier.diff.toFixed(4)}, ${t.brier.lo.toFixed(4)} to ${t.brier.hi.toFixed(4)})`);
  console.log(`    picks: ${p.win}-${p.loss} (${pct(n ? p.win / n : 0)} won, the fit said ${pct(p.said)}), return ${pct(p.roi)} per bet (${pct(p.lo)} to ${pct(p.hi)}), ${p.unders} unders`);
  if (t.moved) console.log(`    closing line moved toward ${t.moved.toward}, away ${t.moved.away}, same ${t.moved.same}`);
};
const part = (name: string, p?: FitPart) => {
  if (!p) return console.log(`${name}: fewer than ${fit.minTrainGames} graded games`);
  console.log(`${name}: ${p.lines} lines in ${p.games} games ${JSON.stringify(p.models)}${p.resimulated != null ? `, ${p.resimulated} games re-simulated` : ''}`);
  console.log(`  coefficients [constant, book, simulation's disagreement]: ${p.coef.join(', ')}`);
  test('walk-forward', p.test);
  if (name === 'pre-game') test('first snapshot ("open")', p.open);
};
console.log(`${league.toUpperCase()}: ${entries.length} prop entries from ${files.length} file${files.length === 1 ? '' : 's'}; picks need ${pct(fit.minEdge)} expected return`);
part('pre-game', fit.pre);
part('live', fit.live);
if (typeof a.out === 'string') writeFileSync(a.out, `${JSON.stringify(fit, null, 1)}\n`);
