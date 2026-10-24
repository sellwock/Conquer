// Parsers for ESPN's site API JSON. Every accessor is defensive: ESPN's payloads differ between
// leagues, game states and seasons, and stat columns are matched by key/label, never by position.
import {
  emptyBox,
  emptyZones,
  type BoxLine,
  type GamePhase,
  type Injury,
  type LeagueId,
  type Odds,
  type Play,
  type PosGroup,
  type ScoreboardGame,
  type Zone,
  type ZoneTable,
} from '../../model/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export const num = (v: unknown, d = 0): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : d;
  if (typeof v === 'string') {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : d;
  }
  if (v && typeof v === 'object' && 'value' in (v as J)) return num((v as J).value, d);
  return d;
};

export function clockToSec(display: unknown): number {
  if (typeof display === 'number') return display;
  const s = String(display ?? '').trim();
  if (!s) return 0;
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    return num(m) * 60 + num(sec);
  }
  return num(s);
}

export function posGroup(pos: string | undefined): PosGroup {
  const p = (pos ?? '').toUpperCase();
  if (p.startsWith('C')) return 'C';
  if (p.startsWith('F') || p === 'SF' || p === 'PF') return 'F';
  if (p.startsWith('G') || p === 'PG' || p === 'SG') return 'G';
  return 'F';
}

export function phaseOf(state: unknown): GamePhase {
  return state === 'in' ? 'in' : state === 'post' ? 'post' : 'pre';
}

const teamColor = (c: unknown, fallback: string) => (typeof c === 'string' && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : fallback);
const logoOf = (team: J): string | undefined => team?.logo ?? team?.logos?.[0]?.href;
const recordOf = (comp: J): string | undefined => {
  const r = comp?.records ?? comp?.record;
  if (!Array.isArray(r)) return undefined;
  const total = r.find((x: J) => x?.type === 'total' || x?.name === 'overall') ?? r[0];
  return total?.summary ?? total?.displayValue;
};

// --- Scoreboard ---------------------------------------------------------------------------------

export function parseScoreboard(json: J): ScoreboardGame[] {
  const events: J[] = Array.isArray(json?.events) ? json.events : [];
  return events.map((ev) => {
    const comp = ev?.competitions?.[0] ?? {};
    const cs: J[] = comp.competitors ?? [];
    const side = (ha: string) => {
      const c = cs.find((x) => x?.homeAway === ha) ?? {};
      return {
        id: String(c?.team?.id ?? c?.id ?? ''),
        abbr: c?.team?.abbreviation ?? '?',
        name: c?.team?.shortDisplayName ?? c?.team?.displayName ?? c?.team?.name ?? '?',
        logo: logoOf(c?.team),
        color: teamColor(c?.team?.color, '#555'),
        score: c?.score != null && c?.score !== '' ? num(c.score) : undefined,
        record: recordOf(c),
      };
    };
    const status = comp?.status ?? ev?.status ?? {};
    return {
      id: String(ev?.id ?? comp?.id),
      date: ev?.date ?? comp?.date ?? '',
      phase: phaseOf(status?.type?.state),
      statusText: status?.type?.shortDetail ?? status?.type?.detail ?? '',
      home: side('home'),
      away: side('away'),
      odds: comp?.odds?.[0]?.details,
      neutral: !!comp?.neutralSite,
    };
  });
}

// --- Box score ----------------------------------------------------------------------------------

const KEY_ALIASES: Record<string, keyof BoxLine | 'fg' | '3pt' | 'ft' | 'reb' | null> = {
  min: 'min', minutes: 'min',
  pts: 'pts', points: 'pts',
  fg: 'fg', 'fieldgoalsmade-fieldgoalsattempted': 'fg',
  '3pt': '3pt', 'threepointfieldgoalsmade-threepointfieldgoalsattempted': '3pt',
  ft: 'ft', 'freethrowsmade-freethrowsattempted': 'ft',
  oreb: 'oreb', offensiverebounds: 'oreb',
  dreb: 'dreb', defensiverebounds: 'dreb',
  reb: 'reb', rebounds: 'reb',
  ast: 'ast', assists: 'ast',
  stl: 'stl', steals: 'stl',
  blk: 'blk', blocks: 'blk',
  to: 'tov', turnovers: 'tov',
  pf: 'pf', fouls: 'pf',
};

