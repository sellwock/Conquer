// The NFL prop model: no game simulation, each line priced from the player's recent games, scaled
// to the book's implied points for his team, and drawn 2,000 times so it produces the same
// per-draw results (`PropMarket.hits`) the basketball simulator does. Everything downstream (the
// fitted pick model, the log, the track record) then works unchanged. Players are drawn
// independently, so the app never prices two NFL props from one game together.
import type { PropLine } from '../../data/espn/props';
import type { NflGameLog, NflLine } from '../../data/espn/nfl';
import { makeRng, type Rng } from '../../lib/rng';
import type { PropMarket } from '../parlays';
import { PARTS, type NflBoxStat } from '../props';
import type { NflStat, Odds, PropStat } from '../types';

export const NFL_SIMS = 2000;
/** Games of a player's history used, newest first, each weighing this much less than the one after it. */
export const NFL_GAMES = 10;
export const NFL_DECAY = 0.85;
/** The book's line counts as this many games of history: the model only moves off it as far as the record argues. */
export const LINE_WEIGHT = 2;
/** How strongly a team's implied points carry into its players' volume and yards (1 would be proportional). */
export const TEAM_ELASTICITY = 0.5;

/** Game-to-game spread of each stat as a share of its line, for players with little history. */
const CV: Record<NflStat, number> = { passYds: 0.3, passComp: 0.22, passAtt: 0.18, rushYds: 0.55, rushAtt: 0.4, recYds: 0.65, rec: 0.45, passRushYds: 0.3, rushRecYds: 0.5 };
/** Counts are drawn as counts; yards from a continuous, right-skewed distribution. */
const COUNTS = new Set<NflStat>(['passComp', 'passAtt', 'rushAtt', 'rec']);

export const isNflStat = (s: PropStat): s is NflStat => s in CV;

export const valueOf = (stat: PropStat, line: NflLine) => PARTS[stat].reduce((a, k) => a + (line[k as NflBoxStat] ?? 0), 0);

/** Each team's implied points from the book's spread (the home team's) and total. */
export function impliedPoints(odds: Odds | undefined, homeId: string, awayId: string): Record<string, number> | undefined {
  if (odds?.total == null || odds.spread == null) return undefined;
  const home = (odds.total - odds.spread) / 2;
  return { [homeId]: home, [awayId]: odds.total - home };
}

export interface NflPrice {
  /** The model's mean and spread for the player's full game. */
  mean: number;
  sd: number;
  games: number;
}

/**
 * The model's full-game mean and spread for a stat: a recency-weighted average of the player's last
 * NFL_GAMES games before `before`, scaled by his team's implied points against its points in those
 * games, and pulled toward the book's line by LINE_WEIGHT games. Undefined without history.
 */
export function nflPrice(stat: NflStat, line: number, history: NflGameLog[], before: string, implied?: number): NflPrice | undefined {
  // Games he only appeared in on special teams, or left at once, read as all zeros: left out.
  const games = history.filter((g) => g.date < before && Object.values(g.line).some((v) => v !== 0)).slice(0, NFL_GAMES);
  if (!games.length) return undefined;
  let sw = 0, sw2 = 0, sx = 0, spts = 0;
  games.forEach((g, i) => {
    const w = NFL_DECAY ** i;
    sw += w;
    sw2 += w * w;
    sx += w * valueOf(stat, g.line);
    spts += w * g.teamPts;
  });
  const avg = sx / sw;
  let sv = 0;
  games.forEach((g, i) => (sv += NFL_DECAY ** i * (valueOf(stat, g.line) - avg) ** 2));
  const nEff = (sw * sw) / sw2;
  // Weighted variance, corrected for the effective sample size.
  const variance = nEff > 1 ? (sv / sw) * (nEff / (nEff - 1)) : 0;
  const teamAvg = spts / sw;
  const f = implied && teamAvg > 0 ? Math.min(1.2, Math.max(0.85, (implied / teamAvg) ** TEAM_ELASTICITY)) : 1;
  const k = LINE_WEIGHT;
  const mean = (nEff * avg * f + k * line) / (nEff + k);
  const prior = (CV[stat] * Math.max(line, 1)) ** 2;
  const sd = Math.max(0.15 * Math.max(line, 1), Math.sqrt((nEff * variance * f * f + k * prior) / (nEff + k)));
  return { mean, sd, games: games.length };
}

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia and Tsang. */
function gamma(rng: Rng, shape: number, scale: number): number {
  if (shape < 1) return gamma(rng, shape + 1, scale) * Math.max(rng(), 1e-12) ** (1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

function poisson(rng: Rng, lambda: number): number {
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rng)));
  const l = Math.exp(-lambda);
  let k = 0, p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l);
  return k - 1;
}

