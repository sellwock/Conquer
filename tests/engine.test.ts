import { describe, expect, it } from 'vitest';
import { buildSpec, planMinutes, type BuildOptions } from '../src/model/build';
import { LEAGUES } from '../src/model/leagues';
import { simulateGame } from '../src/sim/engine';
import { runSims } from '../src/sim/run';
import { runQuick } from '../src/sim/quick';
import { makeRng } from '../src/lib/rng';
import { Hist } from '../src/lib/stats';
import { BF, NBF } from '../src/sim/types';
import { demoGame } from '../src/data/demo';
import { leagueAverageGame } from './helpers';

const base: BuildOptions = { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' };

function teamTotals(spec: ReturnType<typeof buildSpec>['spec'], n: number, seed = 't') {
  const tot = new Float64Array(NBF);
  let poss = 0, pts = 0;
  for (let s = 0; s < n; s++) {
    const r = simulateGame(spec, makeRng(seed, s));
    poss += r.possessions[0] + r.possessions[1];
    pts += r.score[0] + r.score[1];
    for (let t = 0; t < 2; t++) for (let i = 0; i < r.box[t].length; i++) tot[i % NBF] += r.box[t][i];
  }
  const per = (f: number) => tot[f] / (2 * n);
  return { pace: poss / (2 * n), ppp: pts / poss, per };
}

describe('engine calibration', () => {
  it('reproduces a league-average NBA game', () => {
    const { spec } = buildSpec(leagueAverageGame(), { ...base, homeCourt: false });
    const r = teamTotals(spec, 1500);
    expect(r.pace).toBeGreaterThan(LEAGUES.nba.pace * 0.96);
    expect(r.pace).toBeLessThan(LEAGUES.nba.pace * 1.04);
    expect(r.ppp).toBeGreaterThan(1.09);
    expect(r.ppp).toBeLessThan(1.2);
    expect(r.per(BF.fga)).toBeGreaterThan(80);
    expect(r.per(BF.fga)).toBeLessThan(96);
    expect(r.per(BF.fta)).toBeGreaterThan(17);
    expect(r.per(BF.fta)).toBeLessThan(28);
    expect(r.per(BF.tov)).toBeGreaterThan(11);
    expect(r.per(BF.tov)).toBeLessThan(17);
    expect(r.per(BF.pf)).toBeGreaterThan(15);
    expect(r.per(BF.pf)).toBeLessThan(24);
    expect(r.per(BF.sec) / 60).toBeGreaterThan(239);
  });

  it('gives a neutral-court coin flip between identical teams, and home court a ~2 point edge', () => {
    const g = leagueAverageGame();
    const neutral = runQuick(buildSpec(g, { ...base, homeCourt: false }).spec, 3000, 'n');
    expect(Math.abs(neutral.homeWin - 0.5)).toBeLessThan(0.04);
    const home = runQuick(buildSpec(g, base).spec, 3000, 'h');
    expect(home.margin).toBeGreaterThan(0.8);
    expect(home.margin).toBeLessThan(3.8);
  });

  it('produces a realistic spread of outcomes', () => {
    const s = runSims(buildSpec(leagueAverageGame(), base).spec, 1500, 'sd');
    const sd = Hist.from(s.margin).sd();
    expect(sd).toBeGreaterThan(11);
    expect(sd).toBeLessThan(16);
    expect(s.otPct).toBeGreaterThan(0.015); // real NBA is ~6%; see README "Known gaps"
    expect(s.otPct).toBeLessThan(0.12);
  });
});

describe('determinism', () => {
  it('replays the same game from the same seed and index', () => {
    const { spec } = buildSpec(demoGame(), base);
    const a = simulateGame(spec, makeRng('seed', 42));
    const b = simulateGame(spec, makeRng('seed', 42));
    expect(a.score).toEqual(b.score);
    expect(Array.from(a.box[0])).toEqual(Array.from(b.box[0]));
  });

  it('the typical game is a real member of the sample', () => {
    const { spec } = buildSpec(demoGame(), base);
    const s = runSims(spec, 600, 'typ');
    const replay = simulateGame(spec, makeRng('typ', s.typical.index));
    expect(replay.score).toEqual(s.typical.result.score);
    expect(s.typical.result.log!.length).toBeGreaterThan(200);
  });
});

describe('minutes and availability', () => {
  it('fills exactly the roster minutes and zeroes ruled-out players', () => {
    const g = demoGame();
    const lg = LEAGUES.nba;
    const star = g.home.players[0];
    const plan = planMinutes(g.home, lg, { ...base, outs: new Set([star.id]) });
    const sum = Object.values(plan.minutes).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(240, 0);
    expect(plan.minutes[star.id]).toBe(0);
    expect(plan.unavailable.has(star.id)).toBe(true);
    expect(plan.starters.has(star.id)).toBe(false);
    expect(plan.starters.size).toBe(5);
    // Same-position teammates absorb more of the guard's minutes than the center does.
    const healthy = planMinutes(g.home, lg, { ...base, healthy: true });
    const gain = (id: string) => plan.minutes[id] - healthy.minutes[id];
    const guard = g.home.players.find((p) => p.group === 'G' && p.id !== star.id && !p.injury?.out)!;
    const center = g.home.players.find((p) => p.group === 'C')!;
    expect(gain(guard.id)).toBeGreaterThan(gain(center.id));
  });

  it('respects injury reports unless the player is cleared', () => {
    const g = demoGame();
    const hurt = g.home.players.find((p) => p.injury?.out)!;
    expect(planMinutes(g.home, LEAGUES.nba, base).minutes[hurt.id]).toBe(0);
    expect(planMinutes(g.home, LEAGUES.nba, { ...base, ins: new Set([hurt.id]) }).minutes[hurt.id]).toBeGreaterThan(20);
  });

  it('simulated minutes track the plan and out players never appear', () => {
    const g = demoGame();
    const star = g.home.players[0];
    const { spec, plans } = buildSpec(g, { ...base, outs: new Set([star.id]) });
    const s = runSims(spec, 800, 'm');
    const ps = s.players.filter((p) => p.team === 0);
    expect(ps.find((p) => p.id === star.id)!.min).toBe(0);
    for (const p of ps) if (plans.home.minutes[p.id] > 12) expect(Math.abs(p.min - plans.home.minutes[p.id])).toBeLessThan(4.5);
  });

  it('losing the best player costs win probability', () => {
    const g = demoGame();
    const healthy = runQuick(buildSpec(g, base).spec, 2500, 'w');
    const without = runQuick(buildSpec(g, { ...base, outs: new Set([g.home.players[0].id]) }).spec, 2500, 'w');
    expect(without.homeWin).toBeLessThan(healthy.homeWin - 0.03);
  });
});

describe('whistle and game state', () => {
  it('a tighter whistle means more free throws', () => {
    const g = demoGame();
    const loose = teamTotals(buildSpec(g, { ...base, whistle: 0.8 }).spec, 600, 'f');
    const tight = teamTotals(buildSpec(g, { ...base, whistle: 1.25 }).spec, 600, 'f');
    expect(tight.per(BF.fta)).toBeGreaterThan(loose.per(BF.fta) + 3);
    expect(tight.per(BF.pf)).toBeGreaterThan(loose.per(BF.pf) + 2);
  });

  it('simulates only the remainder from a live state', () => {
    const g = demoGame();
    const { spec } = buildSpec(g, { ...base, start: { period: 4, clockSec: 60, homeScore: 100, awayScore: 90 } });
    const q = runQuick(spec, 1000, 'late');
    expect(q.homeWin).toBeGreaterThan(0.97);
    expect(q.home).toBeGreaterThan(100);
    expect(q.home).toBeLessThan(110);
  });
});

describe('mid-game starts', () => {
  it('keeps fouled-out players on the bench and seeds lead history and line score', () => {
    const g = demoGame();
    const star = g.home.players[0];
    const { spec } = buildSpec(g, {
      ...base,
      start: { period: 4, clockSec: 420, homeScore: 90, awayScore: 70, fouls: { [star.id]: 6 }, prior: [[25, 20], [22, 18], [24, 17]], periodStart: [71, 55] },
    });
    const s = runSims(spec, 400, 'mid');
    expect(s.players.find((p) => p.id === star.id)!.min).toBe(0);
    expect(Hist.from(s.largestLead[0]).probAtLeast(20)).toBe(1);
    const r = s.typical.result;
    const sums = [0, 1].map((t) => r.periodScores.reduce((a, ps) => a + ps[t], 0));
    expect(sums).toEqual([r.score[0], r.score[1]]);
  });
});
