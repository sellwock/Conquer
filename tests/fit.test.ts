// The pick model fitted to logged props: the fit itself, the walk-forward test that scores each
// day with earlier days only, and the picks it would have made.
import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/lib/rng';
import { TRUST_BOOK, fitFeatures, fitVerdict, fittedFrom, fittedOver, type FitCoef } from '../src/model/propFit';
import { MIN_TRAIN_GAMES, buildFit, fitLogistic, fitRows, picksOf, testOf, walkForward, type FitRow, type Scored } from '../src/track/fit';
import type { PropEntry, PropRow } from '../src/track/types';

const row = (o: Partial<FitRow> & { pMarket: number; pSim: number }): FitRow => {
  const stat = o.stat ?? 'pts', line = o.line ?? 12.5;
  return { gameId: 'g1', day: '20261101', athleteId: 'a', stat, line, over: -110, under: -110, won: 1, model: '1.2.0', x: fitFeatures(o.pMarket, o.pSim, stat, line), ...o };
};

/** Lines whose over wins by `truth`, spread over `games` games a day. */
function synthetic(truth: FitCoef, n: number, days = 1, games = 30): FitRow[] {
  const rng = makeRng('fit-test');
  return Array.from({ length: n }, (_, i) => {
    const pMarket = 0.35 + 0.3 * rng(), pSim = Math.min(0.95, Math.max(0.05, pMarket + 0.4 * (rng() - 0.5)));
    const line = 4.5 + Math.floor(rng() * 26);
    const day = `202611${String(1 + (i % days)).padStart(2, '0')}`;
    const r = row({ pMarket, pSim, line, day, gameId: `${day}-${Math.floor(i / days) % games}`, athleteId: `p${i}` });
    return { ...r, won: rng() < fittedFrom(truth, r.x) ? 1 : 0 };
  });
}

describe('the pick model', () => {
  it('reads "the book is right" as the book\'s own chance', () => {
    expect(fittedOver(TRUST_BOOK, 0.57, 0.2, 'reb', 9.5)).toBeCloseTo(0.57, 9);
    // The simulation's disagreement is capped, so one wild chance can't swamp the fit.
    expect(fitFeatures(0.5, 0.999, 'pts', 12.5)[2]).toBe(2.5);
    // Size is measured against a typical line for the stat.
    expect(fitFeatures(0.5, 0.5, 'pts', 12.5)[3]).toBeCloseTo(0, 9);
    expect(fitFeatures(0.5, 0.5, 'pts', 6.5)[3]).toBeLessThan(0);
  });

  it('recovers known coefficients from enough lines', () => {
    const truth: FitCoef = [-0.12, 1, 0.2, 0.3];
    const coef = fitLogistic(synthetic(truth, 40000), 1);
    for (const [i, v] of truth.entries()) expect(Math.abs(coef[i] - v)).toBeLessThan(0.08);
  });

  it('stays with the book on little data', () => {
    expect(fitLogistic([])).toEqual(TRUST_BOOK);
    // Twenty lines that all went over: the constant can move, the rest barely.
    const coef = fitLogistic(Array.from({ length: 20 }, (_, i) => row({ pMarket: 0.5, pSim: 0.8, line: 6.5 + i, won: 1 })));
    expect(Math.abs(coef[1] - 1)).toBeLessThan(0.05);
    expect(Math.abs(coef[2])).toBeLessThan(0.3);
    expect(Math.abs(coef[3])).toBeLessThan(0.3);
  });

  it('calls a record tested only with enough picks and a range clear of zero', () => {
    expect(fitVerdict(undefined)).toBe('none');
    expect(fitVerdict({ win: 200, loss: 190, roi: -0.01, lo: -0.1 })).toBe('none');
    expect(fitVerdict({ win: 60, loss: 40, roi: 0.12, lo: 0.01 })).toBe('promising');
    expect(fitVerdict({ win: 200, loss: 160, roi: 0.05, lo: -0.02 })).toBe('promising');
    expect(fitVerdict({ win: 200, loss: 150, roi: 0.08, lo: 0.01 })).toBe('tested');
  });
});

