// The forward-log cycle against mocked ESPN: snapshot before tip, refresh near tip, never write
// after tip, grade finals, void the stuck, and record final scores.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { setFetch, setStore } from '../src/data/espn/client';
import { easternYmd, logPath, playedShare, propsPath, resultsPath, runJob, type LogIO } from '../src/track/job';
import type { Entry, LogFile, PropEntry, PropLogFile } from '../src/track/types';
import { gradeProps } from '../src/track/propGrade';
import { MODEL_VERSION } from '../src/model/version';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

let summaryOverride: Record<string, unknown> = {};
let noLines = false;
/** Serve the core odds feed with prop lines (off: it 404s, as for a game without odds). */
let withProps = false;
let coreStatus = 200;
/** Puts the final fixture's game (401810123) in progress on the scoreboard at this period and clock. */
let liveAt: { period: number; clock: string } | undefined;
let summaryCalls: Record<string, number> = {};
let noLiveProps = false;

const ath = (id: string) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/athletes/${id}?lang=en&region=us` });
const pair = (id: string, typeId: string, line: number, over: string, under: string) =>
  [over, under].map((am) => ({ athlete: ath(id), type: { id: typeId, name: 'x' }, odds: { american: { value: am } }, current: { target: { value: line } } }));

function coreBody(u: URL): unknown {
  if (u.pathname.endsWith('/odds'))
    return {
      items: [
        { provider: { id: '100', name: 'DraftKings' }, propBets: { $ref: `http://sports.core.api.espn.com${u.pathname}/100/propBets` } },
        { provider: { id: '200', name: 'DraftKings - Live Odds' }, propBets: { $ref: `http://sports.core.api.espn.com${u.pathname}/200/propBets` }, spread: -6.5, overUnder: 230.5 },
      ],
    };
  if (u.pathname.endsWith('/100/propBets')) return { pageCount: 1, items: [...pair('4432101', '1', 20.5, '-110', '-110'), ...pair('4432104', '2', 5.5, '+100', '-120')] };
  if (u.pathname.endsWith('/200/propBets') && noLiveProps) return { pageCount: 1, items: [] };
  if (u.pathname.endsWith('/200/propBets')) return { pageCount: 1, items: [...pair('4432201', '1', 34.5, '-110', '-120'), ...pair('4432101', '3', 6.5, '+105', '-135')] };
  return undefined;
}

function liveStatus(period: number, clock: string) {
  const [m, sec] = clock.split(':').map(Number);
  return { period, displayClock: clock, clock: m * 60 + sec, type: { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, detail: `${clock} - ${period}`, shortDetail: `${clock} - ${period}` } };
}

type Payload = { events?: { competitions?: { odds?: unknown }[] }[]; pickcenter?: unknown; odds?: unknown };

/** The fixtures as they look before the book posts a line. */
function stripLines(body: Payload) {
  for (const ev of body.events ?? []) for (const c of ev.competitions ?? []) delete c.odds;
  delete body.pickcenter;
  delete body.odds;
  return body;
}

