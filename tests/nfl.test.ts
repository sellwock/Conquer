// The NFL: ESPN's prop lines (no prices), box scores, game logs and rosters, and the prop model
// that prices lines from a player's recent games. Fixtures are trimmed live responses (Nov 20, 2026).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSUMED_PRICE, parsePropBets } from '../src/data/espn/props';
import { emptyNflLine, parseNflBox, parseNflGamelog, parseNflRoster, type NflGameLog, type NflLine } from '../src/data/espn/nfl';
import { LEAGUE_INFO, hoopsConfig, isHoops } from '../src/model/leagues';
import { corePath, sitePath, webPath } from '../src/data/espn/client';
import { draw, impliedPoints, nflPrice, nflPropMarkets, valueOf, LINE_WEIGHT, NFL_DECAY } from '../src/model/nfl/props';
import { makeRng } from '../src/lib/rng';
import { finalOf, NFL_BOX } from '../src/track/propGrade';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

describe('the NFL as a league', () => {
  it('reads from ESPN\'s football paths, and has no basketball simulation', () => {
    expect(sitePath('nfl', '/scoreboard')).toBe('/apis/site/v2/sports/football/nfl/scoreboard');
    expect(webPath('nfl', '/athletes/1/gamelog')).toBe('/apis/common/v3/sports/football/nfl/athletes/1/gamelog');
    expect(corePath('nfl', '/events/1')).toBe('/v2/sports/football/leagues/nfl/events/1');
    expect(sitePath('nba', '/scoreboard')).toBe('/apis/site/v2/sports/basketball/nba/scoreboard');
    expect(LEAGUE_INFO.nfl).toMatchObject({ label: 'NFL', periods: 4, periodSec: 900 });
    expect(isHoops('nfl')).toBe(false);
    expect(() => hoopsConfig('nfl')).toThrow(/no basketball simulation/);
    expect(hoopsConfig('nba').periods).toBe(4);
  });
});

describe('NFL prop lines', () => {
  it('pairs each player\'s two items per stat, at an assumed price since ESPN posts none', () => {
    const lines = parsePropBets(fx('nfl-propbets-pre.json').items, 'football');
    const qb = lines.filter((l) => l.athleteId === '3918298');
    expect(qb.map((l) => [l.stat, l.line])).toEqual([
      ['passYds', 226.5],
      ['passComp', 18.5],
      ['rushAtt', expect.any(Number)],
      ['rushYds', expect.any(Number)],
    ]);
    for (const l of lines) {
      expect(l).toMatchObject({ over: ASSUMED_PRICE, under: ASSUMED_PRICE, assumed: true });
      expect(l.open?.over).toBe(ASSUMED_PRICE);
    }
    expect(qb[0].open?.line).toBe(231.5);
    // Passing touchdowns (type 10) aren't priced; nor is anything read as basketball.
    expect(lines.some((l) => (l.stat as string) === 'passTd')).toBe(false);
    expect(parsePropBets(fx('nfl-propbets-pre.json').items)).toEqual([]);
  });
});

