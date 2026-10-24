// Polls a live game. One request at a time: each refresh schedules the next only after it
// finishes. Pauses while the tab is hidden and refreshes as soon as it's visible again; backs off
// after errors; stops when the tick says the game is over.

export const LIVE_INTERVAL = 30_000;
export const LIVE_BACKOFF = [60_000, 120_000];

export interface PollerOptions {
  /** Fetch and apply one refresh. Resolve false when there's nothing left to poll for. */
  tick: (signal: AbortSignal) => Promise<boolean>;
  interval?: number;
  backoff?: number[];
  isHidden?: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe function. */
  onVisible?: (cb: () => void) => () => void;
  onError?: (e: unknown) => void;
}

const browserHidden = () => typeof document !== 'undefined' && document.hidden;
function browserOnVisible(cb: () => void) {
  if (typeof document === 'undefined') return () => {};
  const h = () => !document.hidden && cb();
  document.addEventListener('visibilitychange', h);
  return () => document.removeEventListener('visibilitychange', h);
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ac: AbortController | undefined;
  private unsubscribe: (() => void) | undefined;
  private errors = 0;
  private paused = false;
  private busy = false;
  private stopped = true;

  constructor(private o: PollerOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = (this.o.onVisible ?? browserOnVisible)(() => {
      if (this.paused) {
        this.paused = false;
        void this.run();
      }
    });
    this.schedule(this.o.interval ?? LIVE_INTERVAL);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ac?.abort();
    this.unsubscribe?.();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if ((this.o.isHidden ?? browserHidden)()) this.paused = true;
      else void this.run();
    }, ms);
  }

  private async run() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    this.ac = new AbortController();
    let more = true;
    try {
      more = await this.o.tick(this.ac.signal);
      this.errors = 0;
    } catch (e) {
      if (this.stopped) return;
      this.errors++;
      this.o.onError?.(e);
    } finally {
      this.busy = false;
    }
    if (!more) return this.stop();
    const backoff = this.o.backoff ?? LIVE_BACKOFF;
    this.schedule(this.errors ? backoff[Math.min(this.errors, backoff.length) - 1] : (this.o.interval ?? LIVE_INTERVAL));
  }
}
