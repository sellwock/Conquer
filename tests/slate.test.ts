import { describe, expect, it } from 'vitest';
import { boardRow, packMarket, unpackMarket } from '../src/model/slate';
import { legsForGame, suggestParlays, SIM_ONLY, type GameMarket } from '../src/model/parlays';
import { leagueAverageGame } from './helpers';
import { buildSpec } from '../src/model/build';
import { runOutcomes } from '../src/sim/quick';
import type { LeagueId } from '../src/model/types';

function market(league: LeagueId = 'ncaam'): GameMarket {
  const g = leagueAverageGame();
  const built = buildSpec(g, { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
  const o = runOutcomes(built.spec, 2000, 'slate');
  return {
    gameId: 'g1',
    league,
    label: 'AWY @ HOM',
    home: 'HOM',
    away: 'AWY',
    // A line well off the model's, so something qualifies.
    odds: { provider: 'Book', spread: 4.5, total: 236.5, homeML: 160, awayML: -190, homeSpreadOdds: -110, awaySpreadOdds: -110, overOdds: -110, underOdds: -110 },
    margin: o.margin,
    total: o.total,
  };
}

describe('slate board', () => {
  const m = market();

  it('puts the model next to the market', () => {
    const r = boardRow(m);
    expect(r.marketMargin).toBe(-4.5);
    expect(r.marketTotal).toBe(236.5);
    expect(r.fairHome!).toBeGreaterThan(0.3);
    expect(r.fairHome!).toBeLessThan(0.4);
    expect(r.pHome).toBeGreaterThan(0.5); // a league-average home team
    expect(r.modelMargin).toBeGreaterThan(0);
  });

  it("shows the simulation's own pick where the blend finds nothing", () => {
    const nba = market('nba');
    const r = boardRow(nba);
    const single = suggestParlays([nba], 1, SIM_ONLY).bySize[1][0];
    expect(r.best).toBeDefined();
    expect(r.best!.legs.map((l) => l.key)).toEqual(single.legs.map((l) => l.key));
    expect(r.best!.pHit).toBe(r.best!.pModel);
  });

  it('shows the same best single as the parlays tab', () => {
    const r = boardRow(m);
    const single = suggestParlays([m]).bySize[1][0];
    expect(r.best).toBeDefined();
    expect(r.best!.legs.map((l) => l.key)).toEqual(single.legs.map((l) => l.key));
    expect(r.best!.ev).toBeCloseTo(single.ev, 10);
    // And it is the best-value leg that clears the singles bar.
    const top = legsForGame(m).sort((a, b) => b.ev - a.ev)[0];
    expect(r.best!.ev).toBeLessThanOrEqual(top.ev + 1e-9);
  });

  it('picks the best line and the best prop separately', () => {
    const nba = market('nba');
    const n = nba.margin.length;
    // The simulation has this player clearing the line in 90% of games; the book says a coin flip.
    const hits = Uint8Array.from({ length: n }, (_, i) => (i % 10 === 0 ? 0 : 1));
    const withProps: GameMarket = { ...nba, props: [{ athleteId: 'p1', player: 'A. Player', stat: 'pts', line: 20.5, over: -110, under: -110, hits, mean: 24 }] };
    const r = boardRow(withProps);
    expect(r.hasProps).toBe(true);
    expect(r.best!.legs[0].prop).toBeUndefined();
    expect(r.best!.legs.map((l) => l.key)).toEqual(boardRow(nba).best!.legs.map((l) => l.key));
    expect(r.bestProp!.legs[0].label).toBe('A. Player over 20.5 points');
    expect(r.bestProp!.pHit).toBeCloseTo(0.9, 2);
    expect(boardRow(nba)).toMatchObject({ hasProps: false, bestProp: undefined });
  });

  it('round-trips outcomes through the cache format', () => {
    const p = JSON.parse(JSON.stringify(packMarket(m, 123)));
    const back = unpackMarket(p);
    expect(Array.from(back.margin)).toEqual(Array.from(m.margin));
    expect(Array.from(back.total)).toEqual(Array.from(m.total));
    expect(back.odds).toEqual(m.odds);
    expect('at' in back).toBe(false);
    expect(JSON.stringify(p).length).toBeLessThan(12_000);
  });
});