function mockEspn() {
  setFetch((async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    let body: unknown;
    if (u.hostname === 'sports.core.api.espn.com') {
      if (!withProps) return new Response('{}', { status: 404 });
      if (coreStatus !== 200) return new Response('{}', { status: coreStatus });
      body = coreBody(u);
    } else if (u.pathname.includes('mens-college-basketball')) body = { events: [] };
    else if (u.pathname.endsWith('/scoreboard')) {
      const b = fx('synthetic-nba-scoreboard.json');
      if (liveAt) b.events.find((e: { id: string }) => e.id === '401810123').competitions[0].status = liveStatus(liveAt.period, liveAt.clock);
      body = b;
    } else if (u.pathname.endsWith('/summary')) {
      const ev = u.searchParams.get('event')!;
      summaryCalls[ev] = (summaryCalls[ev] ?? 0) + 1;
      if (liveAt && ev === '401810123') {
        const b = fx('synthetic-nba-summary-final.json');
        b.header.competitions[0].status = liveStatus(liveAt.period, liveAt.clock);
        body = b;
      } else body = summaryOverride[ev] ?? (ev === '401810131' ? fx('synthetic-nba-summary-pregame.json') : fx('synthetic-nba-summary-final.json'));
    } else if (u.pathname.includes('/roster')) body = fx('synthetic-nba-team-roster.json');
    else if (u.pathname.includes('/schedule')) {
      const s = fx('synthetic-nba-team-schedule.json');
      s.events = [{ ...s.events[0], id: '401800001', date: '2026-01-10T00:30Z' }, ...s.events];
      body = s;
    } else if (u.pathname.endsWith('/gamelog')) body = fx('synthetic-nba-athlete-gamelog-v3.json');
    else if (u.pathname.endsWith('/stats')) body = fx('synthetic-nba-athlete-stats-v3.json');
    if (body === undefined) return new Response('{}', { status: 404 });
    if (noLines) body = stripLines(body as Payload);
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
  noLines = false;
  withProps = false;
  coreStatus = 200;
  liveAt = undefined;
  summaryCalls = {};
  noLiveProps = false;
  const mem = new Map<string, string>();
  setStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), clearPrefix: () => mem.clear() });
  mockEspn();
});

