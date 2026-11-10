// The injury-news scanner: while the slate board is open, reads ESPN's league-wide injury report
// every two minutes, compares it with the last report the scheduled job saved, and reprices the game
// of anyone newly ruled out, as reported and with him in. Polling pauses in a background tab unless
// notifications are on, so a scratch can still reach you on another tab.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { LeagueId, ScoreboardGame } from '../model/types';
import { PROP_WORDS } from '../model/parlays';
import { findNews, priceNews, type NewsEvent, type NewsPricing, type Simulate } from '../model/news';
import { loadInjuries } from '../data/espn/injuries';
import { loadInjuryLog } from '../track/forward';
import { CancelledError, runOutcomesInBackground } from '../sim/client';
import { Poller } from './live';

export const NEWS_MS = 120_000;
/** A priced event is repriced at most this often, to see whether the book has moved. */
const REPRICE_MS = 6 * 60_000;
const NOTIFY_KEY = 'conquer.newsNotify';
const SEEN_KEY = 'conquer.newsSeen';

export interface NewsItem {
  event: NewsEvent;
  /** "quiet": he wasn't projected for real minutes, so nothing moves. */
  status: 'pricing' | 'ok' | 'quiet' | 'error';
  pricing?: NewsPricing;
  pricedAt?: number;
  error?: string;
  /** When the scheduled job logged it, if it did. */
  loggedAt?: string;
}

export interface NewsScan {
  items: NewsItem[];
  status: 'idle' | 'running';
  checkedAt?: number;
  error?: string;
  /** Upcoming games being watched. */
  watching: number;
  paused: boolean;
  pause: () => void;
  resume: () => void;
  refresh: () => void;
  notify: { supported: boolean; on: boolean; denied: boolean; toggle: () => void };
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: nothing to remember */
    }
  },
};

const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;

/** The line a notification shows: the strongest prop the news moves. */
export function newsHeadline(item: NewsItem): { title: string; body: string } {
  const e = item.event;
  const top = item.pricing?.rows[0];
  const body = top
    ? `${top.player} ${top.side} ${top.line} ${PROP_WORDS[top.stat]}: sim ${top.shift > 0 ? '+' : '−'}${Math.abs(top.shift).toFixed(1)} with him out`
    : item.pricing
      ? `${item.pricing.label}: no posted prop moves enough to matter yet.`
      : 'Repricing his game now.';
  return { title: `${e.name} ruled out (${e.status})`, body };
}

const backgroundSimulate: Simulate = (spec, n, seed, opts) => runOutcomesInBackground(spec, n, seed, opts).promise;

