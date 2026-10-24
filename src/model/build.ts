// Turns player/team profiles into simulator inputs: who is available, how the minutes get
// redistributed, and per-player shot, usage and counting-stat rates (shrunk toward priors).
import { clamp, shrink } from '../lib/stats';
import { LEAGUES, regulationSec, type LeagueConfig } from './leagues';
import { ZONES, type GameData, type GameSnapshot, type PlayerProfile, type PosGroup, type TeamProfile, type Zone } from './types';
import type { SimPlayer, SimSpec, SimTeam } from '../sim/types';

export type MinutesMode = 'projected' | 'actual';

export interface BuildOptions {
  /** Players the user has ruled out. */
  outs: Set<string>;
  /** Injured players the user has cleared to play anyway. */
  ins: Set<string>;
  whistle: number;
  homeCourt: boolean;
  minutesMode: MinutesMode;
  start?: GameSnapshot;
  /** Ignore every injury and user out (the "healthy" counterfactual). */
  healthy?: boolean;
  /** Charge a team on the second night of a back-to-back (on unless false). */
  rest?: boolean;
}

export interface MinutesPlan {
  minutes: Record<string, number>;
  base: Record<string, number>;
  unavailable: Set<string>;
  starters: Set<string>;
}

const SHOT_PRIOR: Record<PosGroup, { r3: number; two: [number, number, number]; c3: number }> = {
  G: { r3: 0.45, two: [0.4, 0.22, 0.38], c3: 0.18 },
  F: { r3: 0.4, two: [0.5, 0.22, 0.28], c3: 0.32 },
  C: { r3: 0.14, two: [0.7, 0.2, 0.1], c3: 0.3 },
};

const FTA_PER_TRIP = 1.87;
const AND_ONE = 0.2;
const PRIOR_MIN = 180;

export function isUnavailable(p: PlayerProfile, opts: Pick<BuildOptions, 'outs' | 'ins' | 'healthy' | 'minutesMode'>): boolean {
  if (opts.minutesMode === 'actual' && p.actual) return !p.actual.played || (!opts.healthy && opts.outs.has(p.id));
  if (opts.healthy) return false;
  if (opts.outs.has(p.id)) return true;
  if (p.injury?.out && !opts.ins.has(p.id)) return true;
  return false;
}

export function baseMinutes(p: PlayerProfile, lg: LeagueConfig): number {
  const s = p.sample;
  if (!s || s.games <= 0 || s.box.min <= 0) return lg.id === 'nba' ? 8 : 6;
  return s.box.min / s.games;
}

