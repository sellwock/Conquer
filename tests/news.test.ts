// Injury news: reading ESPN's league-wide report, spotting newly ruled-out players, and repricing
// their game's props with and without them.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { setFetch, setStore } from '../src/data/espn/client';
import { parseInjuryFeed } from '../src/data/espn/parse';
import { findNews, injuryState, priceNews, withReport, type NewsEvent } from '../src/model/news';
import { runOutcomes } from '../src/sim/quick';
import type { GameData, ScoreboardGame } from '../src/model/types';
import { leagueAverageGame } from './helpers';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));
const feed = parseInjuryFeed(fx('synthetic-nba-injuries.json'));
const board = (phase: ScoreboardGame['phase'] = 'pre') =>
  [{ id: '401810131', date: '2026-01-17T00:30Z', phase, statusText: '', neutral: false, home: { id: '18', abbr: 'NY', name: '', color: '' }, away: { id: '17', abbr: 'BKN', name: '', color: '' } }] as ScoreboardGame[];
const NOW = Date.parse('2026-01-16T23:00:00Z');

describe('injury report', () => {
  it("reads ESPN's league-wide feed, taking athlete ids from the player-card link", () => {
    expect(feed).toHaveLength(3);
    expect(feed[0]).toMatchObject({ teamId: '18', athleteId: '4432101', name: 'Marcus Hale', note: "Hale (ankle) won't play Friday." });
    expect(feed[0].injury).toMatchObject({ status: 'Out', out: true, since: '2026-01-16T22:10Z', detail: 'Ankle Sprain Left' });
    expect(feed[2].injury).toMatchObject({ status: 'Day-To-Day', out: false });
  });

  it('counts a player as news when he is out now and was not on the last report', () => {
    const prev = injuryState(feed.filter((r) => r.athleteId !== '4432101'));
    const news = findNews(feed, prev, board(), NOW);
    expect(news.map((e) => [e.name, e.gameId, e.was])).toEqual([['Marcus Hale', '401810131', undefined]]);
    expect(news[0].key).toBe('4432101|2026-01-16T22:10Z');
    // Questionable before, out now: still news.
    const upgrade = { ...prev, '4432101': { status: 'Day-To-Day', out: false, team: '18' } };
    expect(findNews(feed, upgrade, board(), NOW)[0].was).toBe('Day-To-Day');
    // Already out on the last report: not news, even with a fresh date.
    expect(findNews(feed, injuryState(feed), board(), NOW)).toEqual([]);
    // Nothing once the game has tipped.
    expect(findNews(feed, prev, board('in'), NOW)).toEqual([]);
    expect(findNews(feed, prev, board(), Date.parse('2026-01-17T00:31:00Z'))).toEqual([]);
  });

  it('without an earlier report, or for players missing from it, takes only out entries from the last few hours', () => {
    // Hale's entry is 50 minutes old; Northrup's is weeks old (ESPN refreshes long-term ones too).
    expect(findNews(feed, undefined, board(), NOW).map((e) => e.name)).toEqual(['Marcus Hale']);
    expect(findNews(feed, {}, board(), NOW).map((e) => e.name)).toEqual(['Marcus Hale']);
    expect(findNews(feed, undefined, board(), Date.parse('2026-01-17T00:20:00Z')).map((e) => e.name)).toEqual(['Marcus Hale']);
  });
});

/** League-average teams with numeric ids, since prop feeds identify athletes by number. */
function game(): GameData {
  const g = leagueAverageGame();
  const renumber = (t: GameData['home'], base: number) => ({ ...t, players: t.players.map((p, i) => ({ ...p, id: String(base + i) })) });
  return { ...g, id: '9001', date: '2026-01-17T00:30:00Z', home: renumber(g.home, 1000), away: renumber(g.away, 2000) };
}

const ath = (id: string) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/athletes/${id}?lang=en&region=us` });
const pair = (id: string, typeId: string, line: number) =>
  ['-110', '-110'].map((am) => ({ athlete: ath(id), type: { id: typeId, name: 'x' }, odds: { american: { value: am } }, current: { target: { value: line } } }));

beforeEach(() => {
  const mem = new Map<string, string>();
  setStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), clearPrefix: () => mem.clear() });
  setFetch((async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    let body: unknown;
    if (u.pathname.endsWith('/odds')) body = { items: [{ provider: { id: '100', name: 'DraftKings' }, propBets: { $ref: `http://sports.core.api.espn.com${u.pathname}/100/propBets` } }] };
    else if (u.pathname.endsWith('/propBets'))
      // A teammate's and an opponent's lines, set where they'd be with everyone available.
      body = { pageCount: 1, items: [...pair('1000', '1', 20.5), ...pair('1001', '1', 16.5), ...pair('1001', '90', 25.5), ...pair('2000', '1', 17.5)] };
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
});

const simulate = (spec: Parameters<typeof runOutcomes>[0], n: number, seed: string, opts: { players: boolean }) => runOutcomes(spec, n, seed, opts);
const event = (athleteId: string): NewsEvent => ({ key: `${athleteId}|t`, athleteId, name: 'Star', teamId: 'h', status: 'Out', gameId: '9001', tip: '2026-01-17T00:30:00Z' });

describe('repricing on news', () => {
  it("moves his teammates' lines up and prices the side the news points to", async () => {
    const g = game();
    const report = [{ teamId: 'h', athleteId: '1000', name: 'Star', injury: { status: 'Out', out: true } }];
    expect(withReport(g, report).home.players[0].injury?.out).toBe(true);
    const p = (await priceNews('nba', event('1000'), report, simulate, { game: g, sims: 600 }))!;
    expect(p.minutes).toBeGreaterThan(30);
    const mate = p.rows.find((r) => r.athleteId === '1001' && r.stat === 'pts')!;
    expect(mate.team).toBe('H');
    expect(mate.meanOut).toBeGreaterThan(mate.meanWith + 0.5);
    expect(mate.side).toBe('over');
    expect(mate.shift).toBeCloseTo(mate.meanOut - mate.meanWith, 9);
    // Every priced prop is kept for the log, with his line had the star played; the star's own isn't
    // priced, since he won't play.
    expect(p.out.map((m) => `${m.athleteId}:${m.stat}`).sort()).toEqual(['1001:pra', '1001:pts', '2000:pts']);
    expect(p.withMeans.get('1001|pts')).toBeCloseTo(mate.meanWith, 9);
    // Picks first, then by how far the news moves them.
    const firstNonPick = p.rows.findIndex((r) => !r.pick);
    if (firstNonPick >= 0) expect(p.rows.slice(firstNonPick).every((r) => !r.pick)).toBe(true);
  });

  it("skips a scratch who wasn't going to play real minutes", async () => {
    const g = game();
    const report = [{ teamId: 'h', athleteId: '1009', name: 'Deep bench', injury: { status: 'Out', out: true } }];
    expect(await priceNews('nba', event('1009'), report, simulate, { game: g, sims: 200 })).toBeNull();
  });
});
