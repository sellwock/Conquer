import { describe, expect, it } from 'vitest';
import { bootstrapMean, gradeEntry, marketHomeWin, pmfFromCounts, pmfFromValues, pmfMean, pmfProb, summarize } from '../src/track/grade';
import type { Entry, Pmf } from '../src/track/types';

function entry(over: Partial<Entry> & { margin: Pmf; total: Pmf; homeWin: number }): Entry {
  return {
    id: over.id ?? '1',
    league: 'nba',
    season: 2027,
    tip: '2026-10-21T23:30:00Z',
    home: { id: 'h', abbr: 'HOM' },
    away: { id: 'a', abbr: 'AWY' },
    neutral: false,
    status: over.status ?? 'final',
    pred: {
      model: '1.0.0',
      takenAt: '2026-10-21T22:30:00Z',
      minsToTip: 60,
      n: 4,
      homeWin: over.homeWin,
      meanMargin: pmfMean(over.margin),
      meanTotal: pmfMean(over.total),
      otPct: 0,
      marginPmf: over.margin,
      totalPmf: over.total,
      outs: [],
    },
    line: over.line,
    closeReported: over.closeReported,
    result: over.result,
  };
}

describe('pmfs', () => {
  it('trims empty tails and normalizes', () => {
    expect(pmfFromCounts(-3, [0, 0, 1, 3, 0])).toEqual([-1, [0.25, 0.75]]);
    expect(pmfFromValues([2, 2, 4])).toEqual([2, [0.66667, 0, 0.33333]]);
    const p: Pmf = [-2, [0.25, 0.25, 0, 0.5]];
    expect(pmfProb(p, (v) => v > 0)).toBe(0.5);
    expect(pmfMean(p)).toBeCloseTo(-2 * 0.25 - 1 * 0.25 + 1 * 0.5);
  });

  it('reads the market no-vig win chance', () => {
    expect(marketHomeWin({ provider: 'x', homeML: -110, awayML: -110 })).toBeCloseTo(0.5);
    expect(marketHomeWin({ provider: 'x', homeML: -200, awayML: 170 })!).toBeGreaterThan(0.6);
    expect(marketHomeWin({ provider: 'x' })).toBeUndefined();
  });
});

describe('gradeEntry', () => {
  // Margins -4, +2, +6, +10 equally likely; totals 210/220/230/240.
  const margin: Pmf = [-4, [0.25, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.25]];
  const total: Pmf = [210, Array.from({ length: 31 }, (_, i) => (i % 10 === 0 ? 0.25 : 0))];

  it('picks the side the distribution favors and settles it', () => {
    const g = gradeEntry(
      entry({
        margin,
        total,
        homeWin: 0.75,
        line: { provider: 'x', spread: -3.5, total: 224.5, homeML: -160, awayML: 140, fetchedAt: '' },
        result: { home: 110, away: 104, ot: false, gradedAt: '' },
      }),
    )!;
    // Home -3.5 covers on +6 and +10: 50%, so the pick is home at exactly even; margin 6 covers.
    expect(g.ats).toMatchObject({ pick: 'home', result: 'win', price: -110 });
    // Over 224.5 hits on 230 and 240: 50% → over; total 214 loses.
    expect(g.ou).toMatchObject({ pick: 'over', result: 'loss' });
    expect(g.homeWon).toBe(1);
    expect(g.pMarket).toBeGreaterThan(0.5);
  });

  it('handles pushes on whole-number lines', () => {
    const g = gradeEntry(
      entry({
        margin,
        total,
        homeWin: 0.75,
        line: { provider: 'x', spread: -6, total: 220, fetchedAt: '' },
        result: { home: 116, away: 110, ot: false, gradedAt: '' },
      }),
    )!;
    expect(g.ats!.result).toBe('push');
    // pCover excludes the push: +10 covers out of (-4, +2, +10) → 1/3, so the pick is away.
    expect(g.ats!.pick).toBe('away');
    expect(g.ats!.pCover).toBeCloseTo(2 / 3);
  });

  it('skips open and void games and measures closing-line value', () => {
    expect(gradeEntry(entry({ margin, total, homeWin: 0.75, status: 'open' }))).toBeNull();
    expect(gradeEntry(entry({ margin, total, homeWin: 0.75, status: 'void' }))).toBeNull();
    const g = gradeEntry(
      entry({
        margin,
        total,
        homeWin: 0.75,
        line: { provider: 'x', spread: -3, fetchedAt: '' },
        closeReported: { provider: 'x', spread: -4.5, fetchedAt: '' },
        result: { home: 100, away: 99, ot: false, gradedAt: '' },
      }),
    )!;
    expect(g.ats!.pick).toBe('home');
    expect(g.clv).toBeCloseTo(1.5); // got home -3, it closed -4.5
  });
});

describe('summarize', () => {
  it('records picks, units and the paired comparison with the market', () => {
    const margin: Pmf = [-1, [0.4, 0, 0.6]];
    const total: Pmf = [200, [1]];
    const games = [true, true, false, true].map((homeWins, i) =>
      gradeEntry(
        entry({
          id: String(i),
          margin,
          total,
          homeWin: 0.6,
          line: { provider: 'x', spread: -0.5, total: 199.5, homeML: -110, awayML: -110, fetchedAt: '' },
          result: homeWins ? { home: 101, away: 100, ot: false, gradedAt: '' } : { home: 99, away: 100, ot: false, gradedAt: '' },
        }),
      )!,
    );
    const s = summarize(games);
    expect(s.straightUp).toEqual({ correct: 3, n: 4 });
    expect(s.ats).toMatchObject({ win: 3, loss: 1, push: 0 });
    expect(s.ats.units).toBeCloseTo(3 * (100 / 110) - 1);
    // Model 0.6 vs market 0.5 on games the home team won 3 of 4.
    expect(s.vsMarket!.model).toBeCloseTo((3 * 0.16 + 0.36) / 4);
    expect(s.vsMarket!.market).toBeCloseTo(0.25);
    expect(s.vsMarket!.diff).toBeLessThan(0);
    expect(s.calibration[6]).toMatchObject({ n: 4, rate: 0.75 });
  });

  it('bootstraps a sensible interval', () => {
    const b = bootstrapMean(Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -1)));
    expect(b.mean).toBe(0);
    expect(b.lo).toBeLessThan(0);
    expect(b.hi).toBeGreaterThan(0);
  });
});
