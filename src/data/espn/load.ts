// Assembles everything the simulator needs for one game from ESPN: header, rosters, injuries,
// odds, officials, and per-player samples built from each team's recent completed games.
import { addBox, emptyBox, emptyZones, ZONES, type BoxLine, type GameData, type GameSnapshot, type LeagueId, type Play, type PlayerProfile, type PlayerSample, type ScoreboardGame, type TeamProfile, type TeamSample, type ZoneTable } from '../../model/types';
import { DataError, getJson, mapLimit, readCache, sitePath, webPath, writeCache } from './client';
import {
  clockToSec,
  extractGame,
  num,
  parseBoxPlayers,
  parseStatLine,
  parseInjuries,
  parseOdds,
  parseOfficials,
  parsePlays,
  parsePredictor,
  parseRoster,
  parseScheduleEvents,
  parseScoreboard,
  parseWinProb,
  phaseOf,
  posGroup,
  seasonYear,
  type GameExtract,
  type RosterAthlete,
} from './parse';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export interface LoadOptions {
  sampleGames: number;
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
  /**
   * Rebuild the game as it looked before this instant (ISO), for backtests: season stats stop at
   * this date, today's roster and injury report are ignored, and starters come from the sample.
   * Who dressed still comes from the box score, so the backtest knows availability.
   */
  asOf?: string;
}

export async function loadScoreboard(league: LeagueId, yyyymmdd: string, signal?: AbortSignal): Promise<ScoreboardGame[]> {
  const extra = league === 'ncaam' ? '&groups=50&limit=400' : '';
  const json = await getJson('site', sitePath(league, `/scoreboard?dates=${yyyymmdd}${extra}`), { signal });
  return parseScoreboard(json);
}

async function loadExtract(league: LeagueId, eventId: string, signal?: AbortSignal): Promise<GameExtract | null> {
  const key = `x.${league}.${eventId}`;
  const cached = readCache<GameExtract>(key);
  if (cached?.v === 1) return cached;
  const summary = await getJson('site', sitePath(league, `/summary?event=${eventId}`), { signal });
  const ex = extractGame(summary, eventId);
  if (ex) writeCache(key, ex);
  return ex;
}

async function recentCompleted(league: LeagueId, teamId: string, before: string, season: number, n: number, signal?: AbortSignal) {
  const found: { id: string; date: string }[] = [];
  for (const yr of [season, season - 1]) {
    if (found.length >= n) break;
    try {
      const json = await getJson('site', sitePath(league, `/teams/${teamId}/schedule?season=${yr}`), { signal });
      const evs = parseScheduleEvents(json)
        .filter((e) => e.completed && Date.parse(e.date) < Date.parse(before))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      for (const e of evs) if (found.length < n && !found.some((f) => f.id === e.id)) found.push(e);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
    }
  }
  return found;
}

/**
 * Season averages for players with no recent games for this team (new arrivals, returning
 * injuries). With `asOf`, only seasons before that date's season count, topped up with that
 * season's game log up to the date, so a backtest never sees later games.
 */
export async function fetchAthleteSeason(league: LeagueId, athleteId: string, signal?: AbortSignal, asOf?: string): Promise<PlayerSample | null> {
  try {
    const json = await getJson('web', webPath(league, `/athletes/${athleteId}/stats`), { signal });
    if (!asOf) return parseAthleteStats(json);
    const before = parseAthleteStats(json, { beforeSeason: seasonYear(asOf, league) });
    let current: PlayerSample | null = null;
    try {
      const log = await getJson('web', webPath(league, `/athletes/${athleteId}/gamelog`), { signal });
      current = parseGamelog(log, asOf);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
    }
    return combineSeasons(current, before);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return null;
  }
}

const scaleBox = (b: BoxLine, k: number): BoxLine => Object.fromEntries(Object.entries(b).map(([key, v]) => [key, v * k])) as unknown as BoxLine;

