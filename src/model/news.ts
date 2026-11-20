// Injury news: a player newly ruled out for a game that hasn't tipped, or one who was out and now
// isn't, and how it moves the game's player props. The simulation plays the game twice on the same
// random numbers, once as reported and once the other way (him in after a scratch, him out after a
// return), so each prop's shift is the news itself. Books move the spread within minutes; whether
// teammates' props catch up as fast is what this looks for.
import { buildSpec } from './build';
import { defaultPickMode, evaluate, legsForGame, weightsFor, HIT_FLOOR, MAX_PRICE, type BlendWeights, type GameMarket, type Leg, type PropMarket } from './parlays';
import { propMarkets, rosterNames } from './props';
import type { GameData, LeagueId, PropStat, ScoreboardGame, TeamProfile } from './types';
import { loadGame } from '../data/espn/load';
import { loadProps } from '../data/espn/props';
import type { InjuryReport } from '../data/espn/parse';
import type { Outcomes } from '../sim/quick';
import type { SimSpec } from '../sim/types';

/** A scratch matters only if he was projected at least this many minutes. */
export const NEWS_MIN_MINUTES = 12;
/** Without an earlier report to compare against, an out entry this recent counts as news. */
export const FALLBACK_HOURS = 6;
const NEWS_SIMS = 2000;
const SAMPLE_GAMES = 10;

/** A report naming fewer teams than this may be incomplete, so a player missing from it isn't news. */
export const FULL_REPORT_TEAMS = 15;

/** What the last report said, by athlete id. The name is kept so a player who drops off the next report can still be named. */
export type InjuryState = Record<string, { status: string; out: boolean; since?: string; team: string; name?: string }>;

export function injuryState(feed: InjuryReport[]): InjuryState {
  return Object.fromEntries(feed.map((r) => [r.athleteId, { status: r.injury.status, out: r.injury.out, team: r.teamId, name: r.name, ...(r.injury.since ? { since: r.injury.since } : {}) }]));
}

export interface NewsEvent {
  /** "out": newly ruled out (also what an event without a kind is). "back": was out, now isn't. */
  kind?: 'out' | 'back';
  /** One per player per status update. */
  key: string;
  athleteId: string;
  name: string;
  teamId: string;
  status: string;
  /** ESPN's update time. */
  since?: string;
  note?: string;
  /** His status on the previous report, if he was on it. */
  was?: string;
  gameId: string;
  tip: string;
}

/**
 * Players out now who weren't out on `prev`, the previous report (the scheduled job keeps one), for
 * games that haven't tipped. A move to out from another status (day-to-day, questionable) is news
 * whatever its date. A player missing from `prev` altogether counts only if his entry is from the
 * last few hours: ESPN refreshes the date on long-term injuries too, and a report can miss a team.
 *
 * And the other way: players `prev` had out who are now listed as something else, or have left a
 * report that still names most teams. An upgrade to day-to-day is no promise he plays; the event
 * carries his new status so the reader can judge.
 */
