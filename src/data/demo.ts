// A fully synthetic sample matchup. Used when live data can't be reached (offline, embedded
// previews) and by the tests. Teams and players are fictional.
import { emptyZones, type BoxLine, type GameData, type PlayerProfile, type PosGroup, type TeamProfile } from '../model/types';

type Line = [name: string, pos: string, group: PosGroup, min: number, fga: number, fgPct: number, tpa: number, tpPct: number, fta: number, ftPct: number, oreb: number, dreb: number, ast: number, stl: number, blk: number, tov: number, pf: number];

const GAMES = 20;

function profile(teamId: string, idx: number, l: Line, starter: boolean): PlayerProfile {
  const [name, pos, group, min, fga0, fgPct, tpa0, tpPct, fta0, ftPct, oreb, dreb, ast, stl, blk, tov, pf] = l;
  // The hand-written lines run hot; scale volume to a league-average team (about 88 FGA, 22 FTA).
  const fga = fga0 * 0.9, tpa = tpa0 * 0.95, fta = fta0 * 0.78;
  const g = GAMES;
  const tpm = Math.round(tpa * tpPct * g);
  const fgm = Math.max(tpm, Math.round(fga * fgPct * g));
  const ftm = Math.round(fta * ftPct * g);
  const box: BoxLine = {
    min: min * g,
    fga: Math.round(fga * g),
    fgm,
    tpa: Math.round(tpa * g),
    tpm,
    fta: Math.round(fta * g),
    ftm,
    pts: 2 * (fgm - tpm) + 3 * tpm + ftm,
    oreb: Math.round(oreb * g),
    dreb: Math.round(dreb * g),
    ast: Math.round(ast * g),
    stl: Math.round(stl * g),
    blk: Math.round(blk * g),
    tov: Math.round(tov * g),
    pf: Math.round(pf * g),
  };
  const zones = emptyZones();
  const twos = box.fga - box.tpa;
  const twoMade = box.fgm - box.tpm;
  const split = group === 'C' ? [0.7, 0.2, 0.1] : group === 'F' ? [0.5, 0.22, 0.28] : [0.4, 0.22, 0.38];
  const rel = [1.45, 0.95, 0.9];
  const relNorm = split.reduce((a, s, i) => a + s * rel[i], 0);
  (['rim', 'paint', 'mid'] as const).forEach((z, i) => {
    zones[z].att = Math.round(twos * split[i]);
    zones[z].made = Math.round(zones[z].att * Math.min(0.9, (twoMade / Math.max(1, twos)) * (rel[i] / relNorm)));
  });
  const c3 = group === 'G' ? 0.18 : 0.32;
  zones.c3.att = Math.round(box.tpa * c3);
  zones.c3.made = Math.round(zones.c3.att * Math.min(0.6, tpPct + 0.03));
  zones.ab3.att = box.tpa - zones.c3.att;
  zones.ab3.made = Math.max(0, box.tpm - zones.c3.made);
  const [first, ...rest] = name.split(' ');
  return {
    id: `${teamId}-${idx}`,
    name,
    short: `${first[0]}. ${rest.join(' ')}`,
    jersey: String((idx * 7 + 3) % 45),
    pos,
    group,
    starter,
    sample: { games: g, starts: starter ? g : 0, box, zones, assistedMakes: Math.round(box.fgm * (group === 'G' ? 0.45 : 0.62)) },
    source: 'Synthetic sample data',
  };
}

const HOME: Line[] = [
  ['Marcus Hale', 'PG', 'G', 35, 21.0, 0.49, 8.0, 0.385, 8.0, 0.89, 0.6, 4.0, 7.8, 1.3, 0.3, 3.1, 2.2],
  ['Devon Price', 'SG', 'G', 32, 15.0, 0.455, 7.8, 0.385, 3.2, 0.83, 0.5, 3.0, 3.1, 1.1, 0.4, 1.6, 2.4],
  ['Isaiah Ward', 'SF', 'F', 31, 9.5, 0.46, 4.6, 0.35, 2.2, 0.76, 1.2, 4.6, 2.4, 1.2, 0.6, 1.3, 2.6],
  ['Andre Cole', 'PF', 'F', 29, 8.0, 0.5, 2.6, 0.33, 2.6, 0.72, 2.0, 5.8, 2.1, 0.8, 0.9, 1.4, 2.9],
  ['Tomas Brandt', 'C', 'C', 28, 9.0, 0.63, 0.4, 0.3, 4.0, 0.68, 3.4, 7.4, 1.9, 0.7, 1.9, 1.5, 3.1],
  ['Jalen Brooks', 'G', 'G', 24, 8.8, 0.42, 4.2, 0.34, 1.8, 0.79, 0.4, 2.2, 3.6, 0.9, 0.2, 1.5, 2.0],
  ['Rico Alvarez', 'F', 'F', 20, 6.5, 0.47, 3.6, 0.37, 1.3, 0.76, 0.9, 3.2, 1.1, 0.6, 0.4, 0.7, 2.1],
  ['Nate Okafor', 'C', 'C', 16, 4.5, 0.6, 0.1, 0.0, 1.8, 0.62, 1.9, 3.8, 0.8, 0.4, 1.2, 0.8, 2.4],
  ['Chris Vance', 'G', 'G', 13, 4.2, 0.41, 2.4, 0.34, 0.6, 0.8, 0.2, 1.2, 1.6, 0.5, 0.1, 0.7, 1.2],
  ['Leo Sato', 'F', 'F', 8, 2.6, 0.44, 1.4, 0.33, 0.5, 0.7, 0.4, 1.3, 0.4, 0.3, 0.2, 0.3, 0.9],
  ['Ben Mercer', 'G', 'G', 4, 1.5, 0.4, 0.8, 0.32, 0.3, 0.75, 0.1, 0.5, 0.5, 0.1, 0.0, 0.2, 0.4],
  ['Omar Diallo', 'C', 'C', 3, 0.9, 0.55, 0.0, 0, 0.4, 0.6, 0.4, 0.6, 0.1, 0.1, 0.2, 0.1, 0.5],
];

