import { describe, expect, it } from 'vitest';
import { compareRuns, comparisonMarkdown, fitBlend, verdict } from '../src/track/compare';
import type { Entry } from '../src/track/types';

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** A season of games where the true home win chance is known; `noise` blurs the model's view. */
function run(noise: number, model: string, games = 400): Entry[] {
  seed = 11;
  return Array.from({ length: games }, (_, i) => {
    const truth = 0.15 + 0.7 * rnd();
    const homeWon = rnd() < truth;
    const p = Math.min(0.97, Math.max(0.03, truth + noise * (rnd() - 0.5)));
    const margin = homeWon ? 6 : -6;
    return {
      id: String(i),
      league: 'nba',
      season: 2026,
      tip: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
      home: { id: 'h', abbr: 'H' },
      away: { id: 'a', abbr: 'A' },
      neutral: false,
      status: 'final',
      pred: { model, takenAt: '', minsToTip: 0, n: 1, homeWin: p, meanMargin: (p - 0.5) * 20, meanTotal: 224, otPct: 0.06, marginPmf: [0, [1]], totalPmf: [224, [1]], outs: [] },
      result: { home: 110 + (margin > 0 ? margin : 0), away: 110 + (margin < 0 ? -margin : 0), ot: i % 20 === 0, gradedAt: '' },
    } as Entry;
  });
}

describe('backtest comparison', () => {
  it('finds a sharper model better, paired on the same games', () => {
    const c = compareRuns(run(0.05, '2.0.0'), run(0.6, '1.0.0'));
    expect(c.paired!.n).toBe(400);
    expect(verdict(c.paired!.brier)).toBe('better');
    expect(verdict(c.paired!.logLoss)).toBe('better');
    expect(c.head.otActual).toBeCloseTo(0.05, 5);
    expect(c.head.otPredicted).toBeCloseTo(0.06, 5);
  });

  it('calls identical runs unchanged', () => {
    const c = compareRuns(run(0.3, '1.0.0'), run(0.3, '1.0.0'));
    expect(c.paired!.brier.mean).toBe(0);
    expect(verdict(c.paired!.brier)).toBe('no clear change');
  });

  it('writes a table for one run or two', () => {
    const one = comparisonMarkdown('NBA', compareRuns(run(0.3, '1.0.0')));
    expect(one).toContain('| Brier (win prob) |');
    expect(one).not.toContain('Paired on');
    const two = comparisonMarkdown('NBA', compareRuns(run(0.05, '2.0.0'), run(0.6, '1.0.0')));
    expect(two).toMatch(/\| Brier \| −?-?0\.\d{4} \| .* \| better \|/);
  });

  it('fits how much weight the model earns next to the market', () => {
    seed = 3;
    const games = Array.from({ length: 4000 }, () => {
      const truth = 0.15 + 0.7 * rnd();
      return { truth, won: (rnd() < truth ? 1 : 0) as 0 | 1, noise: rnd() - 0.5, noise2: rnd() - 0.5 };
    });
    const clip = (p: number) => Math.min(0.99, Math.max(0.01, p));
    // A model that is pure noise against a sharp market earns nothing.
    const noise = fitBlend(games.map((g) => ({ model: clip(0.5 + g.noise), market: g.truth, won: g.won })))!;
    expect(noise.best).toBeLessThanOrEqual(0.05);
    expect(noise.brier.market).toBeLessThan(noise.brier.half);
    // A sharp model against a noisy market earns most of the weight.
    const sharp = fitBlend(games.map((g) => ({ model: g.truth, market: clip(g.truth + 0.6 * g.noise2), won: g.won })))!;
    expect(sharp.best).toBeGreaterThanOrEqual(0.7);
    expect(fitBlend([])).toBeUndefined();
    const md = comparisonMarkdown('NBA', compareRuns(run(0.3, '1.0.0')));
    expect(md).toContain('| Best model weight: spread |');
  });
});
