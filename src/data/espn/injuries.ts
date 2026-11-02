// ESPN's league-wide injury report: one request for every team's list (about 1 MB, 100-150 KB
// compressed), read fresh every time since its whole point is what changed.
import type { LeagueId } from '../../model/types';
import { getJson, sitePath } from './client';
import { parseInjuryFeed, type InjuryReport } from './parse';

export type { InjuryReport };

export async function loadInjuries(league: LeagueId, signal?: AbortSignal): Promise<InjuryReport[]> {
  return parseInjuryFeed(await getJson('site', sitePath(league, '/injuries'), { signal, noStore: true }));
}
