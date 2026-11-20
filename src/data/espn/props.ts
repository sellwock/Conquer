// Player prop lines from ESPN's odds feed (sports.core.api.espn.com, DraftKings when this was
// written). Over/under props arrive as two items per player and stat with no side label; the feed
// lists the over first. That was checked against lines whose side is obvious, such as a high-volume
// shooter's 1.5 threes priced at -188 (the over). Milestone ladders ("25+ points"), team, quarter
// and first-basket props are left out.
import type { LeagueId, Odds, PropStat } from '../../model/types';
import { LEAGUE_INFO, type Sport } from '../../model/leagues';
import { corePath, getJson } from './client';
import { oddsFromItem } from './parse';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export interface PropLine {
  athleteId: string;
  stat: PropStat;
  line: number;
  /** American prices. */
  over: number;
  under: number;
  /** The line and prices the book first posted, when the feed carries them. */
  open?: { line: number; over: number; under: number };
  /** The book posted the line without prices, so `over` and `under` are ASSUMED_PRICE. */
  assumed?: true;
  /**
   * When the book last changed this line or its prices (ISO UTC), from the feed's clock as
   * corrected by `feedClock`. Reliable on live boards only.
   */
  updated?: string;
}

export interface PropBoard {
  provider?: string;
  lines: PropLine[];
  fetchedAt: number;
  /** Lines from the book's in-game feed. */
  live?: boolean;
  /** The same book's game lines (moneyline, spread, total), when asked for with the teams. */
  odds?: Odds;
}

/** ESPN prop type ids for the over/under player props this app can price, by sport. */
const TYPE_STAT: Record<Sport, Record<string, PropStat>> = {
  basketball: { '1': 'pts', '2': 'ast', '3': 'reb', '4': 'tpm', '87': 'pa', '88': 'pr', '89': 'ar', '90': 'pra' },
  // From DraftKings' NFL board on Nov 20, 2026 ("Total Passing Yards (incl. overtime)" and so on).
  football: { '8': 'passYds', '9': 'passComp', '16': 'passAtt', '11': 'rushAtt', '12': 'rushYds', '13': 'recYds', '14': 'rec', '18': 'passRushYds', '20': 'rushRecYds' },
};

/**
 * ESPN relays DraftKings' NFL prop lines without prices (checked on every NFL prop type, pre-game,
 * live and kept, Nov 20, 2026), so those lines carry this price on both sides, flagged `assumed`.
 */
export const ASSUMED_PRICE = -110;

const athleteOf = (it: J): string | undefined => /\/athletes\/(\d+)/.exec(String(it?.athlete?.$ref ?? ''))?.[1];

/** "+131" → 131, "-121" → -121, "EVEN" → 100; anything else is undefined. */
export function americanOf(v: unknown): number | undefined {
  const s = String(v ?? '').trim();
  if (/^even$/i.test(s)) return 100;
  const n = Number(s.replace(/^\+/, ''));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : undefined;
}

