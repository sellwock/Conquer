// Grading logged props: the sim's side on every line, its top picks ranked as the app ranks single
// bets, and its over chances against the market's, per game.
import { describe, expect, it } from 'vitest';
import { gradeNews, gradeProps, sidesOf, summarizeProps, TOP_PER_GAME } from '../src/track/propGrade';
import { propRows } from '../src/track/job';
import { legsForGame, weightsFor, type GameMarket } from '../src/model/parlays';
import { liveSingles } from '../src/ui/parlays';
import type { PropEntry, PropRow } from '../src/track/types';

const entry = (rows: PropRow[], box: PropEntry['box'], id = 'g1'): PropEntry => ({
  id,
  league: 'nba',
  season: 2027,
  tip: '2026-11-01T23:00:00Z',
  home: { id: '1', abbr: 'HOM' },
  away: { id: '2', abbr: 'AWY' },
  status: 'final',
  players: { a: 'A. One', b: 'B. Two', c: 'C. Three' },
  live: { model: 'm1', takenAt: '2026-11-02T00:00:00Z', n: 1000, rows, at: { period: 2, clockSec: 300, home: 50, away: 48 } },
  box,
});

describe('prop grading', () => {
  it("settles each line on the sim's side, with pushes and players who sat", () => {
    const e = entry(
      [
        ['a', 'pts', 20.5, -110, -110, 0.7, 0, 23.1, 12],
        ['a', 'pra', 30, -110, -110, 0.3, 0.1, 28.9, 15],
        ['b', 'reb', 6.5, -110, -110, 0.5, 0, 6.6, 2],
        ['c', 'pts', 10.5, -110, -110, 0.5, 0, 10.4, 0],
      ],
      { a: [24, 4, 2, 3], b: [8, 5, 1, 0], c: null },
    );
    const g = gradeProps(e, 'live')!;
    expect(g.lines.map((l) => [l.player, l.stat, l.side, l.final, l.result])).toEqual([
      ['A. One', 'pts', 'over', 24, 'win'],
      ['A. One', 'pra', 'under', 30, 'push'],
      ['B. Two', 'reb', 'over', 5, 'loss'],
    ]);
    expect(g.lines[0]).toMatchObject({ now: 12, at: { period: 2 }, label: 'AWY @ HOM', model: 'm1' });
    // The push is left out of the over/under comparison.
    expect(g.brier).toEqual([
      [0.7, 0.5, 1],
      [0.5, 0.5, 0],
    ]);
    expect(gradeProps(e, 'pre')).toBeNull();
    expect(gradeProps({ ...e, status: 'open' }, 'live')).toBeNull();
  });

  it('ranks top picks exactly as the Live bets panel does', () => {
    // A market whose props the sim prices, turned into log rows.
    const n = 1000;
    const hits = (pOver: number) => Uint8Array.from({ length: n }, (_, k) => (k < pOver * n ? 1 : 0));
    const props = [
      { athleteId: 'a', player: 'A. One', stat: 'pts' as const, line: 20.5, over: -110, under: -110, hits: hits(0.62), mean: 22 },
      { athleteId: 'a', player: 'A. One', stat: 'reb' as const, line: 5.5, over: 150, under: -180, hits: hits(0.45), mean: 5.4 },
      { athleteId: 'b', player: 'B. Two', stat: 'ast' as const, line: 4.5, over: -150, under: 125, hits: hits(0.35), mean: 4 },
      { athleteId: 'b', player: 'B. Two', stat: 'tpm' as const, line: 1.5, over: 300, under: -400, hits: hits(0.3), mean: 1.1 },
      { athleteId: 'c', player: 'C. Three', stat: 'pts' as const, line: 12.5, over: -110, under: -110, hits: hits(0.5), mean: 12.5 },
      ...['ast', 'reb', 'tpm', 'pr', 'pa'].map((stat, i) => ({ athleteId: 'c', player: 'C. Three', stat: stat as 'ast', line: 3.5 + i, over: -110, under: -110, hits: hits(0.56 + i * 0.02), mean: 4 })),
    ];
    const market: GameMarket = { gameId: 'g1', league: 'nba', label: 'AWY @ HOM', home: 'HOM', away: 'AWY', odds: { provider: 'Book' }, margin: new Int16Array(n), total: new Int16Array(n), props };
    const picks = liveSingles([market], weightsFor('nba', 'sim'), 'props', TOP_PER_GAME);
    const app = picks.map((p) => p.legs[0]);
    const e = entry(propRows(props), { a: [1, 1, 1, 1], b: [1, 1, 1, 1], c: [1, 1, 1, 1] });
    const g = gradeProps(e, 'live')!;
    expect(g.top.map((t) => `${t.athleteId}:${t.stat}:${t.side}`)).toEqual(app.map((l) => `${l.prop!.athleteId}:${l.prop!.stat}:${l.side}`));
    expect(g.top).toHaveLength(TOP_PER_GAME);
    for (const [i, t] of g.top.entries()) {
      expect(t.ev).toBeCloseTo(picks[i].ev, 6);
      // Ranked by the mix of the simulation and the book, as the app shows it.
      expect(t.pPick).toBeCloseTo(app[i].pBlend, 6);
      expect(t.pPick).toBeCloseTo(0.25 * t.pSim + 0.75 * t.pMarket, 6);
    }
    // And each row's sides match the legs the app builds from the same market.
    const legs = legsForGame(market, weightsFor('nba', 'sim')).filter((l) => l.prop);
    for (const [k, r] of propRows(props).entries()) {
      const [over, under] = sidesOf(r);
      expect(over.ev).toBeCloseTo(legs[2 * k].ev, 6);
      expect(under.ev).toBeCloseTo(legs[2 * k + 1].ev, 6);
    }
  });

  it('compares the sim with the market per game, and counts units at the listed price', () => {
    // The sim is right and sure in game 1, wrong in game 2; the market sits at 50% throughout.
    const g1 = gradeProps(entry([['a', 'pts', 20.5, -110, -110, 0.8, 0, 24], ['b', 'pts', 10.5, 120, -140, 0.8, 0, 13]], { a: [25, 0, 0, 0], b: [12, 0, 0, 0], c: null }, 'g1'), 'live')!;
    const g2 = gradeProps(entry([['a', 'pts', 20.5, -110, -110, 0.6, 0, 22]], { a: [18, 0, 0, 0], b: null, c: null }, 'g2'), 'live')!;
    const s = summarizeProps([g1, g2]);
    expect(s).toMatchObject({ games: 2, lines: 3, every: { win: 2, loss: 1, push: 0 } });
    expect(s.every.units).toBeCloseTo(100 / 110 + 1.2 - 1, 6);
    const sq = (p: number, y: number) => (p - y) ** 2;
    // +120 / −140 without the vig: the over at 0.4545 / (0.4545 + 0.5833).
    const q = 100 / 220 / (100 / 220 + 140 / 240);
    expect(s.vsMarket!.n).toBe(2);
    expect(s.vsMarket!.model).toBeCloseTo(((sq(0.8, 1) + sq(0.8, 1)) / 2 + sq(0.6, 0)) / 2, 6);
    expect(s.vsMarket!.market).toBeCloseTo(((sq(0.5, 1) + sq(q, 1)) / 2 + sq(0.5, 0)) / 2, 6);
    expect(s.vsMarket!.diff).toBeCloseTo(s.vsMarket!.model - s.vsMarket!.market, 6);
  });
});

