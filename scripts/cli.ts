// Shared bits for the Node scripts.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyValueStore } from '../src/data/espn/client';

/** `--key value` and bare `--flag` arguments; anything else is ignored. */
export function args(argv = process.argv.slice(2)): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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
export function fileStore(dir: string): KeyValueStore {
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

