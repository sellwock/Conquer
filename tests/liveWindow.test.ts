// Where a game in progress stands against the live record: the stretch it covers, and the looks
// the scheduled job takes before and after it.
import { describe, expect, it } from 'vitest';
import { liveStage, playedShare, stageOf } from '../src/model/liveWindow';
import { liveLook } from '../src/track/job';
import type { PropEntry, PropSnap } from '../src/track/types';

describe('the live window', () => {
  it('covers the NBA 2nd and 3rd quarters', () => {
    expect(liveStage('nba', 1, 300)).toBe('early');
    expect(liveStage('nba', 2, 720)).toBe('tested');
    expect(liveStage('nba', 3, 1)).toBe('tested');
    expect(liveStage('nba', 4, 720)).toBe('late');
    expect(liveStage('nba', 5, 200)).toBe('late');
  });

  it('covers college from 10:00 into the game to 10:00 from the end', () => {
    expect(playedShare('ncaam', 1, 600)).toBe(0.25);
    expect(liveStage('ncaam', 1, 601)).toBe('early');
    expect(liveStage('ncaam', 1, 600)).toBe('tested');
    expect(liveStage('ncaam', 2, 601)).toBe('tested');
    expect(liveStage('ncaam', 2, 600)).toBe('late');
  });

  it('treats a live market without a game clock as tested, as before', () => {
    expect(stageOf({ league: 'nba' })).toBe('tested');
    expect(stageOf({ league: 'nba', clock: { period: 4, clockSec: 100 } })).toBe('late');
  });

  it('takes each look once, in its stretch', () => {
    const snap = (period: number, clockSec: number): PropSnap => ({ model: '1', takenAt: '', n: 1, rows: [], at: { period, clockSec, home: 0, away: 0 } });
    const none = undefined as PropEntry | undefined;
    const with_ = (o: Partial<PropEntry>) => o as PropEntry;
    expect(liveLook('nba', none, 1, 660)).toBeUndefined();
    expect(liveLook('nba', none, 1, 300)).toBe('early');
    expect(liveLook('nba', with_({ early: snap(1, 300) }), 1, 100)).toBeUndefined();
    expect(liveLook('nba', with_({ early: snap(1, 300) }), 2, 600)).toBe('live');
    expect(liveLook('nba', with_({ live: snap(2, 600) }), 2, 100)).toBeUndefined();
    expect(liveLook('nba', with_({ live: snap(2, 600) }), 3, 600)).toBe('live2');
    // A first look taken after halftime gets no second.
    expect(liveLook('nba', with_({ live: snap(3, 600) }), 3, 100)).toBeUndefined();
    expect(liveLook('nba', with_({ live: snap(2, 600), live2: snap(3, 600) }), 4, 600)).toBe('late');
    expect(liveLook('nba', with_({ late: snap(4, 600) }), 4, 400)).toBeUndefined();
    expect(liveLook('nba', none, 4, 120)).toBeUndefined();
    expect(liveLook('nba', none, undefined, undefined)).toBeUndefined();
  });
});
