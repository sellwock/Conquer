// Stake sizing and the user's own bet log: grading from the saved box lines, and the summary.
import { describe, expect, it } from 'vitest';
import { kellyStake } from '../src/model/stake';
import { gradeBet, parseBets, summarizeBets, type MyBet } from '../src/track/myBets';
import type { CloseLine, PropEntry } from '../src/track/types';

const bet = (o: Partial<MyBet> = {}): MyBet => ({ id: 'b1', at: '2026-11-10T20:00:00Z', league: 'nba', gameId: 'g1', game: 'A @ H', athleteId: 'p1', player: 'P. One', stat: 'pts', line: 20.5, side: 'under', listed: -110, price: -110, stake: 10, pFit: 0.56, pFair: 0.5, ...o });
const entry = (o: Partial<PropEntry> = {}): PropEntry => ({ id: 'g1', league: 'nba', season: 2027, tip: '2026-11-11T00:00:00Z', home: { id: '1', abbr: 'H' }, away: { id: '2', abbr: 'A' }, status: 'final', players: {}, box: { p1: [18, 5, 4, 1], p2: null }, ...o });

describe('stake size', () => {
  it('stakes a quarter of Kelly, capped at 1% of the bankroll, and half that until the record is tested', () => {
    // 56% at -110: Kelly is (0.56 * 1.909 - 1) / 0.909 = 7.6% of the bankroll; a quarter is 1.9%, so the cap binds.
    expect(kellyStake(0.56, 1 + 100 / 110, 1000, true)).toBe(10);
    expect(kellyStake(0.56, 1 + 100 / 110, 1000, false)).toBe(5);
    // A thin edge: 53% at -110 is 1.3% Kelly, a quarter of which is under the cap.
    const thin = kellyStake(0.53, 1 + 100 / 110, 1000, true);
    expect(thin).toBeCloseTo((1000 * 0.25 * (0.53 * (1 + 100 / 110) - 1)) / (100 / 110), 1);
    expect(thin).toBeLessThan(10);
    // No edge, or no bankroll: nothing.
    expect(kellyStake(0.5, 1 + 100 / 110, 1000, true)).toBe(0);
    expect(kellyStake(0.6, 2, 0, true)).toBe(0);
  });
});

describe('my bets', () => {
  it('grades a bet from the saved box line, at the price taken', () => {
    expect(gradeBet(bet({ price: -120 }), entry())).toMatchObject({ result: 'win', final: 18, profit: 8.33 });
    expect(gradeBet(bet({ side: 'over' }), entry())).toMatchObject({ result: 'loss', profit: -10 });
    expect(gradeBet(bet({ stat: 'pra', line: 27 }), entry())).toMatchObject({ result: 'push', final: 27, profit: 0 });
    // The player sat: void, as at the book.
    expect(gradeBet(bet({ athleteId: 'p2' }), entry())).toMatchObject({ result: 'void', profit: 0 });
    // Not final yet, a game the job never logged, or a player it didn't log: still open.
    expect(gradeBet(bet(), entry({ status: 'open', box: undefined })).result).toBeUndefined();
    expect(gradeBet(bet(), undefined).result).toBeUndefined();
    expect(gradeBet(bet({ athleteId: 'p9' }), entry()).result).toBeUndefined();
  });

  it('says whether the closing line moved toward a pre-game bet', () => {
    const close = { takenAt: '', lines: [['p1', 'pts', 19.5, -110, -110]] as CloseLine[] };
    expect(gradeBet(bet(), entry({ close })).moved).toBe('toward');
    expect(gradeBet(bet({ side: 'over' }), entry({ close })).moved).toBe('away');
    expect(gradeBet(bet({ live: true }), entry({ close })).moved).toBeUndefined();
  });

  it('adds up decided bets, and what the taken price cost against the listed one', () => {
    const graded = [gradeBet(bet({ id: 'a' }), entry()), gradeBet(bet({ id: 'b', side: 'over', pFit: 0.6 }), entry()), gradeBet(bet({ id: 'c', athleteId: 'p2' }), entry()), gradeBet(bet({ id: 'd', gameId: 'g2', price: -120 }), undefined)];
    const s = summarizeBets(graded);
    expect(s).toMatchObject({ win: 1, loss: 1, returned: 1, open: 1, staked: 20 });
    expect(s.profit).toBeCloseTo(9.09 - 10, 2);
    expect(s.roi).toBeCloseTo(s.profit / 20, 9);
    expect(s.said).toBeCloseTo(0.58, 9);
    // One of four bets was taken at -120 instead of -110.
    expect(s.slippage).toBeCloseTo((120 / 220 - 110 / 210) / 4, 9);
  });

  it('reads back an export, dropping anything malformed or repeated', () => {
    const good = bet();
    const back = parseBets(JSON.parse(JSON.stringify({ v: 1, bets: [good, good, { ...good, id: 'x', stat: 'steals' }, { ...good, id: 'y', stake: -5 }, { ...good, id: 'z', price: 50 }, null, 'nope'] })));
    expect(back).toEqual([good]);
    expect(parseBets({})).toEqual([]);
    expect(parseBets([{ ...good, id: 'k', listed: undefined, pFair: undefined }])[0]).toMatchObject({ listed: -110, pFair: 0.5 });
  });
});
