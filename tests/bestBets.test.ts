// Player props priced by the fitted pick model: the legs, the single bets it would make (by the
// rule its record is scored on), and parlays built from them.
import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/lib/rng';
import { MAX_PRICE, defaultPickMode, evaluate, fitSingles, legsForGame, noVig, onePerPlayer, suggestParlays, toDecimal, weightsFor, worthAt, SIM_ONLY, type GameMarket, type PropMarket } from '../src/model/parlays';
import { fittedOver, type FitCoef, type PropFits } from '../src/model/propFit';
import { boardPicks } from '../src/model/slate';
import { fitRows, picksOf } from '../src/track/fit';
import { propRows } from '../src/track/job';
import type { PropEntry } from '../src/track/types';
import { ageText, lineAgeMin } from '../src/ui/format';

const N = 2000;
/** The over wins in the first `pOver` share of simulations (so two props with this are as linked as can be). */
const hits = (pOver: number, pPush = 0) => Uint8Array.from({ length: N }, (_, k) => (k < Math.round(pOver * N) ? 1 : k < Math.round((pOver + pPush) * N) ? 2 : 0));
/** The over wins in a `pOver` share of simulations picked independently of anything else. */
const scattered = (pOver: number, seed: string) => {
  const rng = makeRng(seed);
  return Uint8Array.from({ length: N }, () => (rng() < pOver ? 1 : 0));
};
const prop = (athleteId: string, stat: PropMarket['stat'], line: number, over: number, under: number, h: Uint8Array): PropMarket => ({ athleteId, player: `P. ${athleteId}`, stat, line, over, under, hits: h, mean: line });
const market = (id: string, props: PropMarket[], extra: Partial<GameMarket> = {}): GameMarket => ({
  gameId: id,
  league: 'nba',
  label: `A${id} @ H${id}`,
  home: `H${id}`,
  away: `A${id}`,
  odds: { provider: 'Book', spread: -2.5, total: 224.5, homeML: -140, awayML: 120 },
  margin: new Int16Array(N).fill(3),
  total: new Int16Array(N).fill(220),
  props,
  ...extra,
});

// Overs a little worse than the book's odds say, and the simulation worth a fifth of its disagreement.
const PRE: FitCoef = [-0.08, 1, 0.2];
// A live fit that fades the simulation.
const LIVE: FitCoef = [0, 1, -0.3];
const FITS: PropFits = { pre: PRE, live: LIVE, minEdge: 0.03 };
const W = weightsFor('nba', 'blend', FITS);

describe('props priced by the pick model', () => {
  const m = market('1', [prop('a', 'pts', 20.5, -110, -110, hits(0.3)), prop('b', 'reb', 6.5, 120, -150, hits(0.6))]);

  it('prices each side by the fit of the book\'s odds and the simulation, and game lines as before', () => {
    const legs = legsForGame(m, W);
    const [aOver, aUnder] = legs.filter((l) => l.prop?.athleteId === 'a');
    expect(aOver.fitted).toBe(true);
    expect(aOver.pBlend).toBeCloseTo(fittedOver(PRE, 0.5, 0.3), 12);
    // The fit models the over; the under is what's left, not a mirror image.
    expect(aUnder.pBlend).toBeCloseTo(1 - aOver.pBlend, 12);
    expect(aUnder.pBlend).not.toBeCloseTo(fittedOver(PRE, 0.5, 0.7), 3);
    expect(aUnder.ev).toBeCloseTo(aUnder.pBlend * toDecimal(-110) - 1, 12);
    const bOver = legs.find((l) => l.prop?.athleteId === 'b' && l.side === 'over')!;
    expect(bOver.pBlend).toBeCloseTo(fittedOver(PRE, noVig(120, -150)[0], 0.6), 12);
    // NBA game lines stay with the market: the fit says nothing about them.
    for (const l of legs.filter((x) => !x.prop)) {
      expect(l.fitted).toBeUndefined();
      expect(l.pBlend).toBeCloseTo(l.pFair, 12);
    }
  });

  it('falls back to the unfitted weights without a fit, or without one for this kind of line', () => {
    for (const l of legsForGame(m).filter((x) => x.prop)) {
      expect(l.fitted).toBeUndefined();
      expect(l.pBlend).toBeCloseTo(l.pFair, 12);
    }
    const preOnly = weightsFor('nba', 'blend', { pre: PRE, minEdge: 0.03 });
    for (const l of legsForGame({ ...m, live: true }, preOnly).filter((x) => x.prop)) expect(l.fitted).toBeUndefined();
    // The simulation's own ranking never uses the fit.
    expect(weightsFor('nba', 'sim', FITS).fit).toBeUndefined();
  });

  it('uses the live fit for a game in progress', () => {
    const over = legsForGame({ ...m, live: true }, W).find((l) => l.prop?.athleteId === 'a' && l.side === 'over')!;
    expect(over.pBlend).toBeCloseTo(fittedOver(LIVE, 0.5, 0.3), 12);
    // That fit fades the simulation: it said 30%, so the over comes out above the book's 50%.
    expect(over.pBlend).toBeGreaterThan(0.5);
  });

  it('opens on the evidence once there is a fit, and hands back one weights object per fit', () => {
    expect(defaultPickMode('nba')).toBe('sim');
    expect(defaultPickMode('nba', FITS)).toBe('blend');
    expect(defaultPickMode('nba', { live: LIVE, minEdge: 0.03 })).toBe('blend');
    expect(weightsFor('nba', 'blend', FITS)).toBe(W);
    expect(weightsFor('ncaam', 'blend', FITS)).not.toBe(W);
    expect(weightsFor('ncaam', 'blend', FITS)).toMatchObject({ spread: 0.2, total: 0.2, fit: FITS });
  });
});