describe('the walk-forward test', () => {
  it('scores a day only with a fit of earlier days, once those hold enough games', () => {
    const rows = synthetic([-0.1, 1, 0.1, 0.2], 3000, 3, MIN_TRAIN_GAMES);
    const scored = walkForward(rows);
    // Day 1 has nothing before it; days 2 and 3 are scored.
    expect(new Set(scored.map((s) => s.row.day))).toEqual(new Set(['20261102', '20261103']));
    const day2 = scored.filter((s) => s.row.day === '20261102');
    const coef = fitLogistic(rows.filter((r) => r.day < '20261102'));
    expect(day2[0].pOver).toBeCloseTo(fittedFrom(coef, day2[0].row.x), 12);
    // Flipping every result on day 2 changes nothing about how day 2 is scored.
    const flipped = rows.map((r) => (r.day === '20261102' ? { ...r, won: (1 - r.won) as 0 | 1 } : r));
    expect(walkForward(flipped).filter((s) => s.row.day === '20261102').map((s) => s.pOver)).toEqual(day2.map((s) => s.pOver));
  });

  it('waits for enough games', () => {
    expect(walkForward(synthetic([0, 1, 0, 0], 600, 2, MIN_TRAIN_GAMES - 1))).toEqual([]);
  });

  it('can score other lines (the first snapshot) with the pre-game rows\' fit', () => {
    const rows = synthetic([-0.1, 1, 0.1, 0.2], 2000, 2, MIN_TRAIN_GAMES);
    const open = rows.filter((r) => r.day === '20261102').slice(0, 5).map((r) => ({ ...r, line: r.line + 1, x: fitFeatures(r.pMarket, r.pSim, r.stat, r.line + 1) }));
    const scored = walkForward(rows, open);
    expect(scored).toHaveLength(5);
    expect(scored[0].pOver).toBeCloseTo(fittedFrom(fitLogistic(rows.filter((r) => r.day < '20261102')), open[0].x), 12);
  });
});

describe('picks', () => {
  const s = (o: Partial<FitRow>, pOver: number): Scored => ({ row: row({ pMarket: 0.5, pSim: 0.5, ...o }), pOver });

  it('makes at most one bet per player per game: the best side and stat that clears the edge', () => {
    const picks = picksOf([
      s({ athleteId: 'a', stat: 'pts', won: 0 }, 0.4), // under at -110: 0.6 × 1.909 − 1 = +14.5%
      s({ athleteId: 'a', stat: 'pra', won: 0 }, 0.43), // under: +8.8%, same player
      s({ athleteId: 'b', stat: 'reb', won: 1 }, 0.52), // neither side clears 3%
      s({ athleteId: 'c', stat: 'ast', won: 1, over: 130, under: -160 }, 0.47), // over at +130: +8.1%
      s({ athleteId: 'a', stat: 'pts', gameId: 'g2', won: 1 }, 0.4), // another game: its own pick
    ]);
    expect(picks.map((p) => [p.row.gameId, p.row.athleteId, p.row.stat, p.side, p.won])).toEqual([
      ['g1', 'a', 'pts', 'under', true],
      ['g1', 'c', 'ast', 'over', true],
      ['g2', 'a', 'pts', 'under', false],
    ]);
    expect(picks[0].ev).toBeCloseTo(0.6 * (1 + 100 / 110) - 1, 9);
  });

  it('leaves out prices longer than the single-bet cap', () => {
    expect(picksOf([s({ over: 260, under: -340 }, 0.4)])).toEqual([]);
  });

  it('reports the record, the return with a range by game, and what the fit said', () => {
    const scored = Array.from({ length: 40 }, (_, i) => s({ gameId: `g${i % 8}`, athleteId: `p${i}`, won: i % 5 === 0 ? 1 : 0 }, 0.4));
    const t = testOf(scored);
    expect(t).toMatchObject({ lines: 40, games: 8, days: 1 });
    // Unders every time: 32 of 40 won at -110.
    expect(t.picks).toMatchObject({ win: 32, loss: 8, unders: 40, said: 0.6 });
    expect(t.picks.roi).toBeCloseTo((32 * (100 / 110) - 8) / 40, 3);
    expect(t.picks.lo).toBeLessThanOrEqual(t.picks.roi);
    expect(t.picks.hi).toBeGreaterThanOrEqual(t.picks.roi);
    // The fit (40% over) beat the book (50%) on lines where one over in five won.
    expect(t.brier.diff).toBeLessThan(0);
    expect(t.moved).toBeUndefined();
  });
});

