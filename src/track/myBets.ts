// Bets the user says they placed, kept on their device, and how they turned out. Graded from the
// forward log's box lines, so it needs no request beyond the prop log the track record reads.
import { noVig, toDecimal } from '../model/parlays';
import { PARTS } from '../model/props';
import type { LeagueId, PropStat } from '../model/types';
import { BOX, lineMove } from './propGrade';
import type { PropEntry } from './types';

export interface MyBet {
  id: string;
  /** When it was logged (ISO). */
  at: string;
  league: LeagueId;
  gameId: string;
  /** e.g. "MIL @ WSH" */
  game: string;
  athleteId: string;
  player: string;
  stat: PropStat;
  line: number;
  side: 'over' | 'under';
  /** The price the site listed, and the price actually taken (American). */
  listed: number;
  price: number;
  stake: number;
  /** The pick model's chance, and the book's no-vig chance, of this side when it was logged. */
  pFit: number;
  pFair: number;
  /** A bet on a game in progress. */
  live?: boolean;
}

export type BetResult = 'win' | 'loss' | 'push' | 'void';

export interface GradedBet {
  bet: MyBet;
  /** Undefined until the game is final in the log. */
  result?: BetResult;
  final?: number;
  /** Profit in the stake's units. */
  profit?: number;
  /** Pre-game bets with a closing line: how the book's line moved by tip. */
  moved?: 'toward' | 'away' | 'same';
}

/** One bet against its game's log entry: void when the player sat, as books do. */
export function gradeBet(bet: MyBet, entry: PropEntry | undefined): GradedBet {
  const moved = bet.live ? undefined : lineMove(entry?.close?.lines, { athleteId: bet.athleteId, stat: bet.stat, line: bet.line, side: bet.side, pMarket: bet.pFair });
  if (!entry || entry.status !== 'final' || !entry.box || !(bet.athleteId in entry.box)) return { bet, ...(moved ? { moved } : {}) };
  const b = entry.box[bet.athleteId];
  if (!b) return { bet, result: 'void', profit: 0, ...(moved ? { moved } : {}) };
  const final = PARTS[bet.stat].reduce((a, k) => a + b[BOX.indexOf(k)], 0);
  const result: BetResult = final === bet.line ? 'push' : final > bet.line === (bet.side === 'over') ? 'win' : 'loss';
  const profit = result === 'win' ? bet.stake * (toDecimal(bet.price) - 1) : result === 'loss' ? -bet.stake : 0;
  return { bet, result, final, profit: Math.round(profit * 100) / 100, ...(moved ? { moved } : {}) };
}

export interface BetSummary {
  open: number;
  win: number;
  loss: number;
  /** Pushes and voids: stake returned. */
  returned: number;
  /** Staked on decided bets, and what they made. */
  staked: number;
  profit: number;
  roi: number;
  /** Average chance the fit gave decided bets, to set against the share that won. */
  said: number;
  /** Chance given up between the listed price and the price taken, on average (positive is worse). */
  slippage: number;
  moved: { toward: number; away: number; same: number };
}

export function summarizeBets(graded: GradedBet[]): BetSummary {
  const s: BetSummary = { open: 0, win: 0, loss: 0, returned: 0, staked: 0, profit: 0, roi: 0, said: 0, slippage: 0, moved: { toward: 0, away: 0, same: 0 } };
  let said = 0, slip = 0;
  for (const g of graded) {
    slip += 1 / toDecimal(g.bet.price) - 1 / toDecimal(g.bet.listed);
    if (g.moved) s.moved[g.moved]++;
    if (!g.result) s.open++;
    else if (g.result === 'win' || g.result === 'loss') {
      s[g.result]++;
      s.staked += g.bet.stake;
      s.profit += g.profit ?? 0;
      said += g.bet.pFit;
    } else s.returned++;
  }
  const decided = s.win + s.loss;
  s.staked = Math.round(s.staked * 100) / 100;
  s.profit = Math.round(s.profit * 100) / 100;
  s.roi = s.staked ? s.profit / s.staked : 0;
  s.said = decided ? said / decided : 0;
  s.slippage = graded.length ? slip / graded.length : 0;
  return s;
}

const STATS: PropStat[] = ['pts', 'reb', 'ast', 'tpm', 'pra', 'pr', 'pa', 'ar'];

/** Bets read from an exported file or from storage: anything malformed is dropped. */
export function parseBets(json: unknown): MyBet[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { bets?: unknown })?.bets) ? (json as { bets: unknown[] }).bets : [];
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
  const out: MyBet[] = [];
  const seen = new Set<string>();
  for (const b of list as Partial<MyBet>[]) {
    if (!b || !str(b.id) || seen.has(b.id) || !str(b.gameId) || !str(b.athleteId) || !str(b.player) || !str(b.at)) continue;
    if (!STATS.includes(b.stat as PropStat) || (b.side !== 'over' && b.side !== 'under') || (b.league !== 'nba' && b.league !== 'ncaam')) continue;
    if (!num(b.line) || !num(b.price) || Math.abs(b.price) < 100 || !num(b.stake) || b.stake <= 0 || !num(b.pFit)) continue;
    seen.add(b.id);
    out.push({
      id: b.id, at: b.at, league: b.league, gameId: b.gameId, game: str(b.game) ? b.game : '', athleteId: b.athleteId, player: b.player, stat: b.stat as PropStat, line: b.line, side: b.side,
      listed: num(b.listed) && Math.abs(b.listed) >= 100 ? b.listed : b.price, price: b.price, stake: b.stake, pFit: b.pFit, pFair: num(b.pFair) ? b.pFair : noVig(b.price, b.price)[0], ...(b.live ? { live: true } : {}),
    });
  }
  return out;
}