describe('the pick model\'s single bets', () => {
  // Player a: two lines the fit likes the under on, the second more. Player b: nothing clears the
  // bar. Player c: an over at a long price, and a longer one past the cap.
  const props = [
    prop('a', 'pts', 20.5, -110, -110, hits(0.25)),
    prop('a', 'pra', 30.5, -105, -115, hits(0.05)),
    prop('b', 'reb', 6.5, -110, -110, hits(0.5)),
    prop('c', 'ast', 4.5, 180, -230, hits(0.75)),
    prop('c', 'tpm', 2.5, 260, -340, hits(0.9)),
  ];
  const m = market('1', props);

  it('makes at most one bet per player, the best that clears the bar, at no longer than the cap', () => {
    const picks = fitSingles([m], W);
    expect(picks.map((p) => p.legs[0].key).sort()).toEqual(['1:prop:a:pra:under', '1:prop:c:ast:over']);
    for (const p of picks) {
      const l = p.legs[0];
      expect(l.pBlend * l.decimal - 1).toBeGreaterThanOrEqual(FITS.minEdge);
      expect(l.price).toBeLessThanOrEqual(MAX_PRICE[1]);
      // A single is priced exactly: no leg to link it to.
      expect(p.ev).toBeCloseTo(l.ev, 12);
      expect(p.pHit).toBeCloseTo(l.pBlend, 12);
    }
    // Best first.
    expect(picks[0].ev).toBeGreaterThan(picks[1].ev);
    // Player a's other under clears the bar too, but less well: one bet per player.
    const other = legsForGame(m, W).find((l) => l.key === '1:prop:a:pts:under')!;
    expect(other.ev).toBeGreaterThan(FITS.minEdge);
    expect(other.ev).toBeLessThan(picks.find((p) => p.legs[0].prop!.athleteId === 'a')!.ev);
    expect(fitSingles([m], weightsFor('nba', 'blend'))).toEqual([]);
    expect(fitSingles([m], SIM_ONLY)).toEqual([]);
  });

  it('lists exactly the bets the fit\'s record is scored on', () => {
    // The same lines as the scheduled job logs them, graded, then scored by the same coefficients.
    const e: PropEntry = {
      id: '1',
      league: 'nba',
      season: 2027,
      tip: '2026-11-02T00:00:00Z',
      home: { id: '1', abbr: 'H1' },
      away: { id: '2', abbr: 'A1' },
      status: 'final',
      players: {},
      pre: { model: 'm', takenAt: '', n: N, rows: propRows(props) },
      box: { a: [40, 5, 5, 1], b: [0, 9, 0, 0], c: [0, 0, 9, 9] },
    };
    const scored = fitRows([e], 'pre').map((row) => ({ row, pOver: fittedOver(PRE, row.pMarket, row.pSim) }));
    expect(scored).toHaveLength(props.length);
    const tested = picksOf(scored, FITS.minEdge).map((k) => `${k.row.athleteId}:${k.row.stat}:${k.side}`).sort();
    const listed = fitSingles([m], W).map((p) => `${p.legs[0].prop!.athleteId}:${p.legs[0].prop!.stat}:${p.legs[0].side}`).sort();
    expect(listed).toEqual(tested);
    expect(listed).toHaveLength(2);
  });

  it('shares one rule for both', () => {
    const c = (athleteId: string, ev: number, price = -110) => ({ gameId: 'g', athleteId, price, ev });
    expect(onePerPlayer([c('a', 0.04), c('a', 0.09), c('b', 0.029), c('c', 0.2, 201), c('d', 0.03)], 0.03)).toEqual([c('a', 0.09), c('d', 0.03)]);
  });

  it('gives the slate board its prop pick, by the same rule', () => {
    expect(boardPicks(m, W).bestProp!.legs[0].key).toBe(fitSingles([m], W)[0].legs[0].key);
    // A lean that doesn't clear the fit's bar is a pass, not a pick.
    const quiet = market('2', [prop('b', 'reb', 6.5, -110, -110, hits(0.45))]);
    const lean = legsForGame(quiet, W).find((l) => l.prop && l.side === 'under')!;
    expect(lean.ev).toBeGreaterThan(0);
    expect(lean.ev).toBeLessThan(FITS.minEdge);
    expect(boardPicks(quiet, W)).toMatchObject({ bestProp: undefined, hasProps: true });
  });

  it('refunds a push at the fitted chance of the rest', () => {
    const l = legsForGame(market('1', [prop('a', 'pts', 20, -110, -110, hits(0.2, 0.1))]), W).find((x) => x.prop && x.side === 'under')!;
    expect(l.pPush).toBeCloseTo(0.1, 12);
    // Decided outcomes: the over won 0.2 of 0.9.
    expect(l.pBlend).toBeCloseTo(1 - fittedOver(PRE, 0.5, 0.2 / 0.9), 12);
    const p = evaluate([l]);
    expect(p.ev).toBeCloseTo(0.1 + 0.9 * l.pBlend * toDecimal(-110) - 1, 12);
    expect(p.pHit).toBeCloseTo(0.1 + 0.9 * l.pBlend, 12);
    expect(p.pWin).toBeCloseTo(0.9 * l.pBlend, 12);
  });
});

