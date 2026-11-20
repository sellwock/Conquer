// ESPN's NFL feeds, as far as the NFL prop model needs them: box scores (passing, rushing and
// receiving per player), each player's game log, and team rosters (names, positions, injury
// status). Shapes checked against live responses on Nov 20, 2026.
import type { NflBoxStat } from '../../model/props';
import { getJson, sitePath, webPath } from './client';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

/** One player's offensive line in a game. */
export type NflLine = Record<NflBoxStat, number>;

export const emptyNflLine = (): NflLine => ({ passYds: 0, passComp: 0, passAtt: 0, rushYds: 0, rushAtt: 0, recYds: 0, rec: 0 });

export interface NflBoxPlayer {
  athleteId: string;
  teamId: string;
  name: string;
  line: NflLine;
}

const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Each player's passing, rushing and receiving in a game summary's box score (final or in progress). */
export function parseNflBox(summary: J): Map<string, NflBoxPlayer> {
  const out = new Map<string, NflBoxPlayer>();
  for (const team of summary?.boxscore?.players ?? []) {
    const teamId = String(team?.team?.id ?? '');
    for (const cat of team?.statistics ?? []) {
      const keys: string[] = cat?.keys ?? [];
      for (const a of cat?.athletes ?? []) {
        const id = String(a?.athlete?.id ?? '');
        if (!id) continue;
        const p = out.get(id) ?? { athleteId: id, teamId, name: String(a.athlete.displayName ?? id), line: emptyNflLine() };
        const v = (k: string) => (a?.stats ?? [])[keys.indexOf(k)];
        if (cat.name === 'passing') {
          const [comp, att] = String(v('completions/passingAttempts') ?? '').split('/');
          p.line.passComp = num(comp);
          p.line.passAtt = num(att);
          p.line.passYds = num(v('passingYards'));
        } else if (cat.name === 'rushing') {
          p.line.rushAtt = num(v('rushingAttempts'));
          p.line.rushYds = num(v('rushingYards'));
        } else if (cat.name === 'receiving') {
          p.line.rec = num(v('receptions'));
          p.line.recYds = num(v('receivingYards'));
        }
        out.set(id, p);
      }
    }
  }
  return out;
}

export interface NflGameLog {
  eventId: string;
  /** Kickoff (ISO). */
  date: string;
  /** The player's team that day, its points and the opponent's. */
  teamId: string;
  teamPts: number;
  oppPts: number;
  line: NflLine;
}

const LOG_NAMES: Record<string, NflBoxStat> = {
  completions: 'passComp',
  passingAttempts: 'passAtt',
  passingYards: 'passYds',
  rushingAttempts: 'rushAtt',
  rushingYards: 'rushYds',
  receptions: 'rec',
  receivingYards: 'recYds',
};

/** A player's games from his ESPN game log, newest first; preseason games are left out. */
export function parseNflGamelog(json: J): NflGameLog[] {
  const names: string[] = json?.names ?? [];
  const events = json?.events ?? {};
  const out: NflGameLog[] = [];
  for (const st of json?.seasonTypes ?? []) {
    if (/preseason/i.test(String(st?.displayName ?? ''))) continue;
    for (const cat of st?.categories ?? []) {
      for (const ev of cat?.events ?? []) {
        const e = events[ev?.eventId];
        if (!e?.gameDate) continue;
        const line = emptyNflLine();
        names.forEach((n, i) => {
          const k = LOG_NAMES[n];
          if (k) line[k] = num(ev.stats?.[i]);
        });
        const teamId = String(e.team?.id ?? '');
        const home = String(e.homeTeamId) === teamId;
        out.push({
          eventId: String(ev.eventId),
          date: new Date(e.gameDate).toISOString(),
          teamId,
          teamPts: num(home ? e.homeTeamScore : e.awayTeamScore),
          oppPts: num(home ? e.awayTeamScore : e.homeTeamScore),
          line,
        });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface NflRosterPlayer {
  athleteId: string;
  name: string;
  short: string;
  position: string;
  /** The latest injury report status ("Questionable", "Out", ...), if any. */
  injury?: string;
  /** On injured reserve, suspended or otherwise not available this week. */
  out: boolean;
}

/** A team's roster: names, positions and injury status. */
export function parseNflRoster(json: J): NflRosterPlayer[] {
  const out: NflRosterPlayer[] = [];
  for (const group of json?.athletes ?? []) {
    const unavailable = /injuredReserve|suspended|practiceSquad/i.test(String(group?.position ?? ''));
    for (const a of group?.items ?? []) {
      const injury: string | undefined = a?.injuries?.[0]?.status;
      out.push({
        athleteId: String(a.id),
        name: String(a.displayName ?? a.fullName ?? a.id),
        short: String(a.shortName ?? a.displayName ?? a.id),
        position: String(a.position?.abbreviation ?? ''),
        ...(injury ? { injury } : {}),
        out: unavailable || /^out$/i.test(injury ?? ''),
      });
    }
  }
  return out;
}

/** A player's games this season and last, newest first. */
export async function loadNflGamelog(athleteId: string, season: number, signal?: AbortSignal): Promise<NflGameLog[]> {
  const [now, before] = await Promise.all(
    [season, season - 1].map((s) => getJson('web', webPath('nfl', `/athletes/${athleteId}/gamelog?season=${s}`), { signal }).catch(() => undefined)),
  );
  const seen = new Set<string>();
  return [...parseNflGamelog(now), ...parseNflGamelog(before)].filter((g) => !seen.has(g.eventId) && !!seen.add(g.eventId));
}

export async function loadNflRoster(teamId: string, signal?: AbortSignal): Promise<NflRosterPlayer[]> {
  return parseNflRoster(await getJson('site', sitePath('nfl', `/teams/${teamId}/roster`), { signal }));
}
