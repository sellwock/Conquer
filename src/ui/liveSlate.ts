// Prices every game in progress for live parlays: each game's in-game prop lines and game lines
// (moneyline, spread, total), and a simulation from its current score, clock and box score. Refreshes every two minutes
// while asked to (and the tab is visible). Nothing is cached: live state goes stale in minutes.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { GameData, LeagueId, ScoreboardGame } from '../model/types';
import type { GameMarket } from '../model/parlays';
import { priceLiveGame, type Simulate } from '../model/liveMarket';
import { mapLimit } from '../data/espn/client';
import { CancelledError, runOutcomesInBackground } from '../sim/client';
import { Poller } from './live';

export { priceLiveGame, type Simulate };

export const LIVE_SLATE_MS = 120_000;
const CONCURRENCY = 2;

/**
 * Games that are, or may by now be, in progress (the scoreboard isn't refreshed after it loads),
 * leaving out `exclude`: the open game when its own simulation from now already prices it.
 */
export const liveCandidates = (games: ScoreboardGame[], exclude: string | undefined, now = Date.now()) =>
  games.filter((g) => g.id !== exclude && (g.phase === 'in' || (g.phase === 'pre' && Date.parse(g.date) <= now))).map((g) => g.id);

export interface LiveSlate {
  markets: Record<string, GameMarket>;
  status: 'idle' | 'running';
  done: number;
  total: number;
  failed: number;
  updatedAt?: number;
  paused: boolean;
  /** Games that could be live, before they're priced. */
  candidates: number;
  pause: () => void;
  resume: () => void;
  refresh: () => void;
}

const backgroundSimulate: Simulate = (spec, n, seed, opts) => runOutcomesInBackground(spec, n, seed, opts).promise;

export function useLiveSlate(league: LeagueId, games: ScoreboardGame[], exclude: string | undefined, enabled: boolean, seed: string): LiveSlate {
  const [markets, setMarkets] = useState<Record<string, GameMarket>>({});
  const [progress, setProgress] = useState({ status: 'idle' as 'idle' | 'running', done: 0, total: 0, failed: 0 });
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [paused, setPaused] = useState(false);
  const states = useRef(new Map<string, GameData>());
  const ids = liveCandidates(games, exclude);
  const idsKey = ids.join();
  const idsRef = useRef(ids);
  idsRef.current = ids;

  // A new date or league starts over.
  useEffect(() => {
    states.current.clear();
    setMarkets({});
    setUpdatedAt(undefined);
  }, [league, games.map((g) => g.id).join()]);

  const scan = useCallback(
    async (signal: AbortSignal) => {
      const targets = idsRef.current;
      let done = 0, failed = 0;
      setProgress({ status: 'running', done, total: targets.length, failed });
      const next: Record<string, GameMarket> = {};
      await mapLimit(targets, CONCURRENCY, async (id) => {
        if (signal.aborted) return;
        try {
          const r = await priceLiveGame(league, id, states.current.get(id), seed, backgroundSimulate, signal);
          if (r.game.phase === 'post') states.current.delete(id);
          else states.current.set(id, r.game);
          if (r.market) next[id] = r.market;
        } catch (e) {
          if (!(signal.aborted || e instanceof CancelledError || (e as Error)?.name === 'AbortError')) failed++;
        } finally {
          done++;
          if (!signal.aborted) setProgress({ status: 'running', done, total: targets.length, failed });
        }
      });
      if (signal.aborted) return;
      setMarkets(next);
      setUpdatedAt(Date.now());
      setProgress({ status: 'idle', done, total: targets.length, failed });
    },
    [league, seed],
  );

  const active = enabled && !paused && ids.length > 0;
  const [manual, setManual] = useState(0);
  const handled = useRef(0);
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    // A fresh enough pass is kept, unless a refresh was asked for; otherwise price now, then every
    // two minutes while the tab is visible.
    if (!updatedAt || Date.now() - updatedAt > LIVE_SLATE_MS || manual !== handled.current) {
      handled.current = manual;
      void scan(ac.signal);
    }
    const poller = new Poller({ interval: LIVE_SLATE_MS, tick: (signal) => scan(signal).then(() => true) });
    poller.start();
    return () => {
      ac.abort();
      poller.stop();
      setProgress((p) => ({ ...p, status: 'idle' }));
    };
  }, [active, idsKey, scan, manual]);

  return {
    markets,
    ...progress,
    updatedAt,
    paused,
    candidates: ids.length,
    pause: useCallback(() => setPaused(true), []),
    resume: useCallback(() => setPaused(false), []),
    refresh: useCallback(() => setManual((k) => k + 1), []),
  };
}
