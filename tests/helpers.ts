import { emptyBox, type GameData, type PlayerProfile, type PosGroup, type TeamProfile } from '../src/model/types';

const NBA_PER_TEAM = { fga: 88, fgm: 41.4, tpa: 37, tpm: 13.3, fta: 22, ftm: 17.2, oreb: 11, dreb: 33, ast: 26, stl: 8, blk: 5, tov: 14, pf: 19 };
const NCAAM_PER_TEAM = { fga: 58, fgm: 25.5, tpa: 23, tpm: 7.9, fta: 19, ftm: 13.6, oreb: 9.5, dreb: 24.5, ast: 13, stl: 6.5, blk: 3.3, tov: 11.5, pf: 17 };

/** A team whose every player produces exactly league-average per-minute rates. */
export function leagueAverageTeam(id: string, league: 'nba' | 'ncaam' = 'nba'): TeamProfile {
  const nba = league === 'nba';
  const mins = nba ? [36, 34, 32, 30, 28, 24, 22, 18, 10, 6] : [34, 32, 30, 28, 26, 18, 14, 10, 6, 2];
  const groups: PosGroup[] = ['G', 'G', 'F', 'F', 'C', 'G', 'F', 'C', 'G', 'F'];
  const games = 40;
  const teamMinutes = nba ? 240 : 200;
  const perTeam = nba ? NBA_PER_TEAM : NCAAM_PER_TEAM;
  const players: PlayerProfile[] = mins.map((m, i) => {
    const k = (m * games) / teamMinutes;
    const box = emptyBox();
    box.min = m * games;
    for (const [key, v] of Object.entries(perTeam)) (box as unknown as Record<string, number>)[key] = v * k;
    box.pts = 2 * (box.fgm - box.tpm) + 3 * box.tpm + box.ftm;
    return {
      id: `${id}-${i}`,
      name: `Player ${id}${i}`,
      short: `P. ${id}${i}`,
      pos: groups[i],
      group: groups[i],
      starter: i < 5,
      sample: { games, starts: i < 5 ? games : 0, box },
      source: 'test',
    };
  });
  return { id, abbr: id.toUpperCase(), name: `Team ${id}`, shortName: id, color: '#123456', altColor: '#abcdef', players, sample: null, source: 'test' };
}

export function leagueAverageGame(league: 'nba' | 'ncaam' = 'nba'): GameData {
  return {
    league,
    id: 'test',
    date: '2026-10-20T23:00:00Z',
    name: 'Test',
    phase: 'pre',
    statusText: '',
    period: 0,
    clockSec: 0,
    home: leagueAverageTeam('h', league),
    away: leagueAverageTeam('a', league),
    neutral: false,
    officials: [],
    plays: [],
    espnWinProb: [],
    notes: [],
  };
}
