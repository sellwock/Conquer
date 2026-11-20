// Live-pick alerts: which picks alert, and each only once.
import { beforeEach, describe, expect, it } from 'vitest';
import { alertMessage, alertable, type LiveAlert } from '../src/ui/liveAlerts';
import { firstSeen } from '../src/ui/notify';
import type { FitState } from '../src/ui/bestBets';
import type { GameMarket, PropMarket } from '../src/model/parlays';

const NOW = Date.parse('2026-11-20T02:00:00Z');
const N = 400;

// The fitted chance follows the simulation, so a prop the simulation likes is a pick.
const fitOf = (roi: number): FitState => ({
  fits: { live: [0, 1, 0.5], minEdge: 0.03 },
  file: { live: { test: { picks: { win: 60, loss: 40, roi, lo: -0.05, hi: 0.2 } } } } as unknown as FitState['file'],
});

function prop(player: string, overShare: number, updatedMinAgo: number | undefined): PropMarket {
  const hits = new Uint8Array(N);
  for (let i = 0; i < N; i++) hits[i] = i < overShare * N ? 1 : 0;
  return {
    athleteId: player,
    player,
    stat: 'pts',
    line: 20.5,
    over: -110,
    under: -110,
    hits,
    mean: 24,
    now: 12,
    updated: updatedMinAgo == null ? undefined : new Date(NOW - updatedMinAgo * 60_000).toISOString(),
  };
}

const market = (props: PropMarket[]): GameMarket => ({
  gameId: 'g1',
  league: 'nba',
  label: 'BOS @ NY',
  home: 'NY',
  away: 'BOS',
  odds: { provider: 'DraftKings' },
  margin: new Int16Array(N),
  total: new Int16Array(N),
  props,
  live: true,
});

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('live-pick alerts', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('alerts on a fitted pick whose line the book just changed, naming the bet, price and line age', () => {
    const a = alertable('nba', fitOf(0.1), [market([prop('A. One', 0.8, 2)])], NOW);
    expect(a).toHaveLength(1);
    expect(a[0].key).toBe('g1|A. One|pts|over');
    expect(a[0].title).toMatch(/over 20\.5/);
    expect(a[0].title).toMatch(/-110|−110/);
    expect(a[0].body).toMatch(/line set 2 min ago/);
    expect(a[0].body).toMatch(/Still a bet at/);
  });

  it('leaves out stale and undated lines', () => {
    const a = alertable('nba', fitOf(0.1), [market([prop('Stale', 0.8, 9), prop('Undated', 0.8, undefined), prop('Fresh', 0.8, 0)])], NOW);
    expect(a.map((x) => x.key)).toEqual(['g1|Fresh|pts|over']);
  });

  it('stays quiet while the live record is not ahead', () => {
    expect(alertable('nba', fitOf(-0.02), [market([prop('A. One', 0.8, 1)])], NOW)).toEqual([]);
  });

  it('leaves out games that are not live', () => {
    expect(alertable('nba', fitOf(0.1), [{ ...market([prop('A. One', 0.8, 1)]), live: undefined }], NOW)).toEqual([]);
  });

  it('announces each pick once, however often the board refreshes', () => {
    expect(firstSeen('seen', ['a', 'b'])).toEqual(['a', 'b']);
    expect(firstSeen('seen', ['a', 'b'])).toEqual([]);
    expect(firstSeen('seen', ['b', 'c'])).toEqual(['c']);
  });

  it('folds several new picks into one notification', () => {
    const one: LiveAlert = { key: 'k1', title: 'A over 20.5 -110', body: 'x' };
    const two: LiveAlert = { key: 'k2', title: 'B under 8.5 +105', body: 'y' };
    expect(alertMessage([])).toBeUndefined();
    expect(alertMessage([one])).toBe(one);
    expect(alertMessage([one, two])).toMatchObject({ title: '2 new live picks', body: 'A over 20.5 -110\nB under 8.5 +105' });
  });
});
