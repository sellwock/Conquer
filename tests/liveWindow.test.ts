// Where a game in progress stands against the live record: the stretch it covers, and the looks
// the scheduled job takes before and after it.
import { describe, expect, it } from 'vitest';
import { liveStage, playedShare, stageOf } from '../src/model/liveWindow';
import { liveLook } from '../src/track/job';
import { stageAhead, type FitState } from '../src/ui/bestBets';
import { STAGE_MIN_PICKS } from '../src/model/propFit';
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

  it("lists a stretch's picks with the rest only once its own record is ahead over enough picks", () => {
    type Picks = { win: number; loss: number; roi: number; lo: number; hi: number };
    const fit = (late?: Picks) => ({ fits: { live: [0, 1, 0], minEdge: 0.03 }, file: { live: { ...(late ? { late: { picks: late } } : {}) } } }) as unknown as FitState;
    expect(STAGE_MIN_PICKS).toBe(100);
    expect(stageAhead(fit(), 'tested')).toBe(true);
    expect(stageAhead(fit(), 'late')).toBe(false);
    // A good first night is a coin flip, not a record.
    expect(stageAhead(fit({ win: 3, loss: 1, roi: 0.4, lo: -0.5, hi: 1 }), 'late')).toBe(false);
    expect(stageAhead(fit({ win: 57, loss: 42, roi: 0.1, lo: -0.05, hi: 0.25 }), 'late')).toBe(false);
    expect(stageAhead(fit({ win: 58, loss: 42, roi: 0.1, lo: -0.05, hi: 0.25 }), 'late')).toBe(true);
    expect(stageAhead(fit({ win: 50, loss: 55, roi: -0.05, lo: -0.2, hi: 0.1 }), 'late')).toBe(false);
    // Each stretch on its own record.
    expect(stageAhead(fit({ win: 58, loss: 42, roi: 0.1, lo: -0.05, hi: 0.25 }), 'early')).toBe(false);
  });
});
