// Prices one game in progress from its in-game book: the live prop lines and game lines, and a
// simulation from the current score, clock and box score. Shared by the live parlays on the site
// and the forward log's live prop snapshots.
import { buildSpec } from './build';
import type { GameData, LeagueId } from './types';
import type { GameMarket } from './parlays';
import { propMarkets, rosterNames, soFarOf } from './props';
import { loadGame, refreshGame, snapshotFromGame } from '../data/espn/load';
import { loadProps } from '../data/espn/props';
import type { Outcomes } from '../sim/quick';
import type { SimSpec } from '../sim/types';

export const LIVE_SIMS = 2000;
const SAMPLE_GAMES = 10;

export type Simulate = (spec: SimSpec, n: number, seed: string, opts: { players: boolean }) => Promise<Outcomes> | Outcomes;

/**
 * One live game: the latest state (loaded once, then refreshed with a single uncached summary
 * request) and, while it's in progress with live lines or props posted, its market. The
 * simulation starts from the current score, so its margins and totals are full-game finals, which
 * is what live spreads and totals are written against.
 */
export async function priceLiveGame(
  league: LeagueId,
  id: string,
  prev: GameData | undefined,
  seed: string,
  simulate: Simulate,
  signal?: AbortSignal,
  sims = LIVE_SIMS,
): Promise<{ game: GameData; market?: GameMarket }> {
  const game = await refreshGame(prev ?? (await loadGame(league, id, { sampleGames: SAMPLE_GAMES, signal })), signal);
  const start = snapshotFromGame(game);
  if (game.phase !== 'in' || !start) return { game };
  const board = await loadProps(league, id, signal, true, { home: game.home.abbr, away: game.away.abbr });
  const lines = !!board.odds && (board.odds.homeML != null || board.odds.spread != null || board.odds.total != null);
  if (!board.lines.length && !lines) return { game };
  const built = buildSpec(game, { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected', start });
  const o = await simulate(built.spec, sims, seed, { players: true });
  if (!o.players) return { game };
  const props = propMarkets(board.lines, o.players, rosterNames(game), soFarOf(game));
  if (!props.length && !lines) return { game };
  return {
    game,
    market: {
      gameId: game.id,
      league,
      label: `${game.away.abbr} @ ${game.home.abbr}`,
      home: game.home.abbr,
      away: game.away.abbr,
      odds: board.odds ?? { provider: board.provider ?? '' },
      margin: o.margin,
      total: o.total,
      props,
      propsAt: board.fetchedAt,
      propsProvider: board.provider,
    },
  };
}