const AWAY: Line[] = [
  ['Caleb Rhodes', 'SF', 'F', 36, 21.0, 0.49, 6.0, 0.36, 8.2, 0.85, 1.1, 6.2, 4.6, 1.2, 0.7, 2.8, 2.3],
  ['Theo Lindqvist', 'C', 'C', 32, 13.5, 0.58, 3.2, 0.35, 5.0, 0.8, 2.9, 8.8, 4.8, 0.9, 1.4, 2.4, 3.0],
  ['Damon Greer', 'PG', 'G', 33, 14.0, 0.44, 6.4, 0.37, 3.6, 0.86, 0.4, 3.0, 6.9, 1.4, 0.2, 2.3, 2.1],
  ['Kofi Mensah', 'SG', 'G', 29, 11.0, 0.45, 6.8, 0.39, 2.0, 0.8, 0.5, 2.6, 2.2, 1.0, 0.3, 1.1, 2.3],
  ['Silas Hart', 'PF', 'F', 27, 7.6, 0.48, 3.4, 0.35, 1.8, 0.72, 1.8, 5.0, 1.6, 0.8, 0.8, 1.0, 2.7],
  ['Ezra Quinn', 'G', 'G', 23, 8.4, 0.42, 4.0, 0.35, 1.8, 0.84, 0.3, 2.0, 2.8, 0.8, 0.2, 1.3, 1.9],
  ['Victor Ruiz', 'F', 'F', 21, 7.0, 0.46, 3.4, 0.35, 1.6, 0.74, 1.1, 3.4, 1.3, 0.7, 0.5, 0.8, 2.2],
  ['Grant Holloway', 'C', 'C', 15, 4.2, 0.62, 0.0, 0, 1.6, 0.6, 1.8, 3.6, 0.7, 0.3, 1.1, 0.7, 2.5],
  ['Miles Turner Jr', 'G', 'G', 12, 4.6, 0.41, 2.6, 0.34, 0.9, 0.8, 0.2, 1.1, 1.4, 0.5, 0.1, 0.6, 1.1],
  ['Aaron Fitch', 'F', 'F', 7, 2.4, 0.43, 1.2, 0.33, 0.4, 0.7, 0.4, 1.1, 0.3, 0.2, 0.2, 0.3, 0.8],
  ['Paul Easton', 'G', 'G', 4, 1.4, 0.38, 0.8, 0.3, 0.2, 0.75, 0.1, 0.4, 0.4, 0.1, 0.0, 0.2, 0.4],
  ['Rashad Moore', 'C', 'C', 3, 1.0, 0.5, 0.0, 0, 0.4, 0.6, 0.4, 0.6, 0.1, 0.1, 0.2, 0.1, 0.5],
];

function team(id: string, abbr: string, name: string, shortName: string, color: string, altColor: string, lines: Line[], record: string): TeamProfile {
  const players = lines.map((l, i) => profile(id, i, l, i < 5));
  const pts = players.reduce((a, p) => a + (p.sample?.box.pts ?? 0), 0);
  return {
    id,
    abbr,
    name,
    shortName,
    color,
    altColor,
    record,
    players,
    sample: { games: GAMES, poss: 99 * GAMES, ptsFor: pts, ptsAgainst: pts * 0.985, oppTov: 0.13 * 99 * GAMES },
    source: 'Synthetic sample data',
  };
}

export function demoGame(): GameData {
  const home = team('demo-h', 'HCT', 'Harbor City Tides', 'Tides', '#0b6e75', '#f2b33d', HOME, '12-8');
  const away = team('demo-a', 'LSC', 'Lakeshore Comets', 'Comets', '#7a2d8f', '#e5e7eb', AWAY, '13-7');
  home.players[1].injury = { status: 'Out', detail: 'Ankle sprain', out: true };
  away.players[5].injury = { status: 'Questionable', detail: 'Hamstring tightness', out: false };
  return {
    league: 'nba',
    id: 'demo',
    date: new Date().toISOString(),
    name: 'Lakeshore Comets at Harbor City Tides',
    phase: 'pre',
    statusText: 'Sample matchup',
    period: 0,
    clockSec: 0,
    home,
    away,
    neutral: false,
    officials: ['Sample crew'],
    odds: { provider: 'a sample book', details: 'HCT -1.5', spread: -1.5, total: 226.5, homeML: -125, awayML: 105 },
    plays: [],
    espnWinProb: [],
    notes: ['Synthetic sample data. Teams, players and the betting line are fictional.'],
    demo: true,
  };
}