export function columnKeys(stat: J): string[] {
  const keys: unknown[] = stat?.keys ?? stat?.names ?? stat?.labels ?? [];
  return keys.map((k) => String(k).toLowerCase());
}

/** Parses one athlete's `stats` array given the column keys. Returns null for DNPs. */
export function parseStatLine(keys: string[], stats: unknown[]): BoxLine | null {
  if (!Array.isArray(stats) || stats.length === 0) return null;
  const b = emptyBox();
  let reb = -1;
  keys.forEach((k, i) => {
    const field = KEY_ALIASES[k];
    const v = stats[i];
    if (!field) return;
    if (field === 'fg' || field === '3pt' || field === 'ft') {
      const [m, a] = String(v ?? '0-0').split('-').map((x) => num(x));
      if (field === 'fg') (b.fgm = m), (b.fga = a);
      if (field === '3pt') (b.tpm = m), (b.tpa = a);
      if (field === 'ft') (b.ftm = m), (b.fta = a);
    } else if (field === 'reb') reb = num(v);
    else if (field === 'min') b.min = String(v).includes(':') ? clockToSec(v) / 60 : num(v);
    else b[field] = num(v);
  });
  if (reb >= 0 && b.oreb + b.dreb === 0 && reb > 0) b.dreb = reb;
  if (!b.pts && (b.fgm || b.ftm)) b.pts = 2 * (b.fgm - b.tpm) + 3 * b.tpm + b.ftm;
  return b;
}

export interface BoxAthlete {
  id: string;
  name: string;
  short: string;
  jersey?: string;
  pos: string;
  headshot?: string;
  starter: boolean;
  played: boolean;
  reason?: string;
  box: BoxLine;
}

export function parseBoxPlayers(summary: J): Record<string, BoxAthlete[]> {
  const out: Record<string, BoxAthlete[]> = {};
  const teams: J[] = summary?.boxscore?.players ?? [];
  for (const t of teams) {
    const teamId = String(t?.team?.id ?? '');
    const stat = t?.statistics?.[0];
    if (!teamId || !stat) continue;
    const keys = columnKeys(stat);
    out[teamId] = (stat.athletes ?? []).map((a: J) => {
      const line = parseStatLine(keys, a?.stats);
      const ath = a?.athlete ?? {};
      return {
        id: String(ath.id ?? ''),
        name: ath.displayName ?? ath.fullName ?? 'Unknown',
        short: ath.shortName ?? ath.displayName ?? 'Unknown',
        jersey: ath.jersey,
        pos: ath.position?.abbreviation ?? '',
        headshot: ath.headshot?.href,
        starter: !!a?.starter,
        played: !!line && !a?.didNotPlay && (line.min > 0 || line.fga + line.fta + line.pf > 0),
        reason: a?.reason,
        box: line ?? emptyBox(),
      } satisfies BoxAthlete;
    });
  }
  return out;
}

// --- Play-by-play shot extraction ---------------------------------------------------------------

export function normName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedShot {
  shooter: string;
  made: boolean;
  zone: Zone;
  assister?: string;
}

const RIM_WORDS = /layup|lay-up|dunk|tip|alley|putback|put-back|finger roll|reverse/i;
const PAINT_WORDS = /hook|floater|floating|runner|turnaround bank|driving bank/i;

export function classifyZone(three: boolean, dist: number | undefined, desc: string, coord?: { x: number; y: number }): Zone {
  if (three) {
    if (coord && coord.x >= 0 && coord.x <= 50 && coord.y >= 0 && coord.y <= 50) {
      return coord.y <= 14 && Math.abs(coord.x - 25) >= 20 ? 'c3' : 'ab3';
    }
    return dist != null && dist <= 23 ? 'c3' : 'ab3';
  }
  if (dist != null) return dist <= 4 ? 'rim' : dist <= 14 ? 'paint' : 'mid';
  if (RIM_WORDS.test(desc)) return 'rim';
  if (PAINT_WORDS.test(desc)) return 'paint';
  return 'mid';
}

