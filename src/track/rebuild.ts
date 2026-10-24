// Rebuilds one finished game as it looked at tip-off and simulates it. Season stats stop at tip;
// who dressed comes from the box score ("known availability"). Node-safe: the caller supplies the
// simulator (a worker in the browser, a direct call in scripts).
import { LEAGUES } from '../model/leagues';
import { buildSpec } from '../model/build';
import type { LeagueId, ScoreboardGame } from '../model/types';
import { loadGame, pregameView } from '../data/espn/load';
import { seasonYear } from '../data/espn/parse';
import type { Outcomes } from '../sim/quick';
import type { SimSpec } from '../sim/types';
import { predictionFromOutcomes } from './predict';
import type { Entry } from './types';

export type Simulate = (spec: SimSpec, n: number, seed: string) => Promise<Outcomes> | Outcomes;

export async function rebuildGame(league: LeagueId, game: Pick<ScoreboardGame, 'id' | 'date'>, sims: number, simulate: Simulate, signal?: AbortSignal): Promise<Entry | null> {
  const id = game.id;
  const g = await loadGame(league, id, { sampleGames: 10, signal, asOf: game.date });
  if (g.homeScore == null || g.awayScore == null) return null;
  const built = buildSpec(pregameView(g), { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
  const outcomes = await simulate(built.spec, sims, id);
  return {
    id,
    league,
    season: seasonYear(g.date, league),
    tip: g.date,
    home: { id: g.home.id, abbr: g.home.abbr },
    away: { id: g.away.id, abbr: g.away.abbr },
    neutral: g.neutral,
    status: 'final',
    pred: predictionFromOutcomes(outcomes, built, g.date, g.date),
    line: g.odds ? { ...g.odds, fetchedAt: '' } : undefined,
    result: { home: g.homeScore, away: g.awayScore, ot: g.period > LEAGUES[league].periods, gradedAt: '' },
  };
}