describe('fitted legs in one game', () => {
  const under = (m: GameMarket, id: string) => legsForGame(m, W).find((l) => l.prop?.athleteId === id && l.side === 'under')!;

  it('keeps each leg\'s fitted chance and the simulations\' link between them', () => {
    // In the simulations a's under and b's under both win 60%, always together.
    const linked = market('1', [prop('a', 'pts', 20.5, -110, -110, hits(0.4)), prop('b', 'pts', 15.5, -110, -110, hits(0.4))]);
    const [a, b] = [under(linked, 'a'), under(linked, 'b')];
    expect(a.pBlend).toBeLessThan(a.pModel); // the fit pulls the simulation's 60% toward the book's 50%
    const p = evaluate([a, b]);
    // As linked as the simulations say, at the fitted chances: together almost whenever one wins.
    expect(p.pHit).toBeGreaterThan(0.95 * a.pBlend);
    expect(p.pHit).toBeLessThanOrEqual(a.pBlend + 1e-9);
    expect(p.pWin).toBeCloseTo(p.pHit, 12);
    expect(p.sameGame).toBe(true);
  });

  it('multiplies legs the simulations show as unrelated', () => {
    const apart = market('1', [prop('a', 'pts', 20.5, -110, -110, scattered(0.4, 'a')), prop('b', 'pts', 15.5, -110, -110, scattered(0.45, 'b'))]);
    const [a, b] = [under(apart, 'a'), under(apart, 'b')];
    expect(evaluate([a, b]).pHit).toBeCloseTo(a.pBlend * b.pBlend, 2);
  });

  it('never puts the pair above its weaker leg, however far the fit moved them', () => {
    // The simulations rarely see either under win, and never apart; the live fit fades them hard.
    const m = market('1', [prop('a', 'pts', 20.5, -110, -110, hits(0.9)), prop('b', 'pts', 15.5, -110, -110, hits(0.9))], { live: true });
    const [a, b] = [under(m, 'a'), under(m, 'b')];
    expect(a.pBlend).toBeGreaterThan(3 * a.pModel);
    const p = evaluate([a, b]);
    expect(p.pHit).toBeLessThanOrEqual(Math.min(a.pBlend, b.pBlend) + 1e-9);
    expect(p.pHit).toBeGreaterThan(a.pBlend * b.pBlend);
  });

  it('treats legs as unrelated when the simulations never saw one of them lose', () => {
    const m = market('1', [prop('a', 'pts', 20.5, -110, -110, hits(0)), prop('b', 'pts', 15.5, -110, -110, hits(0))]);
    const [a, b] = [under(m, 'a'), under(m, 'b')];
    expect(a.pModel).toBe(1);
    expect(evaluate([a, b]).pHit).toBeCloseTo(a.pBlend * b.pBlend, 9);
  });

  it('leaves the simulations\' own joint chance alone when no leg was reweighted', () => {
    const m = market('1', [prop('a', 'pts', 20.5, -110, -110, hits(0.4)), prop('b', 'pts', 15.5, -110, -110, hits(0.4))]);
    const legs = legsForGame(m, SIM_ONLY).filter((l) => l.side === 'under');
    const p = evaluate(legs);
    expect(p.pHit).toBe(0.6);
    expect(p.pHit).toBe(p.pModel);
  });
});