/**
 * Parses a shot from play text. Handles both ESPN styles:
 *   NBA:   "Jayson Tatum makes 26-foot three point jumper (Jrue Holiday assists)"
 *          "Brook Lopez blocks Jayson Tatum 's 3-foot driving layup"
 *   NCAAM: "Hunter Dickinson made Layup. Assisted by Johnny Furphy."
 */
export function parseShotText(text: string, play?: J): ParsedShot | null {
  if (!text || /free throw/i.test(text)) return null;
  let shooter: string, made: boolean, desc: string, assister: string | undefined;
  let m = text.match(/^(.+?) (makes|misses) (.+?)(?:\s*\((.+?) assists?\))?\s*$/);
  if (m) {
    shooter = m[1];
    made = m[2] === 'makes';
    desc = m[3];
    assister = m[4];
  } else if ((m = text.match(/^(.+?) blocks (.+?)\s?'s (.+)$/))) {
    shooter = m[2];
    made = false;
    desc = m[3];
  } else if ((m = text.match(/^(.+?) (made|missed) (.+?)\.(?:\s*Assisted by (.+?)\.)?\s*$/))) {
    shooter = m[1];
    made = m[2] === 'made';
    desc = m[3];
    assister = m[4];
  } else return null;
  if (!/shot|jumper|layup|lay-up|dunk|tip|hook|floater|three|pointer|alley|putback|fadeaway|bank|runner|roll/i.test(desc)) return null;
  const three = /three|3-pt|3pt/i.test(desc) || num(play?.pointsAttempted) === 3 || (made && num(play?.scoreValue) === 3);
  const dm = desc.match(/(\d+)-(?:foot|ft)/i);
  const coord = play?.coordinate && num(play.coordinate.x, -1) > -100 ? { x: num(play.coordinate.x, -1), y: num(play.coordinate.y, -1) } : undefined;
  return { shooter: shooter.trim(), made, zone: classifyZone(three, dm ? num(dm[1]) : undefined, desc, coord), assister: assister?.trim() };
}

export interface GameExtract {
  v: 1;
  eventId: string;
  date: string;
  teams: Record<
    string,
    {
      players: Record<string, { box: BoxLine; starter: boolean; zones?: ZoneTable; assistedMakes?: number; assistsTo?: Record<string, number> }>;
      poss: number;
      ptsFor: number;
      ptsAgainst: number;
      oppTov: number;
      oppZones?: ZoneTable;
    }
  >;
}

/** Condenses a completed game's summary into what player and team samples need. */
export function extractGame(summary: J, eventId: string): GameExtract | null {
  const box = parseBoxPlayers(summary);
  const teamIds = Object.keys(box);
  if (teamIds.length !== 2) return null;
  const nameToId = new Map<string, string>();
  const idToTeam = new Map<string, string>();
  for (const tid of teamIds) {
    for (const a of box[tid]) {
      nameToId.set(normName(a.name), a.id);
      idToTeam.set(a.id, tid);
    }
  }
  const out: GameExtract = { v: 1, eventId, date: summary?.header?.competitions?.[0]?.date ?? '', teams: {} };
  const totals: Record<string, BoxLine> = {};
  for (const tid of teamIds) {
    const players: GameExtract['teams'][string]['players'] = {};
    const sum = emptyBox();
    for (const a of box[tid]) {
      if (!a.played) continue;
      players[a.id] = { box: a.box, starter: a.starter };
      for (const k of Object.keys(sum) as (keyof BoxLine)[]) sum[k] += a.box[k];
    }
    totals[tid] = sum;
    out.teams[tid] = { players, poss: 0, ptsFor: sum.pts, ptsAgainst: 0, oppTov: 0 };
  }
  const [t0, t1] = teamIds;
  const possOf = (b: BoxLine) => b.fga - b.oreb + b.tov + 0.44 * b.fta;
  const poss = (possOf(totals[t0]) + possOf(totals[t1])) / 2;
  for (const [a, b] of [[t0, t1], [t1, t0]]) {
    out.teams[a].poss = poss;
    out.teams[a].ptsAgainst = totals[b].pts;
    out.teams[a].oppTov = totals[b].tov;
  }

  const plays: J[] = Array.isArray(summary?.plays) ? summary.plays : [];
  let parsedShots = 0;
  for (const p of plays) {
    const shot = parseShotText(String(p?.text ?? ''), p);
    if (!shot) continue;
    const sid = nameToId.get(normName(shot.shooter));
    if (!sid) continue;
    const tid = idToTeam.get(sid)!;
    const pl = out.teams[tid].players[sid];
    if (!pl) continue;
    parsedShots++;
    pl.zones ??= emptyZones();
    pl.zones[shot.zone].att++;
    if (shot.made) {
      pl.zones[shot.zone].made++;
      pl.assistedMakes ??= 0;
      if (shot.assister) {
        const aid = nameToId.get(normName(shot.assister));
        pl.assistedMakes++;
        if (aid && out.teams[tid].players[aid]) {
          const ap = out.teams[tid].players[aid];
          ap.assistsTo ??= {};
          ap.assistsTo[sid] = (ap.assistsTo[sid] ?? 0) + 1;
        }
      }
    }
    const opp = tid === t0 ? t1 : t0;
    out.teams[opp].oppZones ??= emptyZones();
    out.teams[opp].oppZones![shot.zone].att++;
    if (shot.made) out.teams[opp].oppZones![shot.zone].made++;
  }
  // If the text format wasn't recognized, drop partial zone data rather than trust it.
  const fgaTotal = totals[t0].fga + totals[t1].fga;
  if (parsedShots < fgaTotal * 0.6) {
    for (const tid of teamIds) {
      delete out.teams[tid].oppZones;
      for (const pl of Object.values(out.teams[tid].players)) {
        delete pl.zones;
        delete pl.assistedMakes;
        delete pl.assistsTo;
      }
    }
  }
  return out;
}

// --- Summary pieces -----------------------------------------------------------------------------

export function parsePlays(summary: J): Play[] {
  const plays: J[] = Array.isArray(summary?.plays) ? summary.plays : [];
  return plays.map((p, i) => ({
    id: String(p?.id ?? i),
    seq: num(p?.sequenceNumber, i),
    period: num(p?.period?.number, 1),
    clock: String(p?.clock?.displayValue ?? ''),
    clockSec: clockToSec(p?.clock?.displayValue),
    text: String(p?.text ?? ''),
    homeScore: num(p?.homeScore),
    awayScore: num(p?.awayScore),
    teamId: p?.team?.id != null ? String(p.team.id) : undefined,
    scoring: !!p?.scoringPlay,
    type: p?.type?.text,
  }));
}

const OUT_STATUSES = /^(out|o|suspended|suspension|inactive|injured reserve|ir)$/i;

export function injuryFrom(status: unknown, detail?: unknown): Injury | undefined {
  const s = String(status ?? '').trim();
  if (!s || /^active$/i.test(s)) return undefined;
  return { status: s, detail: typeof detail === 'string' ? detail : undefined, out: OUT_STATUSES.test(s) };
}

export function parseInjuries(summary: J): Record<string, Injury> {
  const out: Record<string, Injury> = {};
  const groups: J[] = Array.isArray(summary?.injuries) ? summary.injuries : [];
  for (const g of groups) {
    for (const inj of g?.injuries ?? []) {
      const id = inj?.athlete?.id;
      if (!id) continue;
      const detail = [inj?.details?.type, inj?.details?.detail, inj?.details?.side].filter(Boolean).join(' ') || inj?.shortComment || inj?.type?.description;
      const v = injuryFrom(inj?.status ?? inj?.type?.description, detail);
      if (v) out[String(id)] = v;
    }
  }
  return out;
}

export function parseOdds(summary: J, homeId: string): Odds | undefined {
  const pc: J[] = Array.isArray(summary?.pickcenter) ? summary.pickcenter : Array.isArray(summary?.odds) ? summary.odds : [];
  const o = pc.find((x) => x?.spread != null || x?.overUnder != null) ?? pc[0];
  if (!o) return undefined;
  let spread: number | undefined = o.spread != null ? num(o.spread) : undefined;
  // ESPN's `spread` is from the home team's perspective in recent payloads; verify with `details`.
  const details: string | undefined = o.details;
  const comps: J[] = summary?.header?.competitions?.[0]?.competitors ?? [];
  const homeAbbr = comps.find((c) => String(c?.team?.id) === homeId)?.team?.abbreviation;
  const awayAbbr = comps.find((c) => String(c?.team?.id) !== homeId)?.team?.abbreviation;
  if (details && spread != null) {
    const m = details.match(/^([A-Z.&]+)\s+([-+]?\d+(?:\.\d+)?)/);
    if (m && m[1] === homeAbbr) spread = num(m[2]);
    else if (m && m[1] === awayAbbr) spread = -num(m[2]);
  }
  const price = (v: unknown) => {
    const x = num(v, NaN);
    return Number.isFinite(x) && Math.abs(x) >= 100 ? x : undefined;
  };
  return {
    provider: o?.provider?.name ?? 'Sportsbook',
    details,
    spread,
    total: o?.overUnder != null ? num(o.overUnder) : undefined,
    homeML: price(o?.homeTeamOdds?.moneyLine),
    awayML: price(o?.awayTeamOdds?.moneyLine),
    homeSpreadOdds: price(o?.homeTeamOdds?.spreadOdds),
    awaySpreadOdds: price(o?.awayTeamOdds?.spreadOdds),
    overOdds: price(o?.overOdds),
    underOdds: price(o?.underOdds),
  };
}

export function parseOfficials(summary: J): string[] {
  const offs: J[] = summary?.gameInfo?.officials ?? [];
  return offs.map((o) => o?.displayName ?? o?.fullName).filter(Boolean);
}

export function parseWinProb(summary: J, plays: Play[]): { seq: number; homeWinPct: number }[] {
  const wp: J[] = Array.isArray(summary?.winprobability) ? summary.winprobability : [];
  const seqById = new Map(plays.map((p) => [p.id, p.seq]));
  return wp
    .map((w, i) => ({ seq: seqById.get(String(w?.playId)) ?? i, homeWinPct: num(w?.homeWinPercentage, NaN) }))
    .filter((w) => Number.isFinite(w.homeWinPct));
}

export function parsePredictor(summary: J): number | undefined {
  const v = summary?.predictor?.homeTeam?.gameProjection ?? summary?.predictor?.homeTeam?.teamChanceLoss;
  if (v == null) return undefined;
  const x = num(v, NaN);
  return Number.isFinite(x) ? x / 100 : undefined;
}

export interface RosterAthlete {
  id: string;
  name: string;
  short: string;
  jersey?: string;
  pos: string;
  headshot?: string;
  injury?: Injury;
}

export function parseRoster(json: J): RosterAthlete[] {
  let list: J[] = Array.isArray(json?.athletes) ? json.athletes : [];
  // Some sports group athletes by position: [{ position, items: [...] }].
  if (list.length && Array.isArray(list[0]?.items)) list = list.flatMap((g: J) => g.items ?? []);
  return list.map((a) => {
    const inj = Array.isArray(a?.injuries) && a.injuries.length ? a.injuries[0] : undefined;
    return {
      id: String(a?.id ?? ''),
      name: a?.displayName ?? a?.fullName ?? 'Unknown',
      short: a?.shortName ?? a?.displayName ?? 'Unknown',
      jersey: a?.jersey,
      pos: a?.position?.abbreviation ?? '',
      headshot: a?.headshot?.href,
      injury: inj ? injuryFrom(inj?.status ?? inj?.type?.description, inj?.details?.type ?? inj?.longComment) : undefined,
    };
  });
}

export function parseScheduleEvents(json: J): { id: string; date: string; completed: boolean }[] {
  const evs: J[] = Array.isArray(json?.events) ? json.events : [];
  return evs.map((e) => {
    const comp = e?.competitions?.[0] ?? {};
    const st = comp?.status?.type ?? e?.status?.type ?? {};
    return { id: String(e?.id ?? comp?.id), date: e?.date ?? comp?.date ?? '', completed: !!st.completed || st.state === 'post' };
  });
}

/** Season year as ESPN labels it (the year the season ends). */
export function seasonYear(dateIso: string, league: LeagueId): number {
  const d = new Date(dateIso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  void league;
  return m >= 8 ? y + 1 : y;
}
