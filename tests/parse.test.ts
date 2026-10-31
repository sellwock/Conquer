import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyZone,
  extractGame,
  parseBoxPlayers,
  parseInjuries,
  parseOdds,
  parseRoster,
  parseScheduleEvents,
  oddsFromItem,
  parseScoreboard,
  parseShotText,
  parseStatLine,
  clockToSec,
  periodOf,
  seasonYear,
} from '../src/data/espn/parse';
import { parseAthleteStats } from '../src/data/espn/load';
import { evenly, finalsToGrade } from '../src/track/rebuild';
import type { ScoreboardGame } from '../src/model/types';

// Fixtures are synthetic payloads in ESPN's documented shapes (names, ids and scores invented).
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

describe('box score', () => {
  it('maps stats by key, not position', () => {
    const a = parseBoxPlayers(fx('synthetic-nba-summary-final.json'));
    const b = parseBoxPlayers(fx('synthetic-nba-summary-boxscore-alt-order.json'));
    const find = (box: typeof a) => Object.values(box).flat().find((p) => p.name === 'Corey Vance')!;
    const pa = find(a);
    const pb = find(b);
    expect(pa.box).toEqual(pb.box);
    expect(pa.box).toMatchObject({ min: 37, fgm: 10, fga: 21, tpm: 2, tpa: 6, ftm: 5, fta: 6, oreb: 1, dreb: 7, ast: 7, stl: 1, blk: 1, tov: 4, pf: 2, pts: 27 });
    expect(pa.name).toBe('Corey Vance');
  });

  it('team box points add up to the final score', () => {
    const s = fx('synthetic-nba-summary-final.json');
    const box = parseBoxPlayers(s);
    for (const c of s.header.competitions[0].competitors) {
      const pts = box[String(c.team.id)].reduce((t, p) => t + p.box.pts, 0);
      expect(pts).toBe(Number(c.score));
    }
  });

  it('treats an empty stats array as did-not-play', () => {
    expect(parseStatLine(['min', 'pts'], [])).toBeNull();
  });

  it('reads college-style labels without keys', () => {
    const line = parseStatLine(['min', 'fg', '3pt', 'ft', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'to', 'pf', 'pts'], ['30', '5-11', '1-4', '3-4', '2', '4', '6', '3', '1', '0', '2', '3', '14']);
    expect(line).toMatchObject({ fgm: 5, fga: 11, tpm: 1, ftm: 3, oreb: 2, dreb: 4, tov: 2, pts: 14 });
  });
});

describe('play-by-play shots', () => {
  it('parses NBA phrasing with distance and assists', () => {
    expect(parseShotText('Devon Archer makes 26-foot three point jumper (Marcus Hale assists)')).toEqual({ shooter: 'Devon Archer', made: true, zone: 'ab3', assister: 'Marcus Hale' });
    expect(parseShotText('Marcus Hale makes 18-foot pullup jump shot (Jalen Okafor assists)')?.zone).toBe('mid');
    expect(parseShotText('Nikola Brandvold misses driving layup')).toMatchObject({ made: false, zone: 'rim' });
    expect(parseShotText('Al Horford misses 22-foot three point shot')?.zone).toBe('c3');
    expect(parseShotText('Brook Lopez blocks Jayson Tatum \'s 3-foot driving layup')).toMatchObject({ shooter: 'Jayson Tatum', made: false, zone: 'rim' });
    expect(parseShotText('Jaylen Brown makes 9-foot driving floating jump shot')?.zone).toBe('paint');
  });

  it('parses college phrasing', () => {
    expect(parseShotText('Hunter Dickinson made Layup. Assisted by Johnny Furphy.')).toEqual({ shooter: 'Hunter Dickinson', made: true, zone: 'rim', assister: 'Johnny Furphy' });
    expect(parseShotText('Kevin McCullar Jr. missed Three Point Jumper.')).toMatchObject({ made: false, zone: 'ab3' });
    expect(parseShotText('Dajuan Harris Jr. made Jumper.')?.zone).toBe('mid');
  });

  it('ignores free throws and non-shots', () => {
    expect(parseShotText('Corey Vance makes free throw 1 of 2')).toBeNull();
    expect(parseShotText('Theo Lindqvist defensive rebound')).toBeNull();
    expect(parseShotText('Lakers Timeout')).toBeNull();
  });

  it('uses shot coordinates for corner threes when present', () => {
    expect(classifyZone(true, 23, 'three point jumper', { x: 48, y: 4 })).toBe('c3');
    expect(classifyZone(true, 23, 'three point jumper', { x: 25, y: 28 })).toBe('ab3');
  });

  it('extracts a completed game into per-team samples', () => {
    const ex = extractGame(fx('synthetic-nba-summary-final.json'), '401810123')!;
    expect(Object.keys(ex.teams)).toHaveLength(2);
    const [a, b] = Object.values(ex.teams);
    expect(a.poss).toBeGreaterThan(70);
    expect(a.ptsAgainst).toBe(b.ptsFor);
  });
});