export function planMinutes(team: TeamProfile, lg: LeagueConfig, opts: BuildOptions): MinutesPlan {
  const unavailable = new Set(team.players.filter((p) => isUnavailable(p, opts)).map((p) => p.id));
  const base: Record<string, number> = {};
  const minutes: Record<string, number> = {};
  const total = lg.rosterMinutes;

  if (opts.minutesMode === 'actual' && team.players.some((p) => p.actual?.played)) {
    let sum = 0;
    for (const p of team.players) {
      base[p.id] = p.actual?.played && !unavailable.has(p.id) ? p.actual.min : 0;
      sum += base[p.id];
    }
    for (const p of team.players) minutes[p.id] = sum > 0 ? (base[p.id] * total) / sum : 0;
    const starters = new Set(team.players.filter((p) => p.actual?.starter).map((p) => p.id));
    return { minutes, base, unavailable, starters };
  }

  const avail = team.players.filter((p) => !unavailable.has(p.id));
  for (const p of team.players) base[p.id] = baseMinutes(p, lg);

  // Minutes that walked out the door, by position group: same-position teammates absorb more.
  const missing: Record<PosGroup, number> = { G: 0, F: 0, C: 0 };
  for (const p of team.players) if (unavailable.has(p.id)) missing[p.group] += base[p.id];
  const missingTotal = missing.G + missing.F + missing.C;

  for (const p of avail) minutes[p.id] = base[p.id];
  for (const p of team.players) if (unavailable.has(p.id)) minutes[p.id] = 0;

  let sum = avail.reduce((s, p) => s + minutes[p.id], 0);
  if (sum > total) {
    // More healthy minutes than exist: trim everyone proportionally, deep bench first.
    const excess = sum - total;
    const w = avail.map((p) => Math.max(0, 30 - minutes[p.id]) + 4);
    const ws = w.reduce((a, b) => a + b, 0);
    avail.forEach((p, i) => (minutes[p.id] = Math.max(0, minutes[p.id] - (excess * w[i]) / ws)));
    sum = avail.reduce((s, p) => s + minutes[p.id], 0);
    if (sum > 0) for (const p of avail) minutes[p.id] *= total / sum;
  } else {
    // Minutes flow to players with headroom: the next men in the rotation absorb most of them,
    // stars only a little (coaches rarely push a 35-minute player much past 38).
    let cap = (p: PlayerProfile) => Math.min(lg.playerMinCap, base[p.id] * 1.15 + 8);
    for (let pass = 0; pass < 2; pass++) {
      for (let it = 0; it < 12; it++) {
        const deficit = total - avail.reduce((s, p) => s + minutes[p.id], 0);
        if (deficit < 0.01) break;
        const open = avail.filter((p) => minutes[p.id] < cap(p) - 1e-6);
        if (!open.length) break;
        const w = open.map(
          (p) => (cap(p) - minutes[p.id]) * Math.sqrt(base[p.id] + 2) * (1 + (missingTotal > 0 ? (2 * missing[p.group]) / missingTotal : 0)),
        );
        const ws = w.reduce((a, b) => a + b, 0);
        open.forEach((p, i) => {
          minutes[p.id] = Math.min(cap(p), minutes[p.id] + (deficit * w[i]) / ws);
        });
      }
      cap = () => lg.playerMinCap + 6;
    }
  }

  // Starters: the listed starters who can play, filled out by minutes with a sane position mix.
  const byMin = [...avail].sort((a, b) => minutes[b.id] - minutes[a.id]);
  const starters: PlayerProfile[] = byMin.filter((p) => p.starter).slice(0, 5);
  for (const p of byMin) {
    if (starters.length >= 5) break;
    if (starters.includes(p)) continue;
    const cs = starters.filter((s) => s.group === 'C').length;
    if (p.group === 'C' && cs >= 1 && byMin.filter((q) => !starters.includes(q) && q.group !== 'C').length > 5 - starters.length - 1) continue;
    starters.push(p);
  }
  for (const p of byMin) if (starters.length < 5 && !starters.includes(p)) starters.push(p);
  return { minutes, base, unavailable, starters: new Set(starters.map((p) => p.id)) };
}

interface Rates {
  usage: number;
  pTO: number;
  pTrip: number;
  zoneShare: number[];
  zonePct: number[];
  ft: number;
  assistedFactor: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  pf: number;
}