/** One draw with this mean and spread: a count (negative binomial) or yards (gamma). */
export function draw(rng: Rng, stat: NflStat, mean: number, sd: number): number {
  if (mean <= 0) return 0;
  const variance = sd * sd;
  if (COUNTS.has(stat)) {
    if (variance <= mean * 1.02) return poisson(rng, mean);
    const r = (mean * mean) / (variance - mean);
    return poisson(rng, gamma(rng, r, mean / r));
  }
  return gamma(rng, (mean * mean) / variance, variance / mean);
}

export interface NflLiveState {
  /** Share of the game still to play (0 to 1). */
  remaining: number;
  /** Each player's line so far. */
  soFar: Map<string, NflLine>;
}

/**
 * Prices each posted line the model covers. `history` holds each player's games (newest first),
 * `teamOf` his team, `implied` each team's implied points. With `live`, a player's final number is
 * what he has so far plus the rest of the game: the full-game distribution scaled to the share
 * left, and centred on the pre-game line (the live board's opening line) rather than the live one.
 */
export function nflPropMarkets(
  lines: PropLine[],
  history: Map<string, NflGameLog[]>,
  names: Map<string, string>,
  ctx: { gameId: string; kickoff: string; teamOf: Map<string, string>; implied?: Record<string, number>; live?: NflLiveState; sims?: number },
): PropMarket[] {
  const n = ctx.sims ?? NFL_SIMS;
  const out: PropMarket[] = [];
  for (const l of lines) {
    if (!isNflStat(l.stat)) continue;
    const name = names.get(l.athleteId);
    const games = history.get(l.athleteId);
    if (!name || !games?.length) continue;
    const team = ctx.teamOf.get(l.athleteId) ?? games[0].teamId;
    const pregameLine = ctx.live ? (l.open?.line ?? l.line) : l.line;
    const price = nflPrice(l.stat, pregameLine, games, ctx.kickoff, ctx.implied?.[team]);
    if (!price) continue;
    const now = ctx.live ? valueOf(l.stat, ctx.live.soFar.get(l.athleteId) ?? ({} as NflLine)) : 0;
    const share = ctx.live ? Math.max(0, Math.min(1, ctx.live.remaining)) : 1;
    const mean = price.mean * share, sd = price.sd * Math.sqrt(share);
    const rng = makeRng(`nfl|${ctx.gameId}|${l.athleteId}|${l.stat}`);
    const hits = new Uint8Array(n);
    let sum = 0;
    for (let s = 0; s < n; s++) {
      const v = now + (share > 0 ? draw(rng, l.stat, mean, sd) : 0);
      hits[s] = v > l.line ? 1 : v < l.line ? 0 : 2;
      sum += v;
    }
    out.push({
      athleteId: l.athleteId,
      player: name,
      stat: l.stat,
      line: l.line,
      over: l.over,
      under: l.under,
      hits,
      mean: sum / n,
      ...(ctx.live ? { now } : {}),
      ...(l.updated ? { updated: l.updated } : {}),
      ...(l.assumed ? { assumed: true as const } : {}),
    });
  }
  return out;
}
