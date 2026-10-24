// Simulated markets for the date's upcoming games, shared by the slate board and the parlays tab.
// Scans two games at a time with the lighter outcomes-only simulation and caches each game for
// 30 minutes per model version, so reloading or switching views doesn't start over.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { buildSpec } from '../model/build';
import type { GameData, LeagueId, ScoreboardGame } from '../model/types';
import { MODEL_VERSION } from '../model/version';
import { packMarket, unpackMarket, type PackedMarket } from '../model/slate';
import type { GameMarket } from '../model/parlays';
import { mapLimit, readCache, writeCache } from '../data/espn/client';
import { loadGame } from '../data/espn/load';
import { CancelledError, runOutcomesInBackground } from '../sim/client';
import type { ScanState } from './parlays';

const SLATE_SIMS = 2000;
const SAMPLE_GAMES = 10;
const FRESH_MS = 30 * 60_000;
const CONCURRENCY = 2;

const cacheKey = (league: LeagueId, id: string) => `slate.${MODEL_VERSION}.${league}.${id}`;

export function marketFrom(g: GameData, o: { margin: Int16Array; total: Int16Array }, note?: string): GameMarket | undefined {
  if (g.phase !== 'pre' || !g.odds) return undefined;
  return { gameId: g.id, label: `${g.away.abbr} @ ${g.home.abbr}`, home: g.home.abbr, away: g.away.abbr, tip: g.date, note, odds: g.odds, margin: o.margin, total: o.total };
}

export interface Slate {
  markets: Record<string, GameMarket>;
  /** Upcoming games not simulated yet (the open game is left to the main simulation). */
  pending: ScoreboardGame[];
  scan: ScanState;
  start: () => void;
  stop: () => void;
  /** Adds the open game's market from the main simulation. */
  put: (m: GameMarket) => void;
}

/**
 * `games` should be the loaded scoreboard for `date` (empty while it loads). With `auto`, the scan
 * starts by itself once per date, after the cache has been read; Stop is respected.
 */
export function useSlate(league: LeagueId, date: string, games: ScoreboardGame[], seed: string, openGame: string | undefined, auto: boolean): Slate {
  const [markets, setMarkets] = useState<Record<string, GameMarket>>({});
  // Games found to have no posted line, so they aren't offered again.
  const [noLine, setNoLine] = useState<Record<string, true>>({});
  const [scan, setScan] = useState<ScanState>({ status: 'idle', done: 0, total: 0, failed: 0 });
  const abort = useRef<AbortController | null>(null);
  const gameIds = games.map((g) => g.id).join();
  const slateKey = `${league}|${date}|${gameIds}`;
  const [ready, setReady] = useState('');

  // New date or league: start over, picking up anything simulated in the last half hour.
  useEffect(() => {
    abort.current?.abort();
    setScan({ status: 'idle', done: 0, total: 0, failed: 0 });
    const fresh: Record<string, GameMarket> = {};
    for (const g of games) {
      if (g.phase !== 'pre') continue;
      const c = readCache<PackedMarket>(cacheKey(league, g.id));
      if (c && Date.now() - c.at < FRESH_MS) fresh[g.id] = unpackMarket(c);
    }
    // Keep what's already here for these games (the open game's simulation may have landed first).
    const ids = new Set(games.map((g) => g.id));
    setMarkets((ms) => ({ ...fresh, ...Object.fromEntries(Object.entries(ms).filter(([id]) => ids.has(id))) }));
    setNoLine({});
    setReady(slateKey);
  }, [slateKey]);
  useEffect(() => () => abort.current?.abort(), []);

  // College slates are long, so only games the scoreboard shows a line for, like the forward log.
  const pending = games.filter((g) => g.phase === 'pre' && !markets[g.id] && !noLine[g.id] && g.id !== openGame && (league === 'nba' || !!g.odds));
  const pendingIds = pending.map((g) => g.id).join();

  const start = useCallback(() => {
    const targets = pending;
    if (!targets.length) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    let done = 0, failed = 0;
    const running = new Set<string>();
    const report = () =>
      setScan({ status: 'running', done, total: targets.length, current: [...running].join(', ') || undefined, failed });
    report();
    mapLimit(targets, CONCURRENCY, async (t) => {
      if (ac.signal.aborted) return;
      const label = `${t.away.abbr} @ ${t.home.abbr}`;
      running.add(label);
      report();
      try {
        const gd = await loadGame(league, t.id, { sampleGames: SAMPLE_GAMES, signal: ac.signal });
        if (!gd.odds) setNoLine((n) => ({ ...n, [t.id]: true }));
        else if (gd.phase === 'pre') {
          const built = buildSpec(gd, { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
          const job = runOutcomesInBackground(built.spec, SLATE_SIMS, seed);
          const onAbort = () => job.cancel();
          ac.signal.addEventListener('abort', onAbort);
          const o = await job.promise.finally(() => ac.signal.removeEventListener('abort', onAbort));
          const m = marketFrom(gd, o);
          if (m && !ac.signal.aborted) {
            writeCache(cacheKey(league, m.gameId), packMarket(m, Date.now()));
            setMarkets((ms) => ({ ...ms, [m.gameId]: ms[m.gameId] ?? m }));
          }
        }
      } catch (e) {
        if (!(ac.signal.aborted || e instanceof CancelledError || (e as Error)?.name === 'AbortError')) failed++;
      } finally {
        running.delete(label);
        done++;
        if (!ac.signal.aborted) report();
      }
    }).then(() => {
      if (!ac.signal.aborted) setScan({ status: 'done', done: targets.length, total: targets.length, failed });
    });
  }, [pendingIds, league, seed]);

  // Effects in one render all see that render's markets, so wait for the render after the cache
  // read before deciding what's left to scan.
  const autoDone = useRef('');
  useEffect(() => {
    const day = `${league}|${date}`;
    if (!auto || ready !== slateKey || autoDone.current === day || !pending.length) return;
    autoDone.current = day;
    start();
  }, [auto, ready, slateKey, pendingIds]);

  const stop = useCallback(() => {
    abort.current?.abort();
    setScan((s) => ({ ...s, status: 'idle', current: undefined }));
  }, []);

  const put = useCallback((m: GameMarket) => setMarkets((ms) => ({ ...ms, [m.gameId]: m })), []);

  return { markets, pending, scan, start, stop, put };
}