describe('summary pieces', () => {
  it('reads odds from the home side', () => {
    const s = fx('synthetic-nba-summary-final.json');
    const home = s.header.competitions[0].competitors.find((c: { homeAway: string }) => c.homeAway === 'home');
    const o = parseOdds(s, String(home.team.id))!;
    expect(o.total).toBe(224.5);
    expect(o.homeML).toBe(-220);
    expect(o.spread).toBe(home.team.abbreviation === 'BOS' ? -5.5 : 5.5);
  });

  it('reads injuries and flags who is out', () => {
    const inj = parseInjuries(fx('synthetic-nba-summary-final.json'));
    expect(inj['4432110']).toMatchObject({ status: 'Out', out: true });
  });

  it('parses scoreboard, roster and schedule', () => {
    const games = parseScoreboard(fx('synthetic-nba-scoreboard.json'));
    expect(games.length).toBe(2);
    expect(games[0].home.abbr).toBeTruthy();
    expect(parseScoreboard(fx('synthetic-mbb-scoreboard.json')).length).toBeGreaterThan(0);
    expect(parseRoster(fx('synthetic-nba-team-roster.json')).length).toBe(4);
    const sched = parseScheduleEvents(fx('synthetic-nba-team-schedule.json'));
    expect(sched.map((e) => e.completed)).toEqual([true, false]);
  });

  it("reads a book's game lines from an odds-feed item, spread from the home side", () => {
    // Shape from sports.core.api.espn.com, ATL (away) favored at New Orleans.
    const item = {
      provider: { name: 'DraftKings' },
      details: 'ATL -4.5',
      spread: 4.5,
      overUnder: 240.5,
      overOdds: -108.0,
      underOdds: -112.0,
      homeTeamOdds: { moneyLine: 150, spreadOdds: -115.0, team: { $ref: 'x/teams/3' } },
      awayTeamOdds: { moneyLine: -180, spreadOdds: -105.0 },
    };
    expect(oddsFromItem(item, 'NO', 'ATL')).toEqual({
      provider: 'DraftKings',
      details: 'ATL -4.5',
      spread: 4.5,
      total: 240.5,
      homeML: 150,
      awayML: -180,
      homeSpreadOdds: -115,
      awaySpreadOdds: -105,
      overOdds: -108,
      underOdds: -112,
    });
  });

  it('season stats prefer the latest season and the traded-season totals row', () => {
    const s = parseAthleteStats(fx('synthetic-nba-athlete-stats-v3.json'))!;
    expect(s.games).toBeGreaterThanOrEqual(40);
    expect(s.box.min / s.games).toBeGreaterThan(30);
  });

  it('handles clocks and season years', () => {
    expect(clockToSec('11:32')).toBe(692);
    expect(clockToSec('45.2')).toBeCloseTo(45.2);
    expect(seasonYear('2026-10-20T23:00Z', 'nba')).toBe(2027);
    expect(seasonYear('2027-03-01T23:00Z', 'ncaam')).toBe(2027);
  });
});

describe('periods played', () => {
  const line = (n: number) => Array.from({ length: n }, () => ({ displayValue: '20' }));
  it('reads status.period, then line scores, then the status text', () => {
    expect(periodOf({ status: { period: 3 } }, 4)).toBe(3);
    // Finished-game summaries leave status.period out.
    expect(periodOf({ status: { type: { detail: 'Final' } }, competitors: [{ linescores: line(5) }, { linescores: line(5) }] }, 4)).toBe(5);
    expect(periodOf({ status: { type: { detail: 'Final' } }, competitors: [{ linescores: line(4) }, { linescores: line(4) }] }, 4)).toBe(4);
    expect(periodOf({ status: { type: { detail: 'Final/OT' } } }, 4)).toBe(5);
    expect(periodOf({ status: { type: { detail: 'Final/2OT' } } }, 2)).toBe(4);
    expect(periodOf({ status: { type: { detail: 'Final' } } }, 4)).toBe(0);
  });

  it('knows a final summary went to overtime', async () => {
    const s = fx('synthetic-nba-summary-final.json');
    const comp = s.header.competitions[0];
    expect(comp.status.period).toBeUndefined();
    expect(periodOf(comp, 4)).toBe(4);
    comp.competitors.forEach((c: { linescores: unknown[] }) => c.linescores.push({ displayValue: '9' }));
    expect(periodOf(comp, 4)).toBe(5);
  });
});

describe('finals to grade', () => {
  const g = (id: string, odds?: string) => ({ id, date: '', phase: 'post', statusText: 'Final', neutral: false, odds, home: { id: 'h', abbr: 'H', name: '', color: '', score: 70 }, away: { id: 'a', abbr: 'A', name: '', color: '', score: 60 } }) as ScoreboardGame;
  it('prefers lined college games but keeps all finals when the board has no lines', () => {
    expect(finalsToGrade([g('1', 'X -3'), g('2')], 'ncaam').map((x) => x.id)).toEqual(['1']);
    expect(finalsToGrade([g('1'), g('2')], 'ncaam').map((x) => x.id)).toEqual(['1', '2']);
    expect(finalsToGrade([g('1'), g('2')], 'nba').map((x) => x.id)).toEqual(['1', '2']);
    expect(evenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 3, 6, 8]);
  });
});
