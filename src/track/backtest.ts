// Re-runs the model on finished games as they looked before tip-off ("known availability":
// who dressed comes from the box score, everything else stops at tip). Results are cached per
// model version, so re-running a range only simulates new games.
import type { LeagueId, ScoreboardGame } from '../model/types';
import { MODEL_VERSION } from '../model/version';
import { mapLimit, readCache, writeCache } from '../data/espn/client';
import { loadScoreboard } from '../data/espn/load';
import { runOutcomesInBackground } from '../sim/client';
import { daysBefore } from './dates';
import { rebuildGame } from './rebuild';
import type { Entry } from './types';

export interface BacktestProgress {
  done: number;
  total: number;
  label?: string;
}

export interface BacktestOptions {
  league: LeagueId;
  days: number;
  end?: Date;
  sims?: number;
  signal?: AbortSignal;
  onProgress?: (p: BacktestProgress) => void;
}

export const backtestKey = (league: LeagueId, id: string) => `bt.${MODEL_VERSION}.${league}.${id}`;

export async function runBacktest(o: BacktestOptions): Promise<{ entries: Entry[]; failed: number }> {
  const dates = daysBefore(o.end ?? new Date(), o.days);
  const found = new Map<string, ScoreboardGame>();
  for (const ymd of dates) {
    o.onProgress?.({ done: 0, total: 0, label: `Finding games on ${ymd.slice(4, 6)}/${ymd.slice(6)}` });
    const board = await loadScoreboard(o.league, ymd, o.signal);
    // College backtests stick to games with a line, like the forward log.
    for (const g of board) if (g.phase === 'post' && (o.league === 'nba' || !!g.odds)) found.set(g.id, g);
  }
  const games = [...found.values()];
  let done = 0, failed = 0;
  const entries: Entry[] = [];
  await mapLimit(games, 2, async (g) => {
    if (o.signal?.aborted) return;
    const cached = readCache<Entry>(backtestKey(o.league, g.id));
    if (cached) entries.push(cached);
    else {
      try {
        const e = await rebuildGame(o.league, g, o.sims ?? 2000, (spec, n, seed) => runOutcomesInBackground(spec, n, seed).promise, o.signal);
        if (e) {
          writeCache(backtestKey(o.league, g.id), e);
          entries.push(e);
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        failed++;
      }
    }
    o.onProgress?.({ done: ++done, total: games.length, label: `${g.away.abbr} @ ${g.home.abbr}` });
  });
  entries.sort((a, b) => Date.parse(b.tip) - Date.parse(a.tip));
  return { entries, failed };
}