describe('NFL box scores, game logs and rosters', () => {
  it('reads passing, rushing and receiving per player from a box score', () => {
    const box = parseNflBox(fx('nfl-summary-final.json'));
    expect(box.get('4431452')).toEqual({ athleteId: '4431452', teamId: '17', name: 'Drake Maye', line: { ...emptyNflLine(), passComp: 23, passAtt: 33, passYds: 178, rushAtt: 7, rushYds: 47 } });
    expect(box.get('4430878')!.line).toMatchObject({ rec: 8, recYds: 122 });
    expect(box.get('4569173')!.line).toMatchObject({ rushAtt: 18, rushYds: 51, rec: 5, recYds: 44 });
  });

  it('reads a player\'s games from his game log, newest first, matching the box score', () => {
    const qb = parseNflGamelog(fx('nfl-gamelog-qb.json'));
    expect(qb).toHaveLength(10);
    expect(qb.map((g) => g.date)).toEqual([...qb.map((g) => g.date)].sort().reverse());
    const week1 = qb.find((g) => g.eventId === '401872656')!;
    expect(week1).toMatchObject({ date: '2026-09-10T00:20:00.000Z', teamId: '17', teamPts: 10, oppPts: 13 });
    expect(week1.line).toEqual(parseNflBox(fx('nfl-summary-final.json')).get('4431452')!.line);
    const wr = parseNflGamelog(fx('nfl-gamelog-wr.json'));
    expect(wr.find((g) => g.eventId === '401872656')!.line).toMatchObject({ rec: 4, recYds: 51 });
  });

  it('reads names, positions and who is out from a roster', () => {
    const roster = parseNflRoster(fx('nfl-roster.json'));
    expect(roster.length).toBeGreaterThan(50);
    const maye = roster.find((p) => p.name === 'Drake Maye')!;
    expect(maye).toMatchObject({ position: 'QB', injury: 'Doubtful', out: false });
    expect(roster.find((p) => p.injury === 'Out')!.out).toBe(true);
  });

  it('grades a logged NFL box line, combos included', () => {
    const b = NFL_BOX.map((k) => ({ passYds: 250, passComp: 22, passAtt: 34, rushYds: 31, rushAtt: 5, recYds: 0, rec: 0 })[k]);
    expect(finalOf('nfl', 'passYds', b)).toBe(250);
    expect(finalOf('nfl', 'passRushYds', b)).toBe(281);
    expect(finalOf('nba', 'pra', [20, 5, 4, 2])).toBe(29);
  });
});

/** A player who put up `v` of every stat in each of `n` games, a week apart, his team scoring `pts`. */
const history = (n: number, v: Partial<NflLine>, pts = 24): NflGameLog[] =>
  Array.from({ length: n }, (_, i) => ({ eventId: `e${i}`, date: new Date(Date.UTC(2026, 10, 15 - 7 * i)).toISOString(), teamId: 'T', teamPts: pts, oppPts: 20, line: { ...emptyNflLine(), ...v } }));