describe('forward log job', () => {
  it('uses Eastern dates like ESPN', () => {
    expect(easternYmd(new Date('2026-01-17T00:30:00Z'))).toBe('20260116');
    expect(easternYmd(new Date('2026-01-17T06:00:00Z'))).toBe('20260117');
  });

  it('snapshots up to 30 hours out, refreshes in the last 3 hours, and never writes after tip', async () => {
    const { io, files } = memoryIO();
    // 31 hours out: too early.
    let r = await run(io, '2026-01-15T17:30:00Z');
    expect(r.snapshots).toBe(0);

    // 20 hours out: first snapshot.
    r = await run(io, '2026-01-16T04:30:00Z');
    expect(r.snapshots).toBe(1);
    const first = (files.get(PRE_PATH) as LogFile)['401810131'];
    expect(first).toMatchObject({ status: 'open', league: 'nba', home: { abbr: 'NY' }, away: { abbr: 'BKN' } });
    expect(first.pred).toMatchObject({ model: MODEL_VERSION, n: 200, minsToTip: 1200 });
    expect(first.pred!.marginPmf[1].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(first.line?.spread).toBeDefined();

    expect(files.get('index.json')).toEqual({ files: [PRE_PATH] });

    // Four hours out: outside the refresh window, untouched.
    r = await run(io, '2026-01-16T20:30:00Z');
    expect(r.refreshed + r.snapshots).toBe(0);

    // Two and a half hours out with an old snapshot: refreshed.
    r = await run(io, '2026-01-16T22:00:00Z');
    expect(r.refreshed).toBe(1);
    expect((files.get(PRE_PATH) as LogFile)['401810131'].pred!.minsToTip).toBe(150);

    // Two hours out, but the snapshot is only 30 minutes old: untouched.
    r = await run(io, '2026-01-16T22:30:00Z');
    expect(r.refreshed + r.snapshots).toBe(0);

    // Past tip (the fixture still says "pre"): nothing written.
    const before = JSON.stringify(files.get(PRE_PATH));
    r = await run(io, '2026-01-17T01:00:00Z');
    expect(r.snapshots + r.refreshed).toBe(0);
    expect(JSON.stringify(files.get(PRE_PATH))).toBe(before);
  });

  it('redoes a snapshot taken before the line was posted once the line appears', async () => {
    const { io, files } = memoryIO();
    noLines = true;
    let r = await run(io, '2026-01-16T04:30:00Z');
    expect(r.snapshots).toBe(1);
    expect((files.get(PRE_PATH) as LogFile)['401810131'].line).toBeUndefined();

    // Still no line an hour later: left alone.
    r = await run(io, '2026-01-16T05:30:00Z');
    expect(r.refreshed + r.snapshots).toBe(0);

    // The line is up, far outside the three-hour window: refreshed with it.
    noLines = false;
    r = await run(io, '2026-01-16T06:30:00Z');
    expect(r.refreshed).toBe(1);
    const e = (files.get(PRE_PATH) as LogFile)['401810131'];
    expect(e.line?.spread).toBeDefined();
    expect(e.pred!.minsToTip).toBe(1080);

    // With the line saved, the usual windows apply again.
    r = await run(io, '2026-01-16T08:30:00Z');
    expect(r.refreshed + r.snapshots).toBe(0);
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

  it('counts overtime from the line score, since final summaries leave status.period out', async () => {
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
    const ot = fx('synthetic-nba-summary-final.json');
    expect(ot.header.competitions[0].status.period).toBeUndefined();
    ot.header.competitions[0].competitors.forEach((c: { linescores: unknown[] }) => c.linescores.push({ displayValue: '9' }));
    summaryOverride['401810123'] = ot;
    await run(io, '2026-01-15T04:00:00Z');
    expect((files.get(path) as LogFile)['401810123'].result).toMatchObject({ ot: true });
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

// Both fixtures' games fall in January 2026, so their props share a file.
const PROPS = propsPath('nba', 2026, '20260116');

describe('player props in the forward log', () => {
  it('saves the posted prop lines with the pre-game snapshot', async () => {
    withProps = true;
    const { io, files } = memoryIO();
    const r = await run(io, '2026-01-16T22:00:00Z');
    expect(r.snapshots).toBe(1);
    expect(r.propsPre).toBe(1);
    expect(PROPS).toBe('props/nba/2026/2026-01.json');
    const e = (files.get(PROPS) as PropLogFile)['401810131'];
    expect(e).toMatchObject({ status: 'open', home: { abbr: 'NY' }, away: { abbr: 'BKN' }, players: { '4432101': 'M. Hale' } });
    expect(e.pre).toMatchObject({ model: MODEL_VERSION, provider: 'DraftKings', n: 200 });
    const hale = e.pre!.rows.find((x) => x[0] === '4432101' && x[1] === 'pts')!;
    expect(hale.slice(2, 5)).toEqual([20.5, -110, -110]);
    expect(hale[5]).toBeGreaterThan(0);
    expect(hale[5] + hale[6]).toBeLessThanOrEqual(1);
    expect(hale).toHaveLength(8); // no "so far" before tip
    expect(e.live).toBeUndefined();
    expect((files.get('index.json') as { files: string[] }).files).toEqual([PRE_PATH, PROPS]);
  });

  it("keeps the game's snapshot when the prop feed fails", async () => {
    withProps = true;
    coreStatus = 403;
    const { io, files } = memoryIO();
    const r = await run(io, '2026-01-16T22:00:00Z');
    expect(r.snapshots).toBe(1);
    expect(r.propsPre).toBe(0);
    expect(r.errors.some((x) => / props: /.test(x))).toBe(true);
    expect((files.get(PRE_PATH) as LogFile)['401810131'].pred).toBeDefined();
    expect(files.get(PROPS)).toBeUndefined();
  });

  it('takes no props and logs no error for a game without odds', async () => {
    const { io, files } = memoryIO();
    const r = await run(io, '2026-01-16T22:00:00Z');
    expect(r.snapshots).toBe(1);
    expect(r.errors).toEqual([]);
    expect(files.get(PROPS)).toBeUndefined();
  });

  it('saves the live lines once per game, mid-game only', async () => {
    withProps = true;
    const { io, files } = memoryIO();
    // 1st quarter: too early.
    liveAt = { period: 1, clock: '5:00' };
    let r = await run(io, '2026-01-15T00:45:00Z');
    expect(r.propsLive).toBe(0);
    expect(files.get(PROPS)).toBeUndefined();

    // 2nd quarter: saved, with the game state and what each player had.
    liveAt = { period: 2, clock: '5:00' };
    r = await run(io, '2026-01-15T01:15:00Z');
    expect(r.propsLive).toBe(1);
    const e = (files.get(PROPS) as PropLogFile)['401810123'];
    expect(e.live).toMatchObject({ model: MODEL_VERSION, provider: 'DraftKings - Live Odds', n: 200, at: { period: 2, clockSec: 300, home: 122, away: 113 } });
    expect(e.players['4432201']).toBe('C. Vance');
    const vance = e.live!.rows.find((x) => x[0] === '4432201' && x[1] === 'pts')!;
    expect(vance[8]).toBe(27);
    expect(vance[7]).toBeGreaterThanOrEqual(27);
    expect(e.pre).toBeUndefined();

    // A later run, still mid-game: the saved lines stay as they were.
    liveAt = { period: 3, clock: '6:00' };
    const before = JSON.stringify(files.get(PROPS));
    r = await run(io, '2026-01-15T01:45:00Z');
    expect(r.propsLive).toBe(0);
    expect(JSON.stringify(files.get(PROPS))).toBe(before);
  });

  it('loads nothing more for a live game whose book has no in-game props', async () => {
    withProps = true;
    liveAt = { period: 2, clock: '5:00' };
    const { io, files } = memoryIO();
    const before = { ...summaryCalls };
    const r = await run(io, '2026-01-15T01:15:00Z');
    expect(r.propsLive).toBe(1);
    expect(summaryCalls['401810123'] - (before['401810123'] ?? 0)).toBe(2); // the load and the refresh

    // Same game, but the feed has no live props: the game is never loaded.
    files.clear();
    summaryCalls = {};
    noLiveProps = true;
    const r2 = await run(io, '2026-01-15T01:15:00Z');
    expect(r2.propsLive).toBe(0);
    expect(r2.errors).toEqual([]);
    expect(summaryCalls['401810123'] ?? 0).toBe(0);
  });

  it('skips the 4th quarter', async () => {
    withProps = true;
    liveAt = { period: 4, clock: '8:00' };
    const { io, files } = memoryIO();
    const r = await run(io, '2026-01-15T02:30:00Z');
    expect(r.propsLive).toBe(0);
    expect(files.get(PROPS)).toBeUndefined();
    expect(playedShare('nba', 2, 300)).toBeCloseTo((720 + 420) / 2880);
    expect(playedShare('ncaam', 1, 600)).toBe(0.25);
    expect(playedShare('nba', 5, 100)).toBe(1);
  });

  it('grades props from the final box score with the game, voiding players who sat', async () => {
    const { io, files } = memoryIO();
    const tip = '2026-01-15T00:30:00Z';
    const game: Entry = { id: '401810123', league: 'nba', season: 2026, tip, home: { id: '2', abbr: 'BOS' }, away: { id: '13', abbr: 'LAL' }, neutral: false, status: 'open' };
    const props: PropEntry = {
      id: '401810123',
      league: 'nba',
      season: 2026,
      tip,
      home: game.home,
      away: game.away,
      status: 'open',
      players: { '4432201': 'C. Vance', '4432209': 'G. Holloway' },
      pre: {
        model: MODEL_VERSION,
        takenAt: '2026-01-14T23:00:00Z',
        n: 1000,
        rows: [
          ['4432201', 'pts', 25.5, -110, -110, 0.6, 0, 26.8],
          ['4432201', 'pra', 41.5, -110, -110, 0.45, 0, 40.9],
          ['4432209', 'pts', 4.5, -110, -110, 0.4, 0, 3.9],
        ],
      },
    };
    files.set(logPath('nba', 2026, '20260114'), { [game.id]: game });
    files.set(PROPS, { [props.id]: props });

    const r = await run(io, '2026-01-15T04:00:00Z');
    expect(r.graded).toBe(1);
    expect(r.propsGraded).toBe(1);
    // One summary request grades both.
    expect(summaryCalls['401810123']).toBe(1);
    const e = (files.get(PROPS) as PropLogFile)['401810123'];
    expect(e.status).toBe('final');
    expect(e.box).toEqual({ '4432201': [27, 8, 7, 2], '4432209': null });
    const g = gradeProps(e, 'pre')!;
    expect(g.lines.map((l) => [l.stat, l.side, l.final, l.result])).toEqual([
      ['pts', 'over', 27, 'win'],
      ['pra', 'under', 42, 'loss'],
    ]);
  });
});

