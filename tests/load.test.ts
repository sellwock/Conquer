// End-to-end loading under Node with ESPN mocked from fixtures: the same path the forward-log job
// takes (fetch + file-style store, no browser, no worker).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { requestCount, setFetch, setStore, type KeyValueStore } from '../src/data/espn/client';
import { applySummary, combineSeasons, loadGame, parseGamelog, pregameView, refreshGame, restOf } from '../src/data/espn/load';
import { buildSpec } from '../src/model/build';
import { runSims } from '../src/sim/run';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    clearPrefix: (p) => {
      for (const k of [...data.keys()]) if (k.startsWith(p)) data.delete(k);
    },
  };
}

const seen: string[] = [];
function mockEspn(overrides: Record<string, unknown> = {}) {
  setFetch((async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    seen.push(u.pathname);
    let body: unknown;
    for (const [k, v] of Object.entries(overrides)) if (u.pathname.endsWith(k) || u.search.includes(k)) body = v;
    if (body === undefined) {
      if (u.pathname.endsWith('/summary')) body = fx('synthetic-nba-summary-final.json');
      else if (u.pathname.includes('/roster')) body = fx('synthetic-nba-team-roster.json');
      else if (u.pathname.includes('/schedule')) {
        const s = fx('synthetic-nba-team-schedule.json');
        s.events = [{ ...s.events[0], id: '401800001', date: '2026-01-10T00:30Z' }, ...s.events];
        body = s;
      } else if (u.pathname.endsWith('/gamelog')) body = fx('synthetic-nba-athlete-gamelog-v3.json');
      else if (u.pathname.endsWith('/stats')) body = fx('synthetic-nba-athlete-stats-v3.json');
    }
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
}

beforeEach(() => {
  seen.length = 0;
  setStore(memoryStore());
  mockEspn();
});

describe('loadGame under Node', () => {
  it('builds a full game from ESPN payloads and simulates it', async () => {
    const g = await loadGame('nba', '401810123', { sampleGames: 5 });
    expect(g.phase).toBe('post');
    expect(g.home.players.length).toBeGreaterThan(5);
    expect(g.home.sample?.games).toBe(1); // the earlier game from the schedule
    expect(g.home.rest).toMatchObject({ days: 5, b2b: false });
    const { spec } = buildSpec(g, { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
    const s = runSims(spec, 200, 'node');
    expect(s.homeScore + s.awayScore).toBeGreaterThan(150);
    expect(requestCount()).toBeGreaterThan(5);
  });

  it('as of tip-off: no roster or injury report, starters from the sample, no future season stats', async () => {
    const g = await loadGame('nba', '401810123', { sampleGames: 5, asOf: '2026-01-15T00:30Z' });
    expect(seen.some((p) => p.includes('/roster'))).toBe(false);
    expect(seen.some((p) => p.endsWith('/gamelog'))).toBe(true);
    const caleb = [...g.home.players, ...g.away.players].find((p) => p.id === '4432110');
    expect(caleb?.injury?.status).not.toBe('Out'); // summary injury report ignored
    const seasonPlayer = [...g.home.players, ...g.away.players].find((p) => p.source.startsWith('Season'));
    // 2025-26 (40 games) is the as-of season, so it's replaced by last season plus the game log.
    expect(seasonPlayer?.sample?.games).toBeCloseTo(20, 0);
  });

  it('strips everything a pre-game model must not see', async () => {
    const g = await loadGame('nba', '401810123', { sampleGames: 5 });
    const pre = pregameView(g);
    expect(pre.phase).toBe('pre');
    expect(pre.homeScore).toBeUndefined();
    expect(pre.plays).toHaveLength(0);
    expect([...pre.home.players, ...pre.away.players].every((p) => !p.actual)).toBe(true);
    expect(pre.odds).toEqual(g.odds);
  });

  it('patches live fields from a fresh summary', async () => {
    const pregame = fx('synthetic-nba-summary-pregame.json');
    mockEspn({ '/summary': pregame });
    const g = await loadGame('nba', '401810131', { sampleGames: 3 });
    expect(g.phase).toBe('pre');
    const live = fx('synthetic-nba-summary-final.json');
    // Pretend the pre-game matchup is now in the fourth quarter.
    live.header.competitions[0].status = { type: { state: 'in', detail: '4th 5:12' }, period: 4, displayClock: '5:12' };
    live.header.competitions[0].competitors.forEach((c: { team: { id: string } }, i: number) => {
      c.team.id = i ? g.away.id : g.home.id;
    });
    const patched = applySummary(g, live);
    expect(patched.phase).toBe('in');
    expect(patched.period).toBe(4);
    expect(patched.clockSec).toBe(312);
    expect(patched.homeScore).toBeGreaterThan(0);
    expect(patched.plays.length).toBeGreaterThan(0);
    expect(g.phase).toBe('pre'); // original untouched
  });

  it('refreshes with one uncached summary request each time', async () => {
    mockEspn({ '/summary': fx('synthetic-nba-summary-pregame.json') });
    const g = await loadGame('nba', '401810131', { sampleGames: 3 });
    const inits: (RequestInit | undefined)[] = [];
    setFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/summary?event=401810131');
      inits.push(init);
      return new Response(JSON.stringify(fx('synthetic-nba-summary-pregame.json')), { status: 200 });
    }) as typeof fetch);
    const a = await refreshGame(g);
    await refreshGame(a);
    expect(inits).toHaveLength(2);
    expect(inits.every((i) => i?.cache === 'no-store')).toBe(true);
    expect(a.home.players).toHaveLength(g.home.players.length);
  });
});

describe('season helpers', () => {
  it('sums a game log before a date', () => {
    const s = parseGamelog(fx('synthetic-nba-athlete-gamelog-v3.json'), '2026-01-15T00:30Z')!;
    expect(s.games).toBe(1);
    expect(s.box.pts).toBe(25);
    expect(s.box.dreb).toBe(7);
    expect(parseGamelog(fx('synthetic-nba-athlete-gamelog-v3.json'), '2026-01-01T00:00Z')).toBeNull();
  });

  it('tops a small sample up with the previous season', () => {
    const cur = { games: 5, starts: 5, box: { min: 150, pts: 100, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 } };
    const prev = { games: 60, starts: 0, box: { ...cur.box, min: 1200, pts: 600 } };
    const c = combineSeasons(cur, prev)!;
    expect(c.games).toBeCloseTo(20);
    expect(c.box.pts).toBeCloseTo(100 + 600 * (15 / 60));
    expect(combineSeasons(null, prev)).toBe(prev);
  });

  it('flags back-to-backs', () => {
    expect(restOf([{ date: '2026-01-14T00:30Z' }], '2026-01-15T00:30Z')).toEqual({ days: 1, b2b: true });
    expect(restOf([{ date: '2026-01-12T00:30Z' }], '2026-01-15T00:30Z')).toEqual({ days: 3, b2b: false });
    expect(restOf([], '2026-01-15T00:30Z')).toEqual({ days: null, b2b: false });
  });
});
