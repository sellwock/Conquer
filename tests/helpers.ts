import { emptyBox, type GameData, type PlayerProfile, type PosGroup, type TeamProfile } from '../src/model/types';

/** A team whose every player produces exactly league-average NBA per-minute rates. */
export function leagueAverageTeam(id: string): TeamProfile {
  const mins = [36, 34, 32, 30, 28, 24, 22, 18, 10, 6];
  const groups: PosGroup[] = ['G', 'G', 'F', 'F', 'C', 'G', 'F', 'C', 'G', 'F'];
  const games = 40;
  const per240 = { fga: 88, fgm: 41.4, tpa: 37, tpm: 13.3, fta: 22, ftm: 17.2, oreb: 11, dreb: 33, ast: 26, stl: 8, blk: 5, tov: 14, pf: 19 };
  const players: PlayerProfile[] = mins.map((m, i) => {
    const k = (m * games) / 240;
    const box = emptyBox();
    box.min = m * games;
    for (const [key, v] of Object.entries(per240)) (box as unknown as Record<string, number>)[key] = v * k;
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

export function leagueAverageGame(): GameData {
  return {
    league: 'nba',
    id: 'test',
    date: '2026-10-20T23:00:00Z',
    name: 'Test',
    phase: 'pre',
    statusText: '',
    period: 0,
    clockSec: 0,
    home: leagueAverageTeam('h'),
    away: leagueAverageTeam('a'),
    neutral: false,
    officials: [],
    plays: [],
    espnWinProb: [],
    notes: [],
  };
}
