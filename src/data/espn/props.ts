// Player prop lines from ESPN's odds feed (sports.core.api.espn.com, DraftKings when this was
// written). Over/under props arrive as two items per player and stat with no side label; the feed
// lists the over first. That was checked against lines whose side is obvious, such as a high-volume
// shooter's 1.5 threes priced at -188 (the over). Milestone ladders ("25+ points"), team, quarter
// and first-basket props are left out.
import type { LeagueId, Odds, PropStat } from '../../model/types';
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

/** ESPN prop type ids for the over/under player props this app can simulate. */
const TYPE_STAT: Record<string, PropStat> = { '1': 'pts', '2': 'ast', '3': 'reb', '4': 'tpm', '87': 'pa', '88': 'pr', '89': 'ar', '90': 'pra' };

const athleteOf = (it: J): string | undefined => /\/athletes\/(\d+)/.exec(String(it?.athlete?.$ref ?? ''))?.[1];

/** "+131" → 131, "-121" → -121, "EVEN" → 100; anything else is undefined. */
export function americanOf(v: unknown): number | undefined {
  const s = String(v ?? '').trim();
  if (/^even$/i.test(s)) return 100;
  const n = Number(s.replace(/^\+/, ''));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : undefined;
}

export function parsePropBets(items: J[]): PropLine[] {
  const groups = new Map<string, J[]>();
  for (const it of items) {
    const stat = TYPE_STAT[String(it?.type?.id)];
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
    const over = americanOf(a?.odds?.american?.value), under = americanOf(b?.odds?.american?.value);
    if (!Number.isFinite(line) || line !== lineB || over == null || under == null) continue;
    const [athleteId, stat] = k.split('|') as [string, PropStat];
    out.push({ athleteId, stat, line, over, under });
  }
  return out;
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
  board.lines = parsePropBets(items);
  return board;
}