export function useNews(league: LeagueId, games: ScoreboardGame[], enabled: boolean): NewsScan {
  const [items, setItems] = useState<Record<string, NewsItem>>({});
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [checkedAt, setCheckedAt] = useState<number>();
  const [error, setError] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [notifyOn, setNotifyOn] = useState(() => store.get(NOTIFY_KEY) === '1');
  const [denied, setDenied] = useState(() => notifySupported() && Notification.permission === 'denied');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const notifyRef = useRef(notifyOn);
  notifyRef.current = notifyOn;
  const upcoming = games.filter((g) => g.phase === 'pre' && Date.parse(g.date) > Date.now());
  const watching = league === 'nba' ? upcoming.length : 0;

  // A new date or league starts over.
  useEffect(() => setItems({}), [league, games.map((g) => g.id).join()]);

  const announce = useCallback((item: NewsItem) => {
    const seen: string[] = JSON.parse(store.get(SEEN_KEY) ?? '[]');
    if (seen.includes(item.event.key)) return;
    store.set(SEEN_KEY, JSON.stringify([...seen, item.event.key].slice(-200)));
    if (!notifyRef.current || !notifySupported() || Notification.permission !== 'granted') return;
    const { title, body } = newsHeadline(item);
    try {
      new Notification(title, { body, tag: item.event.key });
    } catch {
      /* some mobile browsers only notify from a service worker */
    }
  }, []);

  const scan = useCallback(
    async (signal: AbortSignal) => {
      const now = Date.now();
      const games = gamesRef.current.filter((g) => g.phase === 'pre' && Date.parse(g.date) > now);
      if (!games.length) {
        setCheckedAt(now);
        return;
      }
      setStatus('running');
      try {
        const [feed, log] = await Promise.all([loadInjuries(league, signal), loadInjuryLog(league, signal).catch(() => undefined)]);
        // News the job already logged (still out, game still ahead), then anything newer than its report.
        const ids = new Set(games.map((g) => g.id));
        const outNow = new Set(feed.filter((r) => r.injury.out).map((r) => `${r.teamId}|${r.athleteId}`));
        const events = new Map<string, NewsItem>();
        for (const e of log?.events ?? []) if (ids.has(e.gameId) && outNow.has(`${e.teamId}|${e.athleteId}`)) events.set(e.key, { event: e, status: 'pricing', loggedAt: e.seenAt });
        for (const e of findNews(feed, log?.players, games, now)) if (!events.has(e.key)) events.set(e.key, { event: e, status: 'pricing' });
        const prev = itemsRef.current;
        const next: Record<string, NewsItem> = {};
        for (const [k, it] of events) next[k] = prev[k] ? { ...prev[k], loggedAt: it.loggedAt ?? prev[k].loggedAt } : it;
        setItems(next);
        for (const [k, it] of Object.entries(next)) {
          if (signal.aborted) return;
          if (it.pricedAt && now - it.pricedAt < REPRICE_MS && it.status !== 'error') continue;
          let done: NewsItem;
          try {
            const p = await priceNews(league, it.event, feed, backgroundSimulate, { signal });
            done = { ...it, status: p ? 'ok' : 'quiet', pricing: p ?? undefined, pricedAt: Date.now(), error: undefined };
          } catch (e) {
            if (signal.aborted || e instanceof CancelledError || (e as Error)?.name === 'AbortError') return;
            done = { ...it, status: 'error', error: (e as Error)?.message ?? String(e), pricedAt: Date.now() };
          }
          setItems((cur) => (cur[k] ? { ...cur, [k]: done } : cur));
          if (done.status === 'ok') announce(done);
        }
        setError(undefined);
        setCheckedAt(Date.now());
      } catch (e) {
        if (!(signal.aborted || (e as Error)?.name === 'AbortError')) setError((e as Error)?.message ?? String(e));
      } finally {
        if (!signal.aborted) setStatus('idle');
      }
    },
    [league, announce],
  );

  const active = enabled && !paused && watching > 0;
  const [manual, setManual] = useState(0);
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    void scan(ac.signal);
    const poller = new Poller({
      interval: NEWS_MS,
      tick: (signal) => scan(signal).then(() => true),
      // With notifications on, keep checking in a background tab.
      ...(notifyOn ? { isHidden: () => false } : {}),
    });
    poller.start();
    return () => {
      ac.abort();
      poller.stop();
      setStatus('idle');
    };
  }, [active, scan, manual, notifyOn]);

  const toggle = useCallback(() => {
    if (notifyOn) {
      setNotifyOn(false);
      store.set(NOTIFY_KEY, '0');
      return;
    }
    if (!notifySupported()) return;
    void Notification.requestPermission().then((p) => {
      setDenied(p === 'denied');
      if (p === 'granted') {
        setNotifyOn(true);
        store.set(NOTIFY_KEY, '1');
      }
    });
  }, [notifyOn]);

  const list = Object.values(items).sort((a, b) => Date.parse(b.event.since ?? '') - Date.parse(a.event.since ?? '') || a.event.name.localeCompare(b.event.name));
  return {
    items: list,
    status,
    checkedAt,
    error,
    watching,
    paused,
    pause: useCallback(() => setPaused(true), []),
    resume: useCallback(() => setPaused(false), []),
    refresh: useCallback(() => {
      // A refresh reprices everything now.
      setItems((cur) => Object.fromEntries(Object.entries(cur).map(([k, it]) => [k, { ...it, pricedAt: undefined }])));
      setManual((m) => m + 1);
    }, []),
    notify: { supported: notifySupported(), on: notifyOn, denied, toggle },
  };
}