export function findNews(feed: InjuryReport[], prev: InjuryState | undefined, games: ScoreboardGame[], now = Date.now()): NewsEvent[] {
  const next = new Map<string, ScoreboardGame>();
  for (const g of [...games].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    if (g.phase !== 'pre' || Date.parse(g.date) <= now) continue;
    for (const t of [g.home.id, g.away.id]) if (!next.has(t)) next.set(t, g);
  }
  const out: NewsEvent[] = [];
  for (const r of feed) {
    if (!r.injury.out) continue;
    const g = next.get(r.teamId);
    if (!g) continue;
    const before = prev?.[r.athleteId];
    if (before?.out) continue;
    if (!before && !(r.injury.since && now - Date.parse(r.injury.since) <= FALLBACK_HOURS * 3_600_000)) continue;
    out.push({
      key: `${r.athleteId}|${r.injury.since ?? ''}`,
      athleteId: r.athleteId,
      name: r.name,
      teamId: r.teamId,
      status: r.injury.status,
      ...(r.injury.since ? { since: r.injury.since } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(before ? { was: before.status } : {}),
      gameId: g.id,
      tip: g.date,
    });
  }
  const listed = new Map(feed.map((r) => [r.athleteId, r]));
  const full = new Set(feed.map((r) => r.teamId)).size >= FULL_REPORT_TEAMS;
  for (const [athleteId, before] of Object.entries(prev ?? {})) {
    if (!before.out) continue;
    const r = listed.get(athleteId);
    if (r ? r.injury.out : !full || !before.name) continue;
    const teamId = r?.teamId ?? before.team;
    const g = next.get(teamId);
    if (!g) continue;
    const since = r?.injury.since;
    out.push({
      kind: 'back',
      key: `${athleteId}|back|${since ?? g.id}`,
      athleteId,
      name: r?.name ?? before.name!,
      teamId,
      status: r ? r.injury.status : 'Off the injury report',
      ...(since ? { since } : {}),
      ...(r?.note ? { note: r.note } : {}),
      was: before.status,
      gameId: g.id,
      tip: g.date,
    });
  }
  return out;
}

/** The game with the latest report applied: everyone's status as the feed has it now. */
export function withReport(g: GameData, feed: InjuryReport[]): GameData {
  const team = (t: TeamProfile): TeamProfile => {
    const mine = new Map(feed.filter((r) => r.teamId === t.id).map((r) => [r.athleteId, r.injury]));
    return { ...t, players: t.players.map((p) => ({ ...p, injury: mine.get(p.id) })) };
  };
  return { ...g, home: team(g.home), away: team(g.away) };
}

export type Simulate = (spec: SimSpec, n: number, seed: string, opts: { players: boolean }) => Promise<Outcomes> | Outcomes;

export interface NewsRow {
  athleteId: string;
  player: string;
  /** His team's abbreviation. */
  team: string;
  stat: PropStat;
  line: number;
  over: number;
  under: number;
  /** Simulated average with the player in the news out, and with him in. */
  meanOut: number;
  meanWith: number;
  /** As reported minus the other way: what the news does to this prop. */
  shift: number;
  /** The side the news points to, priced the way the app prices props. */
  side: 'over' | 'under';
  price: number;
  pHit: number;
  pFair: number;
  ev: number;
  /** Clears the singles bar (positive return, hit floor, price cap). */
  pick: boolean;
}

export interface NewsPricing {
  event: NewsEvent;
  game: GameData;
  label: string;
  /** His projected minutes when he plays. */
  minutes: number;
  provider?: string;
  fetchedAt: number;
  sims: number;
  /** Every priced prop as reported, and each one's simulated mean the other way, for logging. */
  out: PropMarket[];
  withMeans: Map<string, number>;
  /** Props the news moves, the side it points to first; strongest first. */
  rows: NewsRow[];
}

const propKey = (athleteId: string, stat: string) => `${athleteId}|${stat}`;

/**
 * Prices one news event: loads the game, applies `feed`, simulates it as reported and the other
 * way (a scratched player in, a returning one out), and reads the book's current prop lines. Null
 * when he isn't projected for real minutes (nothing to move) or isn't on the roster.
 */
export async function priceNews(
  league: LeagueId,
  event: NewsEvent,
  feed: InjuryReport[],
  simulate: Simulate,
  opts: { signal?: AbortSignal; sims?: number; weights?: BlendWeights; sampleGames?: number; game?: GameData } = {},
): Promise<NewsPricing | null> {
  const sims = opts.sims ?? NEWS_SIMS;
  const g = withReport(opts.game ?? (await loadGame(league, event.gameId, { sampleGames: opts.sampleGames ?? SAMPLE_GAMES, signal: opts.signal })), feed);
  const team = [g.home, g.away].find((t) => t.players.some((p) => p.id === event.athleteId));
  if (!team) return null;
  const back = event.kind === 'back';
  const base = { whistle: 1, homeCourt: true, minutesMode: 'projected' as const };
  const asReported = buildSpec(g, { ...base, outs: new Set(), ins: new Set() });
  const otherWay = buildSpec(g, { ...base, outs: new Set(back ? [event.athleteId] : []), ins: new Set(back ? [] : [event.athleteId]) });
  // The build in which he plays: as reported after a return, the other way after a scratch.
  const withHim = back ? asReported : otherWay;
  const plan = team.id === g.home.id ? withHim.plans.home : withHim.plans.away;
  const minutes = plan.minutes[event.athleteId] ?? 0;
  if (minutes < NEWS_MIN_MINUTES) return null;
  // The same seed for both, so the shift is the news and not simulation noise.
  const seed = `news-${event.gameId}-${event.athleteId}`;
  const [oOut, oWith] = [await simulate(asReported.spec, sims, seed, { players: true }), await simulate(otherWay.spec, sims, seed, { players: true })];
  const board = await loadProps(league, event.gameId, opts.signal, false, { home: g.home.abbr, away: g.away.abbr });
  const label = `${g.away.abbr} @ ${g.home.abbr}`;
  const names = rosterNames(g);
  const out = oOut.players ? propMarkets(board.lines, oOut.players, names) : [];
  const withMeans = new Map((oWith.players ? propMarkets(board.lines, oWith.players, names) : []).map((m) => [propKey(m.athleteId, m.stat), m.mean]));
  const teamOf = new Map([...g.home.players.map((p) => [p.id, g.home.abbr] as const), ...g.away.players.map((p) => [p.id, g.away.abbr] as const)]);

  const market: GameMarket = { gameId: g.id, league, label, home: g.home.abbr, away: g.away.abbr, odds: board.odds ?? { provider: board.provider ?? '' }, margin: oOut.margin, total: oOut.total, props: out };
  const weights = opts.weights ?? weightsFor(league, defaultPickMode(league));
  const legs = new Map<string, Leg>(legsForGame(market, weights).filter((l) => l.prop).map((l) => [`${propKey(l.prop!.athleteId, l.prop!.stat)}|${l.side}`, l]));
  const rows: NewsRow[] = [];
  for (const m of out) {
    const k = propKey(m.athleteId, m.stat);
    const other = withMeans.get(k);
    if (other == null) continue;
    const shift = m.mean - other;
    // Small moves are noise next to the book's own margin.
    if (Math.abs(shift) < (m.stat === 'tpm' ? 0.2 : 0.5)) continue;
    const side = shift > 0 ? 'over' : 'under';
    const leg = legs.get(`${k}|${side}`);
    if (!leg) continue;
    const p = evaluate([leg]);
    rows.push({
      athleteId: m.athleteId,
      player: m.player,
      team: teamOf.get(m.athleteId) ?? '',
      stat: m.stat,
      line: m.line,
      over: m.over,
      under: m.under,
      meanOut: back ? other : m.mean,
      meanWith: back ? m.mean : other,
      shift,
      side,
      price: leg.price,
      pHit: p.pHit,
      pFair: leg.pFair,
      ev: p.ev,
      pick: p.ev > 0 && p.pHit >= HIT_FLOOR[1] && p.price <= MAX_PRICE[1],
    });
  }
  // Picks first, by expected return; then the rest by how far the news moves them.
  rows.sort((a, b) => Number(b.pick) - Number(a.pick) || (a.pick ? b.ev - a.ev : Math.abs(b.shift) - Math.abs(a.shift)));
  return { event, game: g, label, minutes, provider: board.provider, fetchedAt: board.fetchedAt, sims, out, withMeans, rows };
}