/** A small current sample topped up to about 20 games with the previous one. */
export function combineSeasons(current: PlayerSample | null, previous: PlayerSample | null): PlayerSample | null {
  if (!current || current.games <= 0) return previous;
  if (!previous || previous.games <= 0 || current.games >= 20) return current;
  const w = Math.min(previous.games, 20 - current.games) / previous.games;
  return {
    games: current.games + previous.games * w,
    starts: current.starts + previous.starts * w,
    box: addBox(current.box, scaleBox(previous.box, w)),
  };
}

/** Sums an athlete game log over games before `before` (ISO). */
export function parseGamelog(json: J, before: string): PlayerSample | null {
  const keys: string[] = (json?.names ?? json?.labels ?? []).map((k: unknown) => String(k).toLowerCase());
  const events: Record<string, J> = json?.events ?? {};
  const cutoff = Date.parse(before);
  const box = emptyBox();
  let games = 0;
  for (const st of Array.isArray(json?.seasonTypes) ? json.seasonTypes : []) {
    for (const cat of st?.categories ?? []) {
      for (const ev of cat?.events ?? []) {
        const meta = events[String(ev?.eventId)];
        const when = Date.parse(meta?.gameDate ?? '');
        if (!Number.isFinite(when) || when >= cutoff) continue;
        const line = parseStatLine(
          keys.map((k) => (k === 'totalrebounds' ? 'rebounds' : k)),
          ev?.stats ?? [],
        );
        if (!line || line.min <= 0) continue;
        games++;
        for (const k of Object.keys(box) as (keyof BoxLine)[]) box[k] += line[k];
      }
    }
  }
  return games ? { games, starts: 0, box } : null;
}

/** Parses ESPN's athlete stats page payload: categories[] with labels and per-season rows. */
export function parseAthleteStats(json: J, opts: { beforeSeason?: number } = {}): PlayerSample | null {
  const cats: J[] = Array.isArray(json?.categories) ? json.categories : [];
  const avg = cats.find((c) => /average/i.test(c?.name ?? c?.displayName ?? '')) ?? cats[0];
  if (!avg) return null;
  const labels: string[] = (avg.labels ?? avg.names ?? []).map((l: unknown) => String(l).toUpperCase());
  const rows: J[] = Array.isArray(avg.statistics) ? avg.statistics : [];
  if (!rows.length) return null;
  const pick = (row: J) => {
    const stats: unknown[] = row?.stats ?? [];
    const get = (...names: string[]) => {
      for (const n of names) {
        const i = labels.indexOf(n);
        if (i >= 0) return stats[i];
      }
      return undefined;
    };
    const pair = (v: unknown): [number, number] => {
      const [a, b] = String(v ?? '0-0').split('-').map((x) => num(x));
      return [a, b ?? 0];
    };
    const gp = num(get('GP'));
    const [fgm, fga] = get('FG') != null && String(get('FG')).includes('-') ? pair(get('FG')) : [num(get('FGM')), num(get('FGA'))];
    const [tpm, tpa] = get('3PT') != null && String(get('3PT')).includes('-') ? pair(get('3PT')) : [num(get('3PM')), num(get('3PA'))];
    const [ftm, fta] = get('FT') != null && String(get('FT')).includes('-') ? pair(get('FT')) : [num(get('FTM')), num(get('FTA'))];
    const per: BoxLine = {
      min: num(get('MIN')),
      pts: num(get('PTS')),
      fgm, fga, tpm, tpa, ftm, fta,
      oreb: num(get('OR', 'OREB')),
      dreb: num(get('DR', 'DREB')),
      ast: num(get('AST')),
      stl: num(get('STL')),
      blk: num(get('BLK')),
      tov: num(get('TO', 'TOV')),
      pf: num(get('PF')),
    };
    if (per.oreb + per.dreb === 0) per.dreb = num(get('REB'));
    return { gp, gs: num(get('GS')), per };
  };
  // ESPN ships the whole career, one row per team stint plus a "Totals" row for traded seasons.
  // Keep one row per season (the totals row when there is one), newest last.
  const bySeason = new Map<number, J>();
  for (const row of rows) {
    const yr = num(row?.season?.year, NaN);
    if (!Number.isFinite(yr) || (opts.beforeSeason != null && yr >= opts.beforeSeason)) continue;
    const isTotal = /total/i.test(String(row?.teamSlug ?? '')) || row?.teamId == null;
    const cur = bySeason.get(yr);
    if (!cur || isTotal) bySeason.set(yr, row);
  }
  const ordered = bySeason.size || opts.beforeSeason != null ? [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r) : rows;
  // Latest season with games; blend in the season before when the latest is a small sample.
  const parsed = ordered.map(pick).filter((r) => r.gp > 0 && r.per.min > 0);
  if (!parsed.length) return null;
  const latest = parsed[parsed.length - 1];
  const prev = parsed.length > 1 ? parsed[parsed.length - 2] : undefined;
  let box = scaleBox(latest.per, latest.gp);
  let games = latest.gp;
  let starts = latest.gs;
  if (prev && latest.gp < 20) {
    const w = Math.min(prev.gp, 20 - latest.gp);
    box = addBox(box, scaleBox(prev.per, w));
    games += w;
    starts += (prev.gs * w) / Math.max(1, prev.gp);
  }
  return { games, starts, box };
}

