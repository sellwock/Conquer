import { describe, expect, it } from 'vitest';
import { averageLines } from '../src/model/recent';
import { emptyBox, type BoxLine, type GameLogLine } from '../src/model/types';

const line = (box: Partial<BoxLine>, date = '2026-10-24T23:30Z'): GameLogLine => ({ eventId: date, date, starter: true, box: { ...emptyBox(), ...box } });

describe('last-five averages', () => {
  it('averages per game, sums rebounds and adds up PRA', () => {
    const a = averageLines([
      line({ min: 30, pts: 20, oreb: 2, dreb: 6, ast: 5, tpm: 2, stl: 1, blk: 0, tov: 3 }),
      line({ min: 34, pts: 30, oreb: 0, dreb: 4, ast: 7, tpm: 4, stl: 3, blk: 2, tov: 1 }),
    ])!;
    expect(a.games).toBe(2);
    expect(a.min).toBe(32);
    expect(a.pts).toBe(25);
    expect(a.reb).toBe(6);
    expect(a.ast).toBe(6);
    expect(a.pra).toBe(37);
    expect(a.tpm).toBe(3);
    expect(a.stl).toBe(2);
    expect(a.blk).toBe(1);
    expect(a.tov).toBe(2);
  });

  it('takes shooting percentages from total makes over total attempts', () => {
    // 1 of 1 and 3 of 9: averaging each game's percentage would say 67%; the totals say 40%.
    const a = averageLines([line({ fgm: 1, fga: 1, tpm: 0, tpa: 0, ftm: 0, fta: 0 }), line({ fgm: 3, fga: 9, tpm: 1, tpa: 4, ftm: 0, fta: 0 })])!;
    expect(a.fgPct).toBeCloseTo(4 / 10);
    expect(a.tpPct).toBeCloseTo(1 / 4);
    expect(a.ftPct).toBeUndefined();
  });

  it('returns nothing without games', () => {
    expect(averageLines([])).toBeUndefined();
  });
});
