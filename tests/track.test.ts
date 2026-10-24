import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch, setStore } from '../src/data/espn/client';
import { backtestKey, runBacktest } from '../src/track/backtest';
import { loadForwardLog } from '../src/track/forward';
import { gradeEntry } from '../src/track/grade';
import type { Entry } from '../src/track/types';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

afterEach(() => vi.unstubAllGlobals());

describe('browser backtest', () => {
  it('rebuilds finished games as of tip, grades them and caches by model version', async () => {
    const mem = new Map<string, string>();
    setStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), clearPrefix: () => mem.clear() });
    let summaries = 0;
    setFetch((async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      let body: unknown;
      if (u.pathname.endsWith('/scoreboard')) body = fx('synthetic-nba-scoreboard.json');
      else if (u.pathname.endsWith('/summary')) {
        summaries++;
        body = fx('synthetic-nba-summary-final.json');
      } else if (u.pathname.includes('/schedule')) {
        const s = fx('synthetic-nba-team-schedule.json');
        s.events = [{ ...s.events[0], id: '401800001', date: '2026-01-10T00:30Z' }, ...s.events];
        body = s;
      } else if (u.pathname.endsWith('/gamelog')) body = fx('synthetic-nba-athlete-gamelog-v3.json');
      else if (u.pathname.endsWith('/stats')) body = fx('synthetic-nba-athlete-stats-v3.json');
      else if (u.pathname.includes('/roster')) throw new Error('a backtest must not read today\'s roster');
      if (body === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch);

    const progress: number[] = [];
    const r = await runBacktest({ league: 'nba', days: 2, end: new Date('2026-01-16T17:00:00Z'), sims: 200, onProgress: (p) => progress.push(p.done) });
    expect(r.failed).toBe(0);
    expect(r.entries).toHaveLength(1); // the same final appears on both days' scoreboards
    const e = r.entries[0];
    expect(e).toMatchObject({ id: '401810123', status: 'final', result: { home: 122, away: 113 } });
    expect(e.pred!.n).toBe(200);
    expect(gradeEntry(e)!.ats).toBeDefined();
    expect(mem.has(`conquer.c1.${backtestKey('nba', '401810123')}`)).toBe(true);

    // A second run comes straight from the cache.
    const before = summaries;
    await runBacktest({ league: 'nba', days: 2, end: new Date('2026-01-16T17:00:00Z'), sims: 200 });
    expect(summaries).toBe(before);
  });
});

describe('forward log loader', () => {
  const entry = (id: string, tip: string): Entry => ({ id, league: 'nba', season: 2027, tip, home: { id: 'h', abbr: 'H' }, away: { id: 'a', abbr: 'A' }, neutral: false, status: 'open' });

  it('reads the index and the league\'s files, newest first, falling back to the mirror', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('raw.githubusercontent.com')) throw new TypeError('blocked');
      const path = url.split('@data/v1/')[1];
      const body: Record<string, unknown> = {
        'index.json': { files: ['nba/2027/2026-10.json', 'ncaam/2027/2026-11.json'] },
        'status.json': { lastRun: '2026-10-24T01:07:00Z', model: '1.0.0' },
        'nba/2027/2026-10.json': { '1': entry('1', '2026-10-21T23:00:00Z'), '2': entry('2', '2026-10-23T23:00:00Z') },
      };
      return path in body ? new Response(JSON.stringify(body[path]), { status: 200 }) : new Response('', { status: 404 });
    });
    const log = await loadForwardLog('nba');
    expect(log.status?.model).toBe('1.0.0');
    expect(log.entries.map((e) => e.id)).toEqual(['2', '1']);
    expect(calls.some((c) => c.includes('ncaam'))).toBe(false);
  });

  it('treats a missing log as empty', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const log = await loadForwardLog('nba');
    expect(log.entries).toEqual([]);
  });
});
