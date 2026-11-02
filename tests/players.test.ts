// Player lines: game-to-game variation in the engine, the tunable priors, and the grading the
// calibration script and the backtest use.
import { afterEach, describe, expect, it } from 'vitest';
import { buildSpec, playerRates, PLAYER_TUNING } from '../src/model/build';
import { LEAGUES } from '../src/model/leagues';
import { runOutcomes } from '../src/sim/quick';
import { crps, evaluatePlayers, summarizePlayers } from '../src/track/players';
import { emptyBox, type GameData } from '../src/model/types';
import { leagueAverageGame } from './helpers';

const defaults = { nba: { ...PLAYER_TUNING.nba }, ncaam: { ...PLAYER_TUNING.ncaam } };
afterEach(() => {
  Object.assign(PLAYER_TUNING.nba, defaults.nba);
  Object.assign(PLAYER_TUNING.ncaam, defaults.ncaam);
});

const OPTS = { outs: new Set<string>(), ins: new Set<string>(), whistle: 1, homeCourt: true, minutesMode: 'projected' as const };

/** Mean and sd of each home player's simulated minutes and points. */
function spread(g: GameData, n = 1500) {
  const { spec } = buildSpec(g, OPTS);
  const po = runOutcomes(spec, n, 'spread', { players: true }).players!;
  const P = po.ids.length;
  return spec.home.players.map((p, j) => {
    let m = 0, m2 = 0;
    for (let s = 0; s < n; s++) {
      const v = po.pts[s * P + j];
      m += v;
      m2 += v * v;
    }
    const mean = m / n;
    return { id: p.id, target: p.targetMin, min: po.min[j], pts: mean, sd: Math.sqrt(m2 / n - mean * mean) };
  });
}

describe('game-to-game variation', () => {
  it('varies NBA minutes by default, and not college minutes, as fitted against box scores', () => {
    expect(buildSpec(leagueAverageGame('nba'), OPTS).spec.noise).toEqual({ minutes: 1.5, usage: 0 });
    expect(buildSpec(leagueAverageGame('ncaam'), OPTS).spec.noise).toBeUndefined();
    expect(PLAYER_TUNING.nba).toMatchObject({ usagePriorMin: 15, ratePriorMin: 20 });
    expect(PLAYER_TUNING.ncaam).toMatchObject({ usagePriorMin: 15, ratePriorMin: 20 });
  });

  it('widens each player\'s lines while keeping his average minutes', () => {
    const g = leagueAverageGame();
    Object.assign(PLAYER_TUNING.nba, { minutesNoise: 0, usageNoise: 0 });
    const before = spread(g);
    Object.assign(PLAYER_TUNING.nba, { minutesNoise: 2, usageNoise: 0.3 });
    expect(buildSpec(g, OPTS).spec.noise).toEqual({ minutes: 2, usage: 0.3 });
    const after = spread(g);
    for (const [i, b] of before.entries()) {
      const a = after[i];
      if (b.target < 15) continue;
      expect(a.sd).toBeGreaterThan(b.sd * 1.15);
      // The team's minutes are fixed, so a player's average moves little.
      expect(Math.abs(a.min - b.min)).toBeLessThan(0.08 * b.min + 1);
      expect(Math.abs(a.pts - b.pts)).toBeLessThan(0.1 * b.pts + 1);
    }
  });

  it('varies only what is left of a game in progress', () => {
    const g = leagueAverageGame();
    const late = { period: 4, clockSec: 60, homeScore: 100, awayScore: 98, prior: [[25, 25], [25, 25], [25, 25]] as [number, number][], periodStart: [75, 75] as [number, number] };
    const mins = () => Array.from(runOutcomes(buildSpec(g, { ...OPTS, start: late }).spec, 600, 'late', { players: true }).players!.min);
    Object.assign(PLAYER_TUNING.nba, { minutesNoise: 0 });
    const still = mins();
    Object.assign(PLAYER_TUNING.nba, { minutesNoise: 2 });
    const varied = mins();
    // With a minute to play, nobody's remaining minutes can swing far.
    for (const [j, m] of still.entries()) expect(Math.abs(varied[j] - m)).toBeLessThan(0.25);
  });
});

describe('tunable priors', () => {
  it('pulls a high-usage player less toward his position when the prior is lighter', () => {
    const g = leagueAverageGame();
    const star = g.home.players[0];
    const box = { ...star.sample!.box, min: 360, fga: 220, fta: 80, tov: 35 };
    const p = { ...star, sample: { ...star.sample!, games: 10, box } };
    const light = playerRates(p, LEAGUES.nba).usage;
    Object.assign(PLAYER_TUNING.nba, { usagePriorMin: 120 });
    const heavy = playerRates(p, LEAGUES.nba).usage;
    expect(light).toBeGreaterThan(heavy);
  });
});

describe('player grading', () => {
  it('scores a sample with CRPS', () => {
    expect(crps(Float64Array.from([5, 5, 5]), 5)).toBe(0);
    // Half at 0, half at 1, outcome 0: E|X − y| = 0.5, E|X − X'| = 0.5.
    expect(crps(Float64Array.from([0, 1, 0, 1]), 0)).toBeCloseTo(0.25, 9);
    expect(crps(Float64Array.from([10, 12, 14]), 30)).toBeGreaterThan(crps(Float64Array.from([10, 12, 14]), 12));
  });

  it('grades who played against their simulated lines, with stars and bench marked', () => {
    const g = leagueAverageGame();
    const { spec } = buildSpec(g, OPTS);
    const o = runOutcomes(spec, 800, 'grade', { players: true });
    const proj = new Map([...spec.home.players, ...spec.away.players].map((p) => [p.id, p.targetMin]));
    // Box scores: everyone plays except one bench player; each scores his simulated average.
    const P = o.players!.ids.length;
    const avg = (j: number, k: 'pts' | 'reb' | 'ast') => {
      let s = 0;
      for (let i = 0; i < 800; i++) s += o.players![k][i * P + j];
      return Math.round(s / 800);
    };
    for (const t of [g.home, g.away])
      for (const p of t.players) {
        const j = o.players!.ids.indexOf(p.id);
        p.actual = { ...emptyBox(), min: proj.get(p.id)!, pts: avg(j, 'pts'), dreb: avg(j, 'reb'), ast: avg(j, 'ast'), played: p.id !== 'h-9', starter: !!p.starter };
      }
    const rows = evaluatePlayers(g, o.players!, proj);
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r.tier === 'star')).toHaveLength(4);
    expect(rows.find((r) => r.id === 'h-8')!.tier).toBe('bench');
    const s = summarizePlayers(rows);
    expect(s.n).toBe(rows.filter((r) => r.proj >= 15).length);
    expect(Math.abs(s.stats.pts.bias)).toBeLessThan(0.6);
    expect(s.stats.pts.inside).toBeGreaterThan(0.9);
    expect(s.minutesMae.proj).toBe(0);
  });
});