function rosterFromBox(ath: ReturnType<typeof parseBoxPlayers>[string]): RosterAthlete[] {
  return ath.map((a) => ({ id: a.id, name: a.name, short: a.short, jersey: a.jersey, pos: a.pos, headshot: a.headshot }));
}

function buildSamples(teamId: string, extracts: GameExtract[]): { players: Map<string, PlayerSample>; team: TeamSample | null } {
  const players = new Map<string, PlayerSample>();
  let team: TeamSample | null = null;
  for (const ex of extracts) {
    const t = ex.teams[teamId];
    if (!t) continue;
    team ??= { games: 0, poss: 0, ptsFor: 0, ptsAgainst: 0, oppTov: 0 };
    team.games++;
    team.poss += t.poss;
    team.ptsFor += t.ptsFor;
    team.ptsAgainst += t.ptsAgainst;
    team.oppTov += t.oppTov;
    if (t.oppZones) {
      team.oppZones ??= emptyZones();
      for (const z of ZONES) {
        team.oppZones[z].att += t.oppZones[z].att;
        team.oppZones[z].made += t.oppZones[z].made;
      }
    }
    for (const [pid, p] of Object.entries(t.players)) {
      const s = players.get(pid) ?? { games: 0, starts: 0, box: emptyBox() };
      s.games++;
      if (p.starter) s.starts++;
      s.box = addBox(s.box, p.box);
      if (p.zones) {
        s.zones ??= emptyZones();
        for (const z of ZONES) {
          s.zones[z].att += p.zones[z].att;
          s.zones[z].made += p.zones[z].made;
        }
      }
      if (p.assistedMakes != null) s.assistedMakes = (s.assistedMakes ?? 0) + p.assistedMakes;
      if (p.assistsTo) {
        s.assistsTo ??= {};
        for (const [k, v] of Object.entries(p.assistsTo)) s.assistsTo[k] = (s.assistsTo[k] ?? 0) + v;
      }
      players.set(pid, s);
    }
  }
  return { players, team };
}

const zonesHaveData = (z?: ZoneTable) => !!z && ZONES.some((k) => z[k].att > 0);

