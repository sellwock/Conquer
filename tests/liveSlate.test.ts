// Live parlays across games: each game in progress is priced from its in-game prop lines and a
// simulation from its current state, refreshed with one uncached summary request per pass.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { setFetch, setStore } from '../src/data/espn/client';
import { liveCandidates, priceLiveGame, type Simulate } from '../src/ui/liveSlate';
import { legsForGame, suggestParlays, SIM_ONLY } from '../src/model/parlays';
import { runOutcomes } from '../src/sim/quick';
import type { ScoreboardGame } from '../src/model/types';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));
const LIVE = { period: 3, displayClock: '3:57', clock: 237, type: { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, detail: '3:57 - 3rd Quarter', shortDetail: '3:57 - 3rd' } };
const ath = (id: string) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/athletes/${id}?lang=en&region=us` });
const pair = (id: string, typeId: string, line: number, over: string, under: string) =>
  [over, under].map((am) => ({ athlete: ath(id), type: { id: typeId, name: 'x' }, odds: { american: { value: am } }, current: { target: { value: line } } }));

let state: 'in' | 'post' = 'in';
let summaries = 0;
beforeEach(() => {
  state = 'in';
  summaries = 0;
  const mem = new Map<string, string>();
  setStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), clearPrefix: () => mem.clear() });
  setFetch((async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    let body: unknown;
    if (u.hostname === 'sports.core.api.espn.com') {
      if (u.pathname.endsWith('/odds'))
        body = {
          items: [
            { provider: { id: '100', name: 'DraftKings' }, propBets: { $ref: `http://sports.core.api.espn.com${u.pathname}/100/propBets` } },
            {
              provider: { id: '200', name: 'DraftKings - Live Odds' },
              propBets: { $ref: `http://sports.core.api.espn.com${u.pathname}/200/propBets` },
              details: 'BOS -6.5',
              spread: -6.5,
              overUnder: 230.5,
              overOdds: -110,
              underOdds: -110,
              homeTeamOdds: { moneyLine: -400, spreadOdds: -110 },
              awayTeamOdds: { moneyLine: 300, spreadOdds: -110 },
            },
          ],
        };
      else if (u.pathname.endsWith('/200/propBets'))
        body = { pageCount: 1, items: [...pair('4432201', '1', 34.5, '-110', '-120'), ...pair('4432101', '2', 6.5, '+105', '-135'), ...pair('4432203', '1', 24.5, '+100', '-130')] };
      else if (u.pathname.endsWith('/propBets')) body = { pageCount: 1, items: [] };
    } else if (u.pathname.endsWith('/summary')) {
      if (u.searchParams.get('event') === '401810123') summaries++;
      body = fx('synthetic-nba-summary-final.json');
      (body as any).header.competitions[0].status = state === 'in' ? LIVE : (body as any).header.competitions[0].status;
    } else if (u.pathname.includes('/roster')) body = fx('synthetic-nba-team-roster.json');
    else if (u.pathname.includes('/schedule')) body = fx('synthetic-nba-team-schedule.json');
    else if (u.pathname.endsWith('/gamelog')) body = fx('synthetic-nba-athlete-gamelog-v3.json');
    else if (u.pathname.endsWith('/stats')) body = fx('synthetic-nba-athlete-stats-v3.json');
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
});

const simulate: Simulate = async (spec, n, seed, opts) => runOutcomes(spec, n, seed, opts);

describe('live slate', () => {
  it('prices a game in progress from its in-game lines and what each player has so far', async () => {
    const r = await priceLiveGame('nba', '401810123', undefined, 'live', simulate, undefined, 300);
    expect(r.game.phase).toBe('in');
    const m = r.market!;
    expect(m.propsProvider).toBe('DraftKings - Live Odds');
    expect(m.margin.length).toBe(300);
    const vance = m.props!.find((p) => p.athleteId === '4432201')!;
    expect(vance.now).toBe(27); // the box score so far
    expect(vance.mean).toBeGreaterThanOrEqual(27);

    // The next pass refreshes with one summary request.
    const before = summaries;
    const again = await priceLiveGame('nba', '401810123', r.game, 'live', simulate, undefined, 300);
    expect(summaries - before).toBe(1);
    expect(again.market).toBeDefined();
  });

  it("prices the live book's game lines from full-game finals", async () => {
    const m = (await priceLiveGame('nba', '401810123', undefined, 'live', simulate, undefined, 300)).market!;
    expect(m.odds).toMatchObject({ provider: 'DraftKings - Live Odds', spread: -6.5, total: 230.5, homeML: -400, awayML: 300 });
    // The simulation starts at the current 122-113, so every final total is already past 230.5.
    for (let k = 0; k < 300; k++) expect(m.total[k]).toBeGreaterThanOrEqual(235);
    const legs = legsForGame(m, SIM_ONLY);
    expect(legs.find((l) => l.kind === 'total' && l.side === 'over')!.pModel).toBe(1);
    expect(legs.filter((l) => !l.prop).map((l) => l.kind).sort()).toEqual(['ml', 'ml', 'spread', 'spread', 'total', 'total']);
    // Lines and props from one game can share a parlay, scored together.
    const s = suggestParlays([m], 3, SIM_ONLY);
    expect([...s.bySize[2], ...s.bySize[3]].some((p) => p.legs.some((l) => !l.prop) && p.legs.some((l) => l.prop))).toBe(true);
  });

  it('drops a game once it ends', async () => {
    const r = await priceLiveGame('nba', '401810123', undefined, 'live', simulate, undefined, 300);
    state = 'post';
    const done = await priceLiveGame('nba', '401810123', r.game, 'live', simulate, undefined, 300);
    expect(done.game.phase).toBe('post');
    expect(done.market).toBeUndefined();
  });

  it('builds parlays across live games from props alone', async () => {
    const priced = (await priceLiveGame('nba', '401810123', undefined, 'live', simulate, undefined, 300)).market!;
    // Without the game lines, so every leg is a prop.
    const a = { ...priced, odds: { provider: priced.odds.provider } };
    const b = { ...a, gameId: 'other', label: 'OTH @ ERS' };
    const s = suggestParlays([a, b], 3, SIM_ONLY);
    const mixed = [...s.bySize[2], ...s.bySize[3]].filter((p) => new Set(p.legs.map((l) => l.gameId)).size > 1);
    expect(mixed.length).toBeGreaterThan(0);
    for (const p of [...s.bySize[2], ...s.bySize[3]]) {
      const keys = p.legs.map((l) => `${l.gameId}|${l.prop!.athleteId}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('looks at games in progress, and upcoming ones whose tip has passed, never the open game', () => {
    const g = (id: string, phase: ScoreboardGame['phase'], date: string) => ({ id, phase, date }) as ScoreboardGame;
    const now = Date.parse('2026-10-29T01:00Z');
    const games = [g('a', 'in', '2026-10-29T00:00Z'), g('b', 'pre', '2026-10-29T00:30Z'), g('c', 'pre', '2026-10-29T02:00Z'), g('d', 'post', '2026-10-28T23:00Z'), g('e', 'in', '2026-10-29T00:00Z')];
    expect(liveCandidates(games, 'e', now)).toEqual(['a', 'b']);
  });
});