export function parsePropBets(items: J[], sport: Sport = 'basketball'): PropLine[] {
  const types = TYPE_STAT[sport];
  const groups = new Map<string, J[]>();
  for (const it of items) {
    const stat = types[String(it?.type?.id)];
    const id = athleteOf(it);
    if (!stat || !id) continue;
    const k = `${id}|${stat}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const out: PropLine[] = [];
  for (const [k, [a, b]] of groups) {
    if (!a || !b) continue;
    const line = Number(a?.current?.target?.value ?? a?.odds?.total?.value);
    const lineB = Number(b?.current?.target?.value ?? b?.odds?.total?.value);
    // NFL lines come without prices: both sides at the assumed price, flagged.
    const unpriced = sport === 'football' && !a?.odds && !b?.odds;
    const over = unpriced ? ASSUMED_PRICE : americanOf(a?.odds?.american?.value);
    const under = unpriced ? ASSUMED_PRICE : americanOf(b?.odds?.american?.value);
    if (!Number.isFinite(line) || line !== lineB || over == null || under == null) continue;
    const [athleteId, stat] = k.split('|') as [string, PropStat];
    const openLine = Number(a?.open?.target?.value ?? a?.odds?.total?.open);
    const openOver = unpriced ? ASSUMED_PRICE : americanOf(a?.odds?.american?.open);
    const openUnder = unpriced ? ASSUMED_PRICE : americanOf(b?.odds?.american?.open);
    // The later of the two sides' update times.
    const updated = [a?.lastUpdated, b?.lastUpdated].filter((t): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t))).sort().pop();
    out.push({
      athleteId,
      stat,
      line,
      over,
      under,
      ...(Number.isFinite(openLine) && openOver != null && openUnder != null ? { open: { line: openLine, over: openOver, under: openUnder } } : {}),
      ...(updated ? { updated } : {}),
      ...(unpriced ? { assumed: true as const } : {}),
    });
  }
  return out;
}

/** Lines updated this far ahead of our clock still count as "now" (clocks drift). */
const CLOCK_SLACK_MS = 2 * 60_000;

/**
 * ESPN stamps prop lines in a time zone it labels UTC but isn't: on Nov 20, 2026 every in-game
 * line on an NFL and two NBA boards was stamped 2h20m to 3h ahead of the real time, and the
 * pre-game lines frozen at kickoff read kickoff plus exactly 3 hours. So the stamps are shifted
 * back by the whole number of hours that puts the board's latest change just before `now`. That
 * assumes the latest change on a board is under an hour old, which holds for a game in progress
 * (the in-game feed refreshes every few minutes). Stamps no whole-hour shift can explain are
 * dropped rather than trusted. Pre-game boards can sit unchanged for hours, so their corrected
 * times may be off by whole hours; nothing reads them.
 */
export function feedClock(lines: PropLine[], now: number): PropLine[] {
  const stamps = lines.map((l) => (l.updated ? Date.parse(l.updated) : NaN)).filter((t) => !Number.isNaN(t));
  if (!stamps.length) return lines;
  const ahead = Math.max(...stamps) - now;
  const hours = ahead <= CLOCK_SLACK_MS ? 0 : Math.ceil((ahead - CLOCK_SLACK_MS) / 3_600_000);
  if (hours > 14) return lines.map(({ updated: _u, ...l }) => l);
  if (!hours) return lines;
  return lines.map((l) => (l.updated ? { ...l, updated: new Date(Date.parse(l.updated) - hours * 3_600_000).toISOString() } : l));
}

/**
 * The book to read props from. During a game ESPN lists two: the frozen pre-game book
 * ("DraftKings") and its in-game feed ("DraftKings - Live Odds"), whose lines move with the game.
 */
export function pickPropBook(items: J[], live: boolean): J | undefined {
  const books = items.filter((it) => it?.propBets?.$ref);
  const isLive = (it: J) => /live/i.test(String(it?.provider?.name ?? ''));
  return (live ? books.find(isLive) : books.find((it) => !isLive(it))) ?? (live ? undefined : books[0]);
}

/**
 * The posted prop lines for one game; empty when the book hasn't posted any. With `live`, the
 * in-game lines. With `teams` (abbreviations), the book's game lines come along too.
 */
export async function loadProps(league: LeagueId, eventId: string, signal?: AbortSignal, live = false, teams?: { home: string; away: string }): Promise<PropBoard> {
  const odds = await getJson('core', corePath(league, `/events/${eventId}/competitions/${eventId}/odds?lang=en&region=us`), { signal, noStore: true });
  const withProps = pickPropBook(odds?.items ?? [], live);
  const board: PropBoard = { provider: withProps?.provider?.name, lines: [], fetchedAt: Date.now(), live };
  if (withProps && teams) board.odds = oddsFromItem(withProps, teams.home, teams.away);
  if (!withProps) return board;
  const ref = new URL(String(withProps.propBets.$ref));
  const items: J[] = [];
  for (let page = 1, pages = 1; page <= pages && page <= 5; page++) {
    ref.searchParams.set('limit', '1000');
    ref.searchParams.set('page', String(page));
    const json = await getJson('core', ref.pathname + ref.search, { signal, noStore: true });
    items.push(...(json?.items ?? []));
    pages = Number(json?.pageCount) || 1;
  }
  board.lines = feedClock(parsePropBets(items, LEAGUE_INFO[league].sport), board.fetchedAt);
  return board;
}
