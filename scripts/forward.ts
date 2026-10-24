// Forward log job: snapshots pre-game predictions, grades finished games and records final
// scores into the `data` branch checkout. Run by .github/workflows/forward.yml.
//
//   npx tsx scripts/forward.ts --data data/v1 --cache .cache/espn [--now 2026-10-24T22:00:00Z]
//                              [--leagues nba,ncaam] [--budget 1500] [--sims 5000] [--dry]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setStore, type KeyValueStore } from '../src/data/espn/client';
import { runJob, type LogIO } from '../src/track/job';
import type { LeagueId } from '../src/model/types';

function args() {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

/** One file per cache key, so the GitHub Actions cache can carry extracts between runs. */
function fileStore(dir: string): KeyValueStore {
  mkdirSync(dir, { recursive: true });
  const fileOf = (key: string) => join(dir, key.replace(/[^a-z0-9._-]/gi, '_'));
  return {
    get: (key) => (existsSync(fileOf(key)) ? readFileSync(fileOf(key), 'utf8') : null),
    set: (key, value) => writeFileSync(fileOf(key), value),
    clearPrefix: (prefix) => {
      for (const f of readdirSync(dir)) if (f.startsWith(prefix.replace(/[^a-z0-9._-]/gi, '_'))) rmSync(join(dir, f));
    },
  };
}

/** Log files keep one entry per line so the data branch diffs stay readable. */
function stringify(data: unknown): string {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>);
    return `{\n${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`;
  }
  if (Array.isArray(data)) return `[\n${data.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
  return `${JSON.stringify(data)}\n`;
}

async function main() {
  const a = args();
  const dataDir = String(a.data ?? 'data/v1');
  const dry = a.dry === true;
  setStore(fileStore(String(a.cache ?? '.cache/espn')));
  const io: LogIO = {
    read: <T>(path: string) => {
      const f = join(dataDir, path);
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : undefined;
    },
    write: (path, data) => {
      if (dry) return;
      const f = join(dataDir, path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, stringify(data));
    },
  };
  const report = await runJob({
    now: a.now ? new Date(String(a.now)) : new Date(),
    io,
    leagues: String(a.leagues ?? 'nba,ncaam').split(',') as LeagueId[],
    budget: Number(a.budget ?? 1500),
    sims: Number(a.sims ?? 5000),
    sampleGames: 10,
    log: (m) => console.log(m),
  });
  console.log(JSON.stringify(report, null, 2));
  if (dry) console.log('Dry run: nothing written.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
