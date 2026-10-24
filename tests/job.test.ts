// The forward-log cycle against mocked ESPN: snapshot before tip, refresh near tip, never write
// after tip, grade finals, void the stuck, and record final scores.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { setFetch, setStore } from '../src/data/espn/client';
import { easternYmd, logPath, resultsPath, runJob, type LogIO } from '../src/track/job';
import type { Entry, LogFile } from '../src/track/types';
import { MODEL_VERSION } from '../src/model/version';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

let summaryOverride: Record<string, unknown> = {};

function mockEspn() {
  setFetch((async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    let body: unknown;
    if (u.pathname.includes('mens-college-basketball')) body = { events: [] };
    else if (u.pathname.endsWith('/scoreboard')) body = fx('synthetic-nba-scoreboard.json');
    else if (u.pathname.endsWith('/summary')) {
      const ev = u.searchParams.get('event')!;
      body = summaryOverride[ev] ?? (ev === '401810131' ? fx('synthetic-nba-summary-pregame.json') : fx('synthetic-nba-summary-final.json'));
    } else if (u.pathname.includes('/roster')) body = fx('synthetic-nba-team-roster.json');
    else if (u.pathname.includes('/schedule')) {
      const s = fx('synthetic-nba-team-schedule.json');
      s.events = [{ ...s.events[0], id: '401800001', date: '2026-01-10T00:30Z' }, ...s.events];
      body = s;
    } else if (u.pathname.endsWith('/gamelog')) body = fx('synthetic-nba-athlete-gamelog-v3.json');
    else if (u.pathname.endsWith('/stats')) body = fx('synthetic-nba-athlete-stats-v3.json');
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
}

function memoryIO() {
  const files = new Map<string, unknown>();
  const io: LogIO = {
    read: <T>(p: string) => (files.has(p) ? (JSON.parse(JSON.stringify(files.get(p))) as T) : undefined),
    write: (p, d) => void files.set(p, JSON.parse(JSON.stringify(d))),
  };
  return { io, files };
}

const run = (io: LogIO, now: string) => runJob({ now: new Date(now), io, leagues: ['nba', 'ncaam'], budget: 5000, sims: 200, sampleGames: 3 });

// The pre-game fixture tips 2026-01-17T00:30Z (7:30 pm Eastern on Jan 16).
const PRE_PATH = logPath('nba', 2026, '20260116');

beforeEach(() => {
  summaryOverride = {};
  const mem = new Map<string, string>();
  setStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), clearPrefix: () => mem.clear() });
  mockEspn();
});

describe('forward log job', () => {
  it('uses Eastern dates like ESPN', () => {
    expect(easternYmd(new Date('2026-01-17T00:30:00Z'))).toBe('20260116');
    expect(easternYmd(new Date('2026-01-17T06:00:00Z'))).toBe('20260117');
  });

  it('snapshots within 12 hours, refreshes near tip, and never writes after tip', async () => {
    const { io, files } = memoryIO();
    // 16 hours out: too early.
    let r = await run(io, '2026-01-16T08:30:00Z');
    expect(r.snapshots).toBe(0);

    // 4.5 hours out: first snapshot.
    r = await run(io, '2026-01-16T20:00:00Z');
    expect(r.snapshots).toBe(1);
    const first = (files.get(PRE_PATH) as LogFile)['401810131'];
    expect(first).toMatchObject({ status: 'open', league: 'nba', home: { abbr: 'NY' }, away: { abbr: 'BKN' } });
    expect(first.pred).toMatchObject({ model: MODEL_VERSION, n: 200, minsToTip: 270 });
    expect(first.pred!.marginPmf[1].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(first.line?.spread).toBeDefined();

    // Two hours out: outside the refresh window, untouched.
    r = await run(io, '2026-01-16T22:30:00Z');
    expect(r.refreshed + r.snapshots).toBe(0);

    // An hour out and the last snapshot is old: refreshed.
    r = await run(io, '2026-01-16T23:30:00Z');
    expect(r.refreshed).toBe(1);
    expect((files.get(PRE_PATH) as LogFile)['401810131'].pred!.minsToTip).toBe(60);

    // Past tip (the fixture still says "pre"): nothing written.
    const before = JSON.stringify(files.get(PRE_PATH));
    r = await run(io, '2026-01-17T01:00:00Z');
    expect(r.snapshots + r.refreshed).toBe(0);
    expect(JSON.stringify(files.get(PRE_PATH))).toBe(before);
  });

  it('grades finals with the reported line, leaves live games open and voids the stuck', async () => {
    const { io, files } = memoryIO();
    const path = logPath('nba', 2026, '20260114');
    const open: Entry = {
      id: '401810123',
      league: 'nba',
      season: 2026,
      tip: '2026-01-15T00:30:00Z',
      home: { id: '2', abbr: 'BOS' },
      away: { id: '13', abbr: 'LAL' },
      neutral: false,
      status: 'open',
    };
    files.set(path, { [open.id]: open });

    // Still live three hours after tip: stays open.
    const live = fx('synthetic-nba-summary-final.json');
    live.header.competitions[0].status.type = { state: 'in', completed: false, name: 'STATUS_IN_PROGRESS' };
    summaryOverride['401810123'] = live;
    await run(io, '2026-01-15T03:30:00Z');
    expect((files.get(path) as LogFile)['401810123'].status).toBe('open');

    // Final: graded with the score and the reported line.
    delete summaryOverride['401810123'];
    const r = await run(io, '2026-01-15T04:00:00Z');
    expect(r.graded).toBe(1);
    const graded = (files.get(path) as LogFile)['401810123'];
    expect(graded.status).toBe('final');
    expect(graded.result).toMatchObject({ home: 122, away: 113, ot: false });
    expect(graded.closeReported?.total).toBe(224.5);

    // A game stuck "in progress" for three days is given up on.
    files.set(path, { [open.id]: open });
    summaryOverride['401810123'] = live;
    const r2 = await run(io, '2026-01-18T02:00:00Z');
    expect(r2.voided).toBe(1);
    expect((files.get(path) as LogFile)['401810123'].status).toBe('void');
  });

  it('records yesterday\'s finals once and writes a heartbeat', async () => {
    const { io, files } = memoryIO();
    await run(io, '2026-01-16T15:00:00Z'); // yesterday (Eastern) = Jan 15; the fixture's final counts
    await run(io, '2026-01-16T16:00:00Z');
    const rows = files.get(resultsPath('nba', 2026)) as unknown[][];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['20260115', '2', '13', 122, 113, false, false]);
    expect(files.get('status.json')).toMatchObject({ lastRun: '2026-01-16T16:00:00.000Z', model: MODEL_VERSION });
  });
});
