// Domain model shared by the data layer, the simulator and the UI.

export type LeagueId = 'nba' | 'ncaam';
export type Zone = 'rim' | 'paint' | 'mid' | 'c3' | 'ab3';
export const ZONES: Zone[] = ['rim', 'paint', 'mid', 'c3', 'ab3'];
export const ZONE_LABEL: Record<Zone, string> = {
  rim: 'Restricted area',
  paint: 'Paint (non-RA)',
  mid: 'Mid-range',
  c3: 'Corner 3',
  ab3: 'Above-break 3',
};
export const isThree = (z: Zone | number) => z === 'c3' || z === 'ab3' || z === 3 || z === 4;
export type PosGroup = 'G' | 'F' | 'C';

/** Box-score totals over some sample (not averages). */
export interface BoxLine {
  min: number;
  pts: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  pf: number;
}

export const emptyBox = (): BoxLine => ({
  min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0,
});

export function addBox(a: BoxLine, b: BoxLine): BoxLine {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof BoxLine)[]) out[k] += b[k];
  return out;
}

export interface ZoneLine {
  att: number;
  made: number;
}
export type ZoneTable = Record<Zone, ZoneLine>;
export const emptyZones = (): ZoneTable => ({
  rim: { att: 0, made: 0 },
  paint: { att: 0, made: 0 },
  mid: { att: 0, made: 0 },
  c3: { att: 0, made: 0 },
  ab3: { att: 0, made: 0 },
});

/** Everything we know about a player's recent production, as totals. */
export interface PlayerSample {
  /** Games in the sample; recency-weighted samples count their effective size. */
  games: number;
  /** Games actually played, when `games` is weighted. */
  played?: number;
  starts: number;
  box: BoxLine;
  /** Shot locations from play-by-play (optional). */
  zones?: ZoneTable;
  /** Made field goals that were assisted (play-by-play). */
  assistedMakes?: number;
  /** Assists this player threw, keyed by the shooter's player id (play-by-play). */
  assistsTo?: Record<string, number>;
}

export interface Injury {
  status: string; // "Out", "Day-To-Day", "Questionable", ...
  detail?: string;
  /** True when the status means the player will not play. */
  out: boolean;
}

export interface PlayerProfile {
  id: string;
  name: string;
  short: string;
  jersey?: string;
  pos: string;
  group: PosGroup;
  headshot?: string;
  injury?: Injury;
  starter?: boolean;
  sample: PlayerSample | null;
  /** Human-readable provenance, e.g. "Last 10 games, play-by-play". */
  source: string;
  /** Box score in this game when it has started (actual result). */
  actual?: BoxLine & { played: boolean; starter: boolean };
}

export interface TeamSample {
  games: number;
  poss: number;
  ptsFor: number;
  ptsAgainst: number;
  oppTov: number;
  /** Opponent shot locations against this team. */
  oppZones?: ZoneTable;
}

export interface TeamProfile {
  id: string;
  abbr: string;
  name: string;
  shortName: string;
  color: string;
  altColor: string;
  logo?: string;
  record?: string;
  players: PlayerProfile[];
  sample: TeamSample | null;
  source: string;
  /** Days since the previous game; b2b is the second night of a back-to-back. */
  rest?: { days: number | null; b2b: boolean };
}

export type GamePhase = 'pre' | 'in' | 'post';

export interface Odds {
  provider: string;
  details?: string;
  /** Home spread (negative = home favored). */
  spread?: number;
  total?: number;
  homeML?: number;
  awayML?: number;
  /** Prices for each side of the spread and total (American). */
  homeSpreadOdds?: number;
  awaySpreadOdds?: number;
  overOdds?: number;
  underOdds?: number;
}

export interface Play {
  id: string;
  seq: number;
  period: number;
  clock: string;
  clockSec: number;
  text: string;
  homeScore: number;
  awayScore: number;
  teamId?: string;
  scoring: boolean;
  type?: string;
}

export interface GameSnapshot {
  period: number;
  clockSec: number;
  homeScore: number;
  awayScore: number;
  /** Personal fouls so far by player id. */
  fouls?: Record<string, number>;
  /** Seconds played so far by player id. */
  played?: Record<string, number>;
  /** Final [home, away] points of each completed period. */
  prior?: [number, number][];
  /** Score when the current period began. */
  periodStart?: [number, number];
}

export interface GameData {
  league: LeagueId;
  id: string;
  date: string; // ISO
  name: string;
  phase: GamePhase;
  statusText: string;
  period: number;
  clockSec: number;
  home: TeamProfile;
  away: TeamProfile;
  homeScore?: number;
  awayScore?: number;
  venue?: string;
  neutral: boolean;
  officials: string[];
  odds?: Odds;
  espnHomeWinPct?: number;
  plays: Play[];
  espnWinProb: { seq: number; homeWinPct: number }[];
  notes: string[];
  demo?: boolean;
}

export interface ScoreboardGame {
  id: string;
  date: string;
  phase: GamePhase;
  statusText: string;
  home: { id: string; abbr: string; name: string; logo?: string; color: string; score?: number; record?: string };
  away: { id: string; abbr: string; name: string; logo?: string; color: string; score?: number; record?: string };
  odds?: string;
  neutral: boolean;
}
