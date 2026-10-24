import { describe, expect, it } from 'vitest';
import { evaluate, legsForGame, modelHasSay, suggestParlays, toAmerican, toDecimal, HIT_FLOOR, MAX_PRICE, type GameMarket } from '../src/model/parlays';
import { makeRng } from '../src/lib/rng';
import type { LeagueId } from '../src/model/types';

function market(id: string, margins: number[], totals: number[], odds: GameMarket['odds'], league: LeagueId = 'ncaam'): GameMarket {
  return { gameId: id, league, label: `A${id} @ H${id}`, home: `H${id}`, away: `A${id}`, odds, margin: Int16Array.from(margins), total: Int16Array.from(totals) };
}

/** Pins the blend so the parlay-building tests don't depend on the fitted weights. */
const HALF = { ml: 0.5, spread: 0.5, total: 0.5 };

const evenOdds = { provider: 'test', spread: -0.5, total: 220.5, homeML: -110, awayML: -110, homeSpreadOdds: -110, awaySpreadOdds: -110, overOdds: -110, underOdds: -110 };

describe('parlay math', () => {
  it('converts prices both ways', () => {
    expect(toDecimal(-110)).toBeCloseTo(1.909, 3);
    expect(toDecimal(150)).toBe(2.5);
    expect(toAmerican(2.5)).toBe(150);
    expect(toAmerican(1.5)).toBe(-200);
  });

  it('scores same-game legs jointly, capturing correlation', () => {
    // Home wins exactly when the game goes over: perfectly correlated.
    const margins = [5, 5, -5, -5], totals = [230, 230, 210, 210];
    const g = market('1', margins, totals, evenOdds);
    const legs = legsForGame(g);
    const homeMl = legs.find((l) => l.key.endsWith('ml:home'))!;
    const over = legs.find((l) => l.key.endsWith('total:over'))!;
    const p = evaluate([homeMl, over]);
    expect(p.pModel).toBeCloseTo(0.5); // not 0.25
    expect(p.correlation).toBeCloseTo(1); // twice as often as independent
    expect(p.sameGame).toBe(true);
  });

  it('multiplies independent games and handles pushes', () => {
    const g1 = market('1', [3, -3, 3, -3], [200, 200, 200, 200], { ...evenOdds, spread: -3 });
    const legs = legsForGame(g1);
    const homeSpread = legs.find((l) => l.key.endsWith('spread:home'))!;
    expect(homeSpread.pPush).toBeCloseTo(0.5);
    expect(homeSpread.pModel).toBe(0); // the non-push results all lose
    const g2 = market('2', [1, 1, -1, -1], [200, 200, 200, 200], evenOdds);
    const a = legsForGame(g2).find((l) => l.key.endsWith('ml:home'))!;
    const b = legsForGame(market('3', [1, -1, 1, -1], [200, 200, 200, 200], evenOdds)).find((l) => l.key.endsWith('ml:home'))!;
    const p = evaluate([a, b]);
    expect(p.pModel).toBeCloseTo(0.25);
    expect(p.sameGame).toBe(false);
  });

  it('suggests only compatible, positive-value parlays of at most three legs above the hit floors', () => {
    const rng = makeRng('parlays', 0);
    const games: GameMarket[] = [];
    for (let gi = 0; gi < 6; gi++) {
      const m: number[] = [], t: number[] = [];
      for (let s = 0; s < 4000; s++) {
        const margin = Math.round(4 + 13 * (rng() + rng() + rng() - 1.5) * 1.4);
        m.push(margin);
        t.push(Math.round(225 + margin * 0.3 + 18 * (rng() + rng() + rng() - 1.5) * 1.4));
      }
      // Market sees a pick'em; the sims see a home favorite, so home legs carry value.
      games.push(market(String(gi), m, t, { ...evenOdds, spread: -1.5, total: 226.5 }));
    }
    const s = suggestParlays(games, 3, HALF);
    for (const size of [1, 2, 3] as const) {
      expect(s.bySize[size].length).toBeGreaterThan(0);
      for (const p of s.bySize[size]) {
        expect(p.legs).toHaveLength(size);
        expect(p.ev).toBeGreaterThan(0);
        expect(p.pHit).toBeGreaterThanOrEqual(HIT_FLOOR[size]);
        expect(p.price).toBeLessThanOrEqual(MAX_PRICE[size]);
        const perGame = new Map<string, string[]>();
        for (const l of p.legs) perGame.set(l.gameId, [...(perGame.get(l.gameId) ?? []), l.kind]);
        for (const kinds of perGame.values()) {
          expect(kinds.filter((k) => k !== 'total').length).toBeLessThanOrEqual(1);
          expect(kinds.filter((k) => k === 'total').length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('weights the model only as far as backtests earned it', () => {
    // The sims say the home side wins and covers every time; the market says a coin flip.
    const g = market('1', Array(100).fill(10), Array(100).fill(200), evenOdds);
    const legs = legsForGame(g);
    const ml = legs.find((l) => l.key.endsWith('ml:home'))!;
    const spread = legs.find((l) => l.key.endsWith('spread:home'))!;
    expect(ml.pModel).toBe(1);
    expect(ml.pBlend).toBeCloseTo(0.5); // college moneylines: market alone
    expect(spread.pBlend).toBeCloseTo(0.25 * 1 + 0.75 * 0.5); // college spreads: a quarter model
    expect(legsForGame(g, HALF).find((l) => l.key.endsWith('ml:home'))!.pBlend).toBeCloseTo(0.75);
  });

  it('suggests nothing where the market alone ranks every bet', () => {
    expect(modelHasSay('nba')).toBe(false);
    expect(modelHasSay('ncaam')).toBe(true);
    const g = market('1', Array(100).fill(10), Array(100).fill(200), evenOdds, 'nba');
    for (const l of legsForGame(g)) {
      expect(l.pBlend).toBeCloseTo(l.pFair);
      expect(l.ev).toBeLessThan(0); // the vig always wins against the market's own odds
    }
    const s = suggestParlays([g, market('2', Array(100).fill(-10), Array(100).fill(260), evenOdds, 'nba')]);
    expect(s.bySize[1].length + s.bySize[2].length + s.bySize[3].length).toBe(0);
  });
});