export async function loadGame(league: LeagueId, eventId: string, opts: LoadOptions): Promise<GameData> {
  const { signal, onStatus } = opts;
  onStatus?.('Loading game');
  const summary: J = await getJson('site', sitePath(league, `/summary?event=${eventId}`), { signal });
  const comp = summary?.header?.competitions?.[0];
  if (!comp) throw new DataError('ESPN has no data for that game.');
  const status = comp.status ?? {};
  const phase = phaseOf(status?.type?.state);
  const cs: J[] = comp.competitors ?? [];
  const homeC = cs.find((c) => c?.homeAway === 'home') ?? cs[0];
  const awayC = cs.find((c) => c?.homeAway === 'away') ?? cs[1];
  const date: string = comp.date ?? summary?.header?.date ?? new Date().toISOString();
  const season = num(summary?.header?.season?.year, seasonYear(date, league));

  const asOf = opts.asOf;
  const boxPlayers = parseBoxPlayers(summary);
  // A finished game's injury list describes today, not tip-off; as-of rebuilds use the box score.
  const injuries = asOf ? {} : parseInjuries(summary);

  const teamBase = async (c: J): Promise<{ t: TeamProfile; roster: RosterAthlete[] }> => {
    const tm = c?.team ?? {};
    const id = String(tm.id ?? c?.id);
    let roster: RosterAthlete[] = [];
    const fromBox = boxPlayers[id];
    if (fromBox?.length) roster = rosterFromBox(fromBox);
    if (!(asOf && roster.length)) try {
      const rj = await getJson('site', sitePath(league, `/teams/${id}/roster`), { signal });
      const official = parseRoster(rj);
      if (!roster.length) roster = official;
      else {
        // Box score is authoritative for who dressed; roster adds injury details.
        const byId = new Map(official.map((a) => [a.id, a]));
        roster = roster.map((a) => ({ ...a, injury: byId.get(a.id)?.injury, headshot: a.headshot ?? byId.get(a.id)?.headshot }));
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      if (!roster.length) throw new DataError(`Couldn't load the ${tm.displayName ?? 'team'} roster.`);
    }
    const t: TeamProfile = {
      id,
      abbr: tm.abbreviation ?? '?',
      name: tm.displayName ?? tm.name ?? '?',
      shortName: tm.shortDisplayName ?? tm.name ?? tm.abbreviation ?? '?',
      color: /^[0-9a-f]{6}$/i.test(tm.color ?? '') ? `#${tm.color}` : '#555555',
      altColor: /^[0-9a-f]{6}$/i.test(tm.alternateColor ?? '') ? `#${tm.alternateColor}` : '#999999',
      logo: tm.logo ?? tm.logos?.[0]?.href,
      record: (c?.record ?? c?.records)?.find?.((r: J) => r?.type === 'total')?.summary ?? (c?.record ?? c?.records)?.[0]?.summary,
      players: [],
      sample: null,
      source: '',
    };
    return { t, roster };
  };

  onStatus?.('Loading rosters');
  const [home, away] = await Promise.all([teamBase(homeC), teamBase(awayC)]);

  // Recent completed games for each team, before this game's tip.
  onStatus?.('Finding recent games');
  const [homeRecent, awayRecent] = await Promise.all([
    recentCompleted(league, home.t.id, date, season, opts.sampleGames, signal),
    recentCompleted(league, away.t.id, date, season, opts.sampleGames, signal),
  ]);
  const allIds = [...new Set([...homeRecent, ...awayRecent].map((e) => e.id))];
  let done = 0;
  const extracts = new Map<string, GameExtract>();
  await mapLimit(allIds, 6, async (id) => {
    try {
      const ex = await loadExtract(league, id, signal);
      if (ex) extracts.set(id, ex);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
    }
    onStatus?.(`Reading play-by-play ${++done}/${allIds.length}`);
  });

  const finishTeam = async (side: { t: TeamProfile; roster: RosterAthlete[] }, recent: { id: string; date: string }[]) => {
    const exs = recent.map((r) => extracts.get(r.id)).filter((x): x is GameExtract => !!x);
    const { players, team } = buildSamples(side.t.id, exs);
    side.t.sample = team;
    const withPbp = exs.some((e) => zonesHaveData(e.teams[side.t.id]?.oppZones));
    side.t.source = exs.length ? `${exs.length} recent game${exs.length === 1 ? '' : 's'}${withPbp ? ' with play-by-play' : ''}` : 'League averages';
    side.t.rest = restOf(recent, date);
    const needSeason = side.roster.filter((a) => (players.get(a.id)?.box.min ?? 0) < 40);
    const season = new Map<string, PlayerSample | null>();
    if (needSeason.length) {
      onStatus?.(`Season stats for ${side.t.abbr} newcomers`);
      await mapLimit(needSeason, 6, async (a) => season.set(a.id, await fetchAthleteSeason(league, a.id, signal, asOf)));
    }
    const box = boxPlayers[side.t.id] ?? [];
    side.t.players = side.roster.map((a): PlayerProfile => {
      const recentS = players.get(a.id);
      const seasonS = season.get(a.id);
      let sample: PlayerSample | null = recentS ?? null;
      let source = recentS ? `Last ${recentS.games} game${recentS.games === 1 ? '' : 's'} with team` : 'Replacement level (no data)';
      if (seasonS && (!recentS || recentS.box.min < 40)) {
        sample = seasonS;
        source = `Season averages (${Math.round(seasonS.games)} gp)`;
      }
      const b = box.find((x) => x.id === a.id);
      // A DNP with a non-coaching reason (illness, injury, rest) means he wasn't available.
      const unavailableDnp = b && !b.played && b.reason && !/coach/i.test(b.reason);
      const injury = injuries[a.id] ?? a.injury ?? (unavailableDnp ? { status: 'Out', detail: b!.reason, out: phase !== 'pre' } : undefined);
      return {
        id: a.id,
        name: a.name,
        short: a.short,
        jersey: a.jersey,
        pos: a.pos,
        group: posGroup(a.pos),
        headshot: a.headshot,
        injury,
        starter: b && !asOf ? b.starter : (recentS?.starts ?? 0) >= Math.max(1, (recentS?.games ?? 0) * 0.5),
        sample,
        source,
        actual: b && phase !== 'pre' ? { ...b.box, played: b.played, starter: b.starter } : undefined,
      };
    });
  };
  onStatus?.('Building player profiles');
  await Promise.all([finishTeam(home, homeRecent), finishTeam(away, awayRecent)]);

  const plays = phase === 'pre' ? [] : parsePlays(summary);
  const homeScore = homeC?.score != null && homeC.score !== '' ? num(homeC.score) : undefined;
  const awayScore = awayC?.score != null && awayC.score !== '' ? num(awayC.score) : undefined;
  const notes: string[] = [];
  if (!extracts.size) notes.push('No recent games found; player ratings fall back to season averages and league priors.');

  return {
    league,
    id: eventId,
    date,
    name: `${away.t.name} at ${home.t.name}`,
    phase,
    statusText: status?.type?.detail ?? status?.type?.shortDetail ?? '',
    period: num(status?.period),
    clockSec: clockToSec(status?.displayClock ?? status?.clock),
    home: home.t,
    away: away.t,
    homeScore,
    awayScore,
    venue: summary?.gameInfo?.venue?.fullName,
    neutral: !!comp?.neutralSite,
    officials: parseOfficials(summary),
    odds: parseOdds(summary, home.t.id),
    espnHomeWinPct: parsePredictor(summary),
    plays,
    espnWinProb: parseWinProb(summary, plays),
    notes,
  };
}

/** Days since the team's previous game and whether this is the second night of a back-to-back. */
export function restOf(recent: { date: string }[], tip: string): { days: number | null; b2b: boolean } {
  const last = recent.reduce((m, r) => Math.max(m, Date.parse(r.date) || 0), 0);
  if (!last) return { days: null, b2b: false };
  const hours = (Date.parse(tip) - last) / 3_600_000;
  return { days: Math.max(0, Math.round(hours / 24)), b2b: hours > 0 && hours < 36 };
}

/** The game as it stood before tip-off: no box score, plays, score or win probability. */
export function pregameView(g: GameData): GameData {
  const strip = (t: TeamProfile): TeamProfile => ({ ...t, players: t.players.map((p) => ({ ...p, actual: undefined })) });
  return {
    ...g,
    phase: 'pre',
    statusText: '',
    period: 0,
    clockSec: 0,
    homeScore: undefined,
    awayScore: undefined,
    home: strip(g.home),
    away: strip(g.away),
    plays: [],
    espnWinProb: [],
  };
}

/** Patches the live parts of a game (status, score, box, plays, win probability) from a fresh summary. */
export function applySummary(g: GameData, summary: J): GameData {
  const comp = summary?.header?.competitions?.[0];
  if (!comp) return g;
  const status = comp.status ?? {};
  const phase = phaseOf(status?.type?.state);
  const cs: J[] = comp.competitors ?? [];
  const score = (id: string) => {
    const c = cs.find((x) => String(x?.team?.id ?? x?.id) === id);
    return c?.score != null && c.score !== '' ? num(c.score) : undefined;
  };
  const box = parseBoxPlayers(summary);
  const patch = (t: TeamProfile): TeamProfile => {
    const lines = box[t.id];
    if (!lines?.length) return t;
    const byId = new Map(lines.map((b) => [b.id, b]));
    return {
      ...t,
      players: t.players.map((p) => {
        const b = byId.get(p.id);
        return b && phase !== 'pre' ? { ...p, actual: { ...b.box, played: b.played, starter: b.starter } } : p;
      }),
    };
  };
  const plays = phase === 'pre' ? [] : parsePlays(summary);
  return {
    ...g,
    phase,
    statusText: status?.type?.detail ?? status?.type?.shortDetail ?? g.statusText,
    period: num(status?.period, g.period),
    clockSec: clockToSec(status?.displayClock ?? status?.clock),
    homeScore: score(g.home.id) ?? g.homeScore,
    awayScore: score(g.away.id) ?? g.awayScore,
    home: patch(g.home),
    away: patch(g.away),
    plays,
    espnWinProb: parseWinProb(summary, plays),
    odds: parseOdds(summary, g.home.id) ?? g.odds,
  };
}

/** Completed-period line scores and the current period's opening score, read off the play-by-play. */
export function periodContext(plays: Play[], period: number): Pick<GameSnapshot, 'prior' | 'periodStart'> {
  const endOf = new Map<number, [number, number]>();
  for (const p of plays) if (p.period < period) endOf.set(p.period, [p.homeScore, p.awayScore]);
  const prior: [number, number][] = [];
  let prev: [number, number] = [0, 0];
  for (let q = 1; q < period; q++) {
    const end = endOf.get(q) ?? prev;
    prior.push([end[0] - prev[0], end[1] - prev[1]]);
    prev = end;
  }
  return { prior, periodStart: prev };
}

/** Game state at a given play, for "simulate from this moment". */
export function snapshotAtPlay(g: GameData, seq: number): GameSnapshot | undefined {
  const p = g.plays.find((x) => x.seq === seq);
  if (!p) return undefined;
  return { period: p.period, clockSec: p.clockSec, homeScore: p.homeScore, awayScore: p.awayScore, ...periodContext(g.plays, p.period) };
}

/** Live game state for "simulate the rest" from the current box score. */
export function snapshotFromGame(g: GameData): GameSnapshot | undefined {
  if (g.phase !== 'in' || g.homeScore == null || g.awayScore == null) return undefined;
  const fouls: Record<string, number> = {};
  const played: Record<string, number> = {};
  for (const t of [g.home, g.away]) {
    for (const p of t.players) {
      if (!p.actual) continue;
      fouls[p.id] = p.actual.pf;
      played[p.id] = p.actual.min * 60;
    }
  }
  const period = Math.max(1, g.period);
  return { period, clockSec: g.clockSec, homeScore: g.homeScore, awayScore: g.awayScore, fouls, played, ...periodContext(g.plays, period) };
}
