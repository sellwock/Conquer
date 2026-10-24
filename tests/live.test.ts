import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller } from '../src/ui/live';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(results: (boolean | Error)[] = []) {
  let hidden = false;
  let visible: (() => void) | undefined;
  const calls: number[] = [];
  const tick = vi.fn(async () => {
    calls.push(Date.now());
    const r = results.shift() ?? true;
    if (r instanceof Error) throw r;
    return r;
  });
  const p = new Poller({
    tick,
    isHidden: () => hidden,
    onVisible: (cb) => {
      visible = cb;
      return () => (visible = undefined);
    },
  });
  return {
    p,
    tick,
    calls,
    hide: () => (hidden = true),
    show: () => {
      hidden = false;
      visible?.();
    },
    subscribed: () => !!visible,
  };
}

describe('live poller', () => {
  it('refreshes every 30 seconds, one at a time', async () => {
    const s = setup();
    s.p.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.tick).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(s.tick).toHaveBeenCalledTimes(4);
    s.p.stop();
  });

  it('waits for a slow refresh before scheduling the next', async () => {
    let release!: () => void;
    const tick = vi.fn(() => new Promise<boolean>((r) => (release = () => r(true))));
    const p = new Poller({ tick, isHidden: () => false, onVisible: () => () => {} });
    p.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('pauses while hidden and refreshes as soon as the tab is visible', async () => {
    const s = setup();
    s.p.start();
    s.hide();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.tick).toHaveBeenCalledTimes(0);
    s.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.tick).toHaveBeenCalledTimes(2);
    s.p.stop();
  });

  it('backs off to 60 then 120 seconds after errors and recovers', async () => {
    const s = setup([new Error('503'), new Error('503'), new Error('503'), true]);
    s.p.start();
    await vi.advanceTimersByTimeAsync(30_000); // error 1
    await vi.advanceTimersByTimeAsync(60_000); // error 2
    await vi.advanceTimersByTimeAsync(120_000); // error 3
    await vi.advanceTimersByTimeAsync(120_000); // ok
    await vi.advanceTimersByTimeAsync(30_000); // back to normal
    const gaps = s.calls.slice(1).map((t, i) => t - s.calls[i]);
    expect(gaps).toEqual([60_000, 120_000, 120_000, 30_000]);
    s.p.stop();
  });

  it('stops when the game is over and on stop()', async () => {
    const s = setup([true, false]);
    s.p.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.tick).toHaveBeenCalledTimes(2);
    expect(s.subscribed()).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.tick).toHaveBeenCalledTimes(2);

    const t = setup();
    t.p.start();
    t.p.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.tick).toHaveBeenCalledTimes(0);
    t.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.tick).toHaveBeenCalledTimes(0);
  });
});