export function playerRates(p: PlayerProfile, lg: LeagueConfig): Rates {
  const prior = lg.priors[p.group];
  const s = p.sample;
  const b = s?.box;
  const min = b?.min ?? 0;
  // Usage rate: share of the team's plays this player ends while on the floor.
  const teamPlaysPerMin = (lg.pace * lg.playsPerPoss) / (regulationSec(lg) / 60);
  const perMin = (v: number | undefined, pri: number) => ((v ?? 0) + pri * PRIOR_MIN) / (min + PRIOR_MIN);

  const fga = b?.fga ?? 0, fta = b?.fta ?? 0, tov = b?.tov ?? 0;
  const rawUsage = min > 0 ? (fga + 0.44 * fta + tov) / min / teamPlaysPerMin : prior.usage * 0.8;
  const usage = (rawUsage * min + prior.usage * 0.85 * 120) / (min + 120);

  const trips = fta / FTA_PER_TRIP;
  const shootTrips = trips * (1 - lg.bonusTripShare);
  const fgaOpen = Math.max(0, fga - AND_ONE * shootTrips);
  const actions = fgaOpen + shootTrips + tov;
  const pTO = shrink(tov, actions, lg.tovPct * 0.95, 60);
  const pTrip = shrink(shootTrips, actions, 0.085, 60);

  const sp = SHOT_PRIOR[p.group];
  const lgTwoPct = sp.two[0] * lg.zonePct.rim + sp.two[1] * lg.zonePct.paint + sp.two[2] * lg.zonePct.mid;
  const lgThreePct = sp.c3 * lg.zonePct.c3 + (1 - sp.c3) * lg.zonePct.ab3;
  const priorShare = [sp.two[0] * (1 - sp.r3), sp.two[1] * (1 - sp.r3), sp.two[2] * (1 - sp.r3), sp.c3 * sp.r3, (1 - sp.c3) * sp.r3];

  // And-ones are simulated as their own event, so take them out of the shooting sample: box scores
  // count them as made field goals, which would otherwise inflate every ordinary attempt.
  const andOnes = AND_ONE * shootTrips;
  const andOneShare = [0.7, 0.24, 0, 0, 0.06];
  let zoneShare: number[];
  let zonePct: number[];
  const z = s?.zones;
  const zAtt = z ? ZONES.reduce((a, k) => a + z[k].att, 0) : 0;
  if (z && zAtt >= 10) {
    zoneShare = ZONES.map((k, i) => (z[k].att + priorShare[i] * 25) / (zAtt + 25));
    zonePct = ZONES.map((k, i) => {
      const ao = Math.min(z[k].made, andOnes * andOneShare[i]);
      return shrink(z[k].made - ao, z[k].att - ao, lg.zonePct[k], zoneK(k));
    });
  } else {
    const tpa = b?.tpa ?? 0, tpm = b?.tpm ?? 0, fgm = b?.fgm ?? 0;
    const r3 = shrink(tpa, fga, sp.r3, 40);
    const ao3 = Math.min(tpm, andOnes * 0.06);
    const ao2 = Math.min(fgm - tpm, andOnes * 0.94);
    const p3 = shrink(tpm - ao3, tpa - ao3, lgThreePct, 120);
    const p2 = shrink(fgm - tpm - ao2, fga - tpa - ao2, lgTwoPct, 90);
    zoneShare = [sp.two[0] * (1 - r3), sp.two[1] * (1 - r3), sp.two[2] * (1 - r3), sp.c3 * r3, (1 - sp.c3) * r3];
    const k2 = p2 / lgTwoPct, k3 = p3 / lgThreePct;
    zonePct = [lg.zonePct.rim * k2, lg.zonePct.paint * k2, lg.zonePct.mid * k2, lg.zonePct.c3 * k3, lg.zonePct.ab3 * k3];
  }
  if (!s) zonePct = zonePct.map((v) => v * 0.96); // unknown players: replacement level
  const shareSum = zoneShare.reduce((a, v) => a + v, 0);
  zoneShare = zoneShare.map((v) => v / shareSum);

  let assistedFactor = 1;
  if (z && s?.assistedMakes != null) {
    const expected = ZONES.reduce((a, k) => a + z[k].made * lg.assisted[k], 0);
    assistedFactor = clamp((s.assistedMakes + 15) / (expected + 15), 0.35, 1.5);
  }

  return {
    usage: clamp(usage, 0.06, 0.42),
    pTO: clamp(pTO, 0.03, 0.3),
    pTrip: clamp(pTrip, 0.01, 0.3),
    zoneShare,
    zonePct: zonePct.map((v) => clamp(v, 0.1, 0.85)),
    ft: shrink(b?.ftm ?? 0, fta, lg.ftPct, 40),
    assistedFactor,
    oreb: perMin(b?.oreb, prior.oreb),
    dreb: perMin(b?.dreb, prior.dreb),
    ast: perMin(b?.ast, prior.ast),
    stl: perMin(b?.stl, prior.stl),
    blk: perMin(b?.blk, prior.blk),
    pf: perMin(b?.pf, prior.pf),
  };
}

function zoneK(z: Zone): number {
  return z === 'rim' ? 30 : z === 'paint' ? 30 : z === 'mid' ? 40 : 60;
}

function teamDefense(t: TeamProfile, lg: LeagueConfig): { zoneDefMult: number[]; toForce: number } {
  const s = t.sample;
  if (!s || s.games === 0 || s.poss <= 0) return { zoneDefMult: [1, 1, 1, 1, 1], toForce: 1 };
  const toForce = clamp(shrink(s.oppTov, s.poss, lg.tovPct, 600) / lg.tovPct, 0.85, 1.15);
  if (s.oppZones) {
    const zoneDefMult = ZONES.map((k) => clamp(shrink(s.oppZones![k].made, s.oppZones![k].att, lg.zonePct[k], 220) / lg.zonePct[k], 0.88, 1.12));
    return { zoneDefMult, toForce };
  }
  const dRtg = (s.ptsAgainst + lg.ppp * lg.pace * 8) / (s.poss + lg.pace * 8);
  const m = clamp(1 + 1.2 * (dRtg / lg.ppp - 1), 0.92, 1.08);
  return { zoneDefMult: [m, m, m, m, m], toForce };
}