describe('props after injury news', () => {
  // A teammate the scratch lifts (over) and one it lowers (under); the book moved both lines their way by tip.
  const e: PropEntry = {
    id: 'g9',
    league: 'nba',
    season: 2027,
    tip: '2026-11-03T00:00:00Z',
    home: { id: '1', abbr: 'HOM' },
    away: { id: '2', abbr: 'AWY' },
    status: 'final',
    players: { a: 'A. One', b: 'B. Two' },
    news: [
      {
        model: 'm1',
        takenAt: '2026-11-02T22:00:00Z',
        n: 1000,
        rows: [
          ['a', 'pts', 20.5, -110, -110, 0.7, 0, 23],
          ['b', 'pts', 10.5, -110, -110, 0.3, 0, 9],
        ],
        out: { athleteId: 's', name: 'S. Tar', status: 'Out', minutes: 34 },
        meanWith: [20, 10],
      },
    ],
    close: {
      takenAt: '2026-11-02T23:45:00Z',
      lines: [
        ['a', 'pts', 22.5, -110, -110],
        ['b', 'pts', 10.5, 110, -130],
      ],
    },
    box: { a: [25, 0, 0, 0], b: [8, 0, 0, 0] },
  };

  it('picks the side the news points to and checks whether the line moved its way', () => {
    const [g] = gradeNews(e);
    expect(g.top.map((t) => [t.player, t.side, t.result, t.news?.moved])).toEqual([
      ['A. One', 'over', 'win', 'toward'],
      ['B. Two', 'under', 'win', 'toward'],
    ]);
    expect(g.top[0].news).toMatchObject({ name: 'S. Tar', shift: 3 });
    expect(summarizeProps([g]).moved).toEqual({ toward: 2, away: 0, same: 0 });
    // Pre-game and live grading are untouched by news.
    expect(gradeProps(e, 'pre')).toBeNull();
    expect(gradeNews({ ...e, status: 'open' })).toEqual([]);
  });

  it('never picks against the news, and reads a line that moved the other way as away', () => {
    const against: PropEntry = { ...e, close: { takenAt: 'x', lines: [['a', 'pts', 19.5, -110, -110]] } };
    const [g] = gradeNews(against);
    expect(g.top.every((t) => (t.athleteId === 'a' ? t.side === 'over' : t.side === 'under'))).toBe(true);
    expect(g.top.find((t) => t.athleteId === 'a')!.news!.moved).toBe('away');
    // No closing line for B.
    expect(g.top.find((t) => t.athleteId === 'b')!.news!.moved).toBeUndefined();
  });
});