describe('the NFL prop model', () => {
  const kickoff = '2026-11-22T18:00:00.000Z';

  it('weights recent games, pulls toward the book\'s line, and scales by the team\'s implied points', () => {
    const h = history(10, { recYds: 80 });
    const p = nflPrice('recYds', 60.5, h, kickoff)!;
    let sw = 0, sw2 = 0;
    for (let i = 0; i < 10; i++) {
      sw += NFL_DECAY ** i;
      sw2 += NFL_DECAY ** (2 * i);
    }
    const nEff = (sw * sw) / sw2;
    expect(p.mean).toBeCloseTo((nEff * 80 + LINE_WEIGHT * 60.5) / (nEff + LINE_WEIGHT), 9);
    expect(p.games).toBe(10);
    // His team expected to score a third more than its recent 24: more yards, by the square root.
    const up = nflPrice('recYds', 60.5, h, kickoff, 32)!;
    expect(up.mean).toBeCloseTo((nEff * 80 * Math.sqrt(32 / 24) + LINE_WEIGHT * 60.5) / (nEff + LINE_WEIGHT), 9);
    // Only games before kickoff count; none, no price.
    expect(nflPrice('recYds', 60.5, h, '2026-01-01T00:00:00Z')).toBeUndefined();
    expect(nflPrice('recYds', 60.5, history(3, {}), kickoff)).toBeUndefined();
  });

  it('turns the book\'s spread and total into each team\'s implied points', () => {
    expect(impliedPoints({ provider: 'x', spread: -3, total: 44.5 }, 'H', 'A')).toEqual({ H: 23.75, A: 20.75 });
    expect(impliedPoints({ provider: 'x', total: 44.5 }, 'H', 'A')).toBeUndefined();
  });

  it('draws counts as whole numbers and yards from a skewed spread, with the asked mean', () => {
    const rng = makeRng('draws');
    const counts = Array.from({ length: 4000 }, () => draw(rng, 'rec', 5, 2.5));
    expect(counts.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    expect(counts.reduce((a, b) => a + b, 0) / counts.length).toBeCloseTo(5, 0);
    const yds = Array.from({ length: 4000 }, () => draw(rng, 'recYds', 60, 35));
    const mean = yds.reduce((a, b) => a + b, 0) / yds.length;
    expect(mean).toBeGreaterThan(57);
    expect(mean).toBeLessThan(63);
    // Right-skewed: the median sits under the mean.
    expect([...yds].sort((a, b) => a - b)[2000]).toBeLessThan(mean);
  });

  it('prices each line from those draws: overs likely where his games run above it', () => {
    const lines = [
      { athleteId: 'a', stat: 'recYds' as const, line: 40.5, over: -110, under: -110, assumed: true as const },
      { athleteId: 'b', stat: 'recYds' as const, line: 90.5, over: -110, under: -110 },
      { athleteId: 'c', stat: 'rec' as const, line: 4.5, over: -110, under: -110 },
      { athleteId: 'd', stat: 'rec' as const, line: 4.5, over: -110, under: -110 },
      { athleteId: 'a', stat: 'pts' as const, line: 20.5, over: -110, under: -110 },
    ];
    const hist = new Map([
      ['a', history(8, { recYds: 70, rec: 5 })],
      ['b', history(8, { recYds: 70, rec: 5 })],
      ['c', history(8, { rec: 5 })],
    ]);
    const names = new Map([['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]);
    const ms = nflPropMarkets(lines, hist, names, { gameId: 'g', kickoff, teamOf: new Map() });
    const pOver = (id: string) => {
      const h = ms.find((m) => m.athleteId === id)!.hits;
      return h.filter((x) => x === 1).length / h.length;
    };
    // D has no history and the basketball line isn't the NFL model's.
    expect(ms.map((m) => m.athleteId)).toEqual(['a', 'b', 'c']);
    expect(pOver('a')).toBeGreaterThan(0.75);
    expect(pOver('b')).toBeLessThan(0.3);
    expect(pOver('c')).toBeGreaterThan(0.4);
    expect(ms[0]).toMatchObject({ assumed: true, over: -110 });
    expect(ms[0].hits).toHaveLength(2000);
    // Seeded per game, player and stat: the same every time.
    expect(nflPropMarkets(lines, hist, names, { gameId: 'g', kickoff, teamOf: new Map() })[0].hits).toEqual(ms[0].hits);
  });

  it('prices a live line as what he has plus the rest of the game, around the pre-game line', () => {
    const h = new Map([['a', history(8, { recYds: 60 })]]);
    const names = new Map([['a', 'A']]);
    const live = (remaining: number, has: number, line: number) =>
      nflPropMarkets([{ athleteId: 'a', stat: 'recYds', line, over: -110, under: -110, open: { line: 60.5, over: -110, under: -110 } }], h, names, {
        gameId: 'g',
        kickoff,
        teamOf: new Map(),
        live: { remaining, soFar: new Map([['a', { ...emptyNflLine(), recYds: has }]]) },
      })[0];
    // Game over: no draws left, so it's what he has against the line.
    const done = live(0, 45, 40.5);
    expect(done.now).toBe(45);
    expect(done.hits.every((x) => x === 1)).toBe(true);
    // Halftime with 40 already: about 30 more expected, so 70.5 is close to a coin flip, 50.5 a likely over.
    const half = live(0.5, 40, 70.5);
    const p = half.hits.filter((x) => x === 1).length / 2000;
    expect(half.mean).toBeGreaterThan(65);
    expect(half.mean).toBeLessThan(75);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.6);
    expect(live(0.5, 40, 50.5).hits.filter((x) => x === 1).length / 2000).toBeGreaterThan(0.75);
    expect(valueOf('rushRecYds', { ...emptyNflLine(), rushYds: 30, recYds: 12 })).toBe(42);
  });
});