describe('fitting the log', () => {
  const rows: PropRow[] = [
    ['p1', 'pts', 20.5, -110, -110, 0.6, 0, 21.2],
    ['p1', 'pra', 33.5, -120, 100, 0.45, 0.1, 33.1],
    ['p2', 'reb', 6, -110, -110, 0.4, 0.2, 5.8], // lands on the line: a push
    ['p3', 'ast', 4.5, -110, -110, 0.5, 0, 4.4], // sat: void
  ];
  const entry = (id: string, tip: string, extra: Partial<PropEntry> = {}): PropEntry => ({
    id,
    league: 'nba',
    season: 2027,
    tip,
    home: { id: '1', abbr: 'H' },
    away: { id: '2', abbr: 'A' },
    status: 'final',
    players: { p1: 'One', p2: 'Two', p3: 'Three' },
    pre: { model: '1.2.0', takenAt: tip, n: 1000, rows },
    box: { p1: [24, 5, 6, 2], p2: [10, 6, 1, 0], p3: null },
    ...extra,
  });

  it('keeps decided lines of players who played, with the over\'s chance among decided outcomes', () => {
    // An 8:30 pm Eastern tip on Nov 1 is Nov 2 in UTC; the day is the Eastern one.
    const got = fitRows([entry('g1', '2026-11-02T01:30:00Z'), { ...entry('g2', '2026-11-02T01:30:00Z'), status: 'open' }], 'pre');
    expect(got.map((r) => [r.athleteId, r.stat, r.won, r.day])).toEqual([
      ['p1', 'pts', 1, '20261101'],
      ['p1', 'pra', 1, '20261101'],
    ]);
    expect(got[1].pSim).toBeCloseTo(0.45 / 0.9, 9);
    expect(got[1].pMarket).toBeCloseTo(120 / 220 / (120 / 220 + 0.5), 9);
    expect(fitRows([entry('g1', '2026-11-02T01:30:00Z')], 'live')).toEqual([]);
  });

  it('writes no fit until enough games are graded, then coefficients and the test', () => {
    const few = buildFit([entry('g1', '2026-11-02T01:30:00Z')], 'nba', new Date('2026-11-03T00:00:00Z'));
    expect(few).toEqual({ updatedAt: '2026-11-03T00:00:00.000Z', league: 'nba', minEdge: 0.03, minTrainGames: MIN_TRAIN_GAMES });

    const days = ['2026-11-02T01:30:00Z', '2026-11-03T01:30:00Z'];
    const many = days.flatMap((tip, d) =>
      Array.from({ length: MIN_TRAIN_GAMES }, (_, i) =>
        entry(`d${d}g${i}`, tip, {
          open: { model: '1.2.0', takenAt: tip, n: 1000, rows: rows.map((r) => [r[0], r[1], r[2] - 1, r[3], r[4], r[5], r[6], r[7]] as PropRow) },
          live: { model: '1.2.0', takenAt: tip, n: 1000, rows, at: { period: 2, clockSec: 300, home: 50, away: 48 } },
          close: { takenAt: tip, lines: [['p1', 'pts', 21.5, -110, -110]] },
        }),
      ),
    );
    const fit = buildFit(many, 'nba', new Date('2026-11-04T00:00:00Z'));
    expect(fit.pre).toMatchObject({ lines: 4 * MIN_TRAIN_GAMES, games: 2 * MIN_TRAIN_GAMES, models: { '1.2.0': 4 * MIN_TRAIN_GAMES } });
    expect(fit.pre!.coef).toHaveLength(4);
    // Every over won, so the constant is well above zero.
    expect(fit.pre!.coef[0]).toBeGreaterThan(0.5);
    // The second day is scored by the first day's fit; its over picks saw the line rise by the close.
    expect(fit.pre!.test).toMatchObject({ games: MIN_TRAIN_GAMES, days: 1 });
    expect(fit.pre!.test!.picks.win).toBe(MIN_TRAIN_GAMES);
    expect(fit.pre!.test!.moved!.toward).toBeGreaterThan(0);
    expect(fit.pre!.open).toMatchObject({ games: MIN_TRAIN_GAMES });
    // Live picks aren't judged against the pre-game close.
    expect(fit.live!.test!.moved).toBeUndefined();
    expect(fit.live!.open).toBeUndefined();
  });
});