export function teamPace(t: TeamProfile, lg: LeagueConfig): number {
  const s = t.sample;
  if (!s || s.games === 0 || s.poss <= 0) return lg.pace;
  return (s.poss + lg.pace * 5) / (s.games + 5);
}

function buildTeam(t: TeamProfile, lg: LeagueConfig, plan: MinutesPlan, makeMult: number, snapshot?: GameSnapshot): SimTeam {
  // Without a minutes history (a start picked from the play-by-play), assume everyone is on pace
  // for his projection so far; otherwise the rotation would hand the starters all the rest.
  const reg = regulationSec(lg);
  const elapsedFrac = snapshot
    ? Math.min(1, (snapshot.period <= lg.periods ? (snapshot.period - 1) * lg.periodSec + lg.periodSec - snapshot.clockSec : reg) / reg)
    : 0;
  const ids = t.players.map((p) => p.id);
  const players: SimPlayer[] = t.players.map((p) => {
    const r = playerRates(p, lg);
    const given = p.sample?.assistsTo ?? {};
    const totalGiven = ids.reduce((a, id) => a + (given[id] ?? 0), 0);
    const assistTo = ids.map((id) => (id === p.id ? 0 : ((given[id] ?? 0) + 0.5) / (totalGiven + 0.5 * (ids.length - 1))));
    const cum: number[] = [];
    r.zoneShare.reduce((acc, v, i) => (cum[i] = acc + v), 0);
    return {
      id: p.id,
      name: p.name,
      short: p.short,
      group: p.group,
      starter: plan.starters.has(p.id),
      targetMin: plan.unavailable.has(p.id) ? 0 : plan.minutes[p.id] ?? 0,
      usage: r.usage,
      pTO: r.pTO,
      pTrip: r.pTrip,
      zoneCum: cum,
      zonePct: r.zonePct,
      ft: r.ft,
      assistedFactor: r.assistedFactor,
      oreb: r.oreb,
      dreb: r.dreb,
      ast: r.ast,
      stl: r.stl,
      blk: r.blk,
      pf: r.pf,
      assistTo,
      initFouls: snapshot?.fouls?.[p.id] ?? 0,
      initSec: snapshot?.played?.[p.id] ?? (plan.unavailable.has(p.id) ? 0 : (plan.minutes[p.id] ?? 0) * 60 * elapsedFrac),
    };
  });
  const d = teamDefense(t, lg);
  return { id: t.id, abbr: t.abbr, name: t.shortName, players, makeMult, zoneDefMult: d.zoneDefMult, toForce: d.toForce };
}

export interface BuiltSpec {
  spec: SimSpec;
  plans: { home: MinutesPlan; away: MinutesPlan };
}

/** Points a team gives up for being on the second night of a back-to-back. */
export function restPenalty(t: TeamProfile, lg: LeagueConfig, opts: Pick<BuildOptions, 'rest'>): number {
  return opts.rest !== false && t.rest?.b2b ? lg.backToBackPts : 0;
}

export function buildSpec(game: GameData, opts: BuildOptions): BuiltSpec {
  const lg = LEAGUES[game.league];
  const homePlan = planMinutes(game.home, lg, opts);
  const awayPlan = planMinutes(game.away, lg, opts);
  const pace = (teamPace(game.home, lg) * teamPace(game.away, lg)) / lg.pace;
  const useHome = opts.homeCourt && !game.neutral;
  // Home court and rest as a make-probability edge. Makes carry only part of scoring and score
  // effects pull margins back toward zero, so the edge is scaled up (calibrated with `npm run calibrate`).
  const edgePts = (useHome ? lg.homeAdvPts : 0) + restPenalty(game.away, lg, opts) - restPenalty(game.home, lg, opts);
  const delta = edgePts / 2 / (pace * lg.ppp) / 0.62;
  const home = buildTeam(game.home, lg, homePlan, 1 + delta, opts.start);
  const away = buildTeam(game.away, lg, awayPlan, 1 - delta, opts.start);
  const spec: SimSpec = {
    league: lg,
    home,
    away,
    pace,
    whistle: opts.whistle,
    start: opts.start
      ? {
          period: opts.start.period,
          clockSec: opts.start.clockSec,
          homeScore: opts.start.homeScore,
          awayScore: opts.start.awayScore,
          prior: opts.start.prior,
          periodStart: opts.start.periodStart,
        }
      : undefined,
  };
  return { spec, plans: { home: homePlan, away: awayPlan } };
}