describe('parlays from the pick model', () => {
  const game = (id: string) =>
    market(id, [
      prop(`${id}a`, 'pts', 20.5, -110, -110, scattered(0.2, `${id}a`)),
      prop(`${id}b`, 'reb', 7.5, -110, -110, scattered(0.2, `${id}b`)),
      prop(`${id}c`, 'ast', 5.5, -110, -110, scattered(0.5, `${id}c`)),
    ]);
  const games = [game('1'), game('2'), game('3')];
  const s = suggestParlays(games, 3, W);

  it('builds them only from bets worth making alone, in different games', () => {
    const singles = new Set(fitSingles(games, W).map((p) => p.legs[0].key));
    expect(singles.size).toBe(6);
    for (const size of [2, 3] as const) {
      expect(s.bySize[size].length).toBeGreaterThan(0);
      for (const p of s.bySize[size]) {
        expect(p.sameGame).toBe(false);
        expect(new Set(p.legs.map((l) => l.gameId)).size).toBe(size);
        for (const l of p.legs) expect(singles.has(l.key)).toBe(true);
        // Independent games: the edges compound.
        expect(p.ev).toBeCloseTo(p.legs.reduce((x, l) => x * (1 + l.ev), 1) - 1, 9);
      }
    }
    // Prop singles are the best-bets list; NBA game lines have no say, so there are no others.
    expect(s.bySize[1]).toEqual([]);
  });

  it('lists same-game combinations apart, by the price they would need', () => {
    expect(s.sameGame.length).toBeGreaterThan(0);
    for (const p of s.sameGame) {
      expect(p.sameGame).toBe(true);
      // Worth it at a price that returns the bar when every leg wins.
      expect(p.pWin * worthAt(p, FITS.minEdge)).toBeCloseTo(1 + FITS.minEdge, 12);
    }
    const room = s.sameGame.map((p) => worthAt(p, FITS.minEdge) / p.decimal);
    expect([...room].sort((x, y) => x - y)).toEqual(room);
    // Without a fit there is no such list, and same-game parlays stay among the rest.
    expect(suggestParlays(games, 3, SIM_ONLY).sameGame).toEqual([]);
  });

  it('finds nothing to combine in one game', () => {
    const one = suggestParlays([games[0]], 3, W);
    expect(one.bySize[2]).toEqual([]);
    expect(one.bySize[3]).toEqual([]);
    expect(one.sameGame.length).toBeGreaterThan(0);
  });
});

describe('live line age', () => {
  it('counts whole minutes since the book last changed a line, when the feed says', () => {
    const now = Date.parse('2026-11-10T02:10:30Z');
    expect(lineAgeMin('2026-11-10T02:04:00Z', now)).toBe(6);
    expect(lineAgeMin('2026-11-10T02:10:10Z', now)).toBe(0);
    expect(lineAgeMin('2026-11-10T02:11:00Z', now)).toBe(0); // a clock a little ahead
    expect(lineAgeMin(undefined, now)).toBeUndefined();
    expect(lineAgeMin('soon', now)).toBeUndefined();
    expect([0, 4, 72].map(ageText)).toEqual(['just now', '4 min', '1 h 12 min']);
  });

  it('carries the time from the feed to the leg', () => {
    const m = market('1', [{ ...prop('a', 'pts', 20.5, -110, -110, hits(0.3)), updated: '2026-11-10T02:04:00Z', now: 12 }], { live: true });
    expect(legsForGame(m, W).find((l) => l.prop)!.prop).toMatchObject({ updated: '2026-11-10T02:04:00Z', now: 12 });
  });
});
