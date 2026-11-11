// Anchoring a simulation to the book's spread and total.
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../src/model/build';
import { anchorSpec } from '../src/sim/anchor';
import { runQuick } from '../src/sim/quick';
import { leagueAverageGame } from './helpers';

describe('anchoring to the book', () => {
  const { spec } = buildSpec(leagueAverageGame(), { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
  const base = runQuick(spec, 600, 'check');

  it('moves the average score to the book\'s spread and total, by shot-making or partly by pace', () => {
    const target = { margin: base.margin + 7, total: base.home + base.away - 12 };
    for (const paceShare of [0, 0.5]) {
      const a = anchorSpec(spec, target, 'g', { paceShare });
      const got = runQuick(a.spec, 600, 'check');
      expect(got.margin).toBeGreaterThan(target.margin - 2);
      expect(got.margin).toBeLessThan(target.margin + 2);
      expect(got.home + got.away).toBeGreaterThan(target.total - 3);
      expect(got.home + got.away).toBeLessThan(target.total + 3);
      expect(a.target.home - a.target.away).toBeCloseTo(target.margin, 9);
      if (paceShare) expect(a.spec.pace).toBeLessThan(spec.pace);
      else expect(a.spec.pace).toBe(spec.pace);
    }
  });

  it('keeps the simulation\'s own total when the book posts only a spread, and caps how far it moves a team', () => {
    const a = anchorSpec(spec, { margin: base.margin + 4 }, 'g');
    expect(a.target.home + a.target.away).toBeCloseTo(a.before.home + a.before.away, 9);
    const far = anchorSpec(spec, { margin: 60, total: 330 }, 'g');
    expect(far.spec.home.makeMult / spec.home.makeMult).toBeLessThanOrEqual(1.15 + 1e-9);
    expect(far.spec.away.makeMult / spec.away.makeMult).toBeGreaterThanOrEqual(0.85 - 1e-9);
  });
});
