// Possession-level basketball game engine.
//
// One call to simulateGame plays a full game (or the rest of one) possession by possession:
// rotations driven by projected minutes, foul trouble and foul-outs, shot zones, assists from a
// passing network, blocks, offensive rebounds, bonus free throws, and late-game clock strategy.
import { regulationSec } from '../model/leagues';
import { pickWeighted, gammaInt, uniform, type Rng } from '../lib/rng';
import { clamp } from '../lib/stats';
import { BF, NBF, type GameResult, type LogEvent, type SimPlayer, type SimSpec, type SimTeam } from './types';

const RIM = 0, PAINT = 1, C3 = 3, AB3 = 4;
export const TUNING = { segScale: 1.13, segShift: 0.9, scoreEffect: 0.003 };
let SEG_SCALE = 1.13, SEG_SHIFT = 0.9;
const ZONE_WORD = ['layup', 'floater', 'jumper', 'corner three', 'three'];
const BLOCK_RATE_ON_MISS = [0.26, 0.15, 0.05, 0.02, 0.02];

interface TeamState {
  t: SimTeam;
  n: number;
  onCourt: number[];
  sec: Float64Array; // seconds played
  fouls: Int32Array;
  out: Uint8Array; // fouled out or unavailable
  box: Float64Array;
  teamFouls: number;
  /** Lineup-level usage weights, cached per lineup. */
  usageW: Float64Array;
}

export const fmtClock = (s: number) => {
  const c = Math.max(0, s);
  if (c < 60) return c.toFixed(1);
  const m = Math.floor(c / 60);
  const ss = Math.floor(c % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

export function simulateGame(spec: SimSpec, rng: Rng, withLog = false): GameResult {
  SEG_SCALE = TUNING.segScale;
  SEG_SHIFT = TUNING.segShift;
  const lg = spec.league;
  const regSec = regulationSec(lg);
  const teams: [TeamState, TeamState] = [initTeam(spec.home), initTeam(spec.away)];
  const log: LogEvent[] | undefined = withLog ? [] : undefined;

  const score: [number, number] = [spec.start?.homeScore ?? 0, spec.start?.awayScore ?? 0];
  let period = spec.start?.period ?? 1;
  let clock = spec.start?.clockSec ?? lg.periodSec;
  const periodScores: [number, number][] = [];
  for (let p = 1; p < period; p++) periodScores.push([0, 0]);
  let periodStart: [number, number] = [score[0], score[1]];

  // Mean seconds of the first shot-clock segment of a possession, so that the total game hits `pace`.
  // (Empirically calibrated: transition, OREB segments and period ends shave time off.)
  const meanPoss = regSec / (2 * spec.pace);
  const segMean = Math.max(6, meanPoss * SEG_SCALE - SEG_SHIFT);

  let runTeam = -1, runPts = 0;
  const maxRun: [number, number] = [0, 0];
  let leadChanges = 0;
  let lastLeader = Math.sign(score[0] - score[1]);
  const largestLead: [number, number] = [0, 0];
  const possessions: [number, number] = [0, 0];
  let lastSubAt = -1e9;
  let transition = 0; // make bonus on the next possession after a live-ball steal
  let forceSubs = true;

  const elapsedTotal = () => {
    const reg = Math.min(period - 1, lg.periods) * lg.periodSec + (period <= lg.periods ? lg.periodSec - clock : 0);
    const ot = period > lg.periods ? (period - lg.periods - 1) * lg.otSec + (lg.otSec - clock) : 0;
    return reg + ot;
  };

  const emit = (team: 0 | 1 | -1, text: string, pts = 0) => {
    if (!log) return;
    const ev: LogEvent = { period, clockSec: clock, team, text, home: score[0], away: score[1], pts };
    if (pts > 0 && runTeam === team && runPts >= 8) ev.run = runPts;
    log.push(ev);
  };

  const addPoints = (off: 0 | 1, pts: number) => {
    score[off] += pts;
    if (runTeam === off) runPts += pts;
    else {
      runTeam = off;
      runPts = pts;
    }
    if (runPts > maxRun[off]) maxRun[off] = runPts;
    const leader = Math.sign(score[0] - score[1]);
    if (leader !== 0 && lastLeader !== 0 && leader !== lastLeader) leadChanges++;
    if (leader !== 0) lastLeader = leader;
    const lead = score[0] - score[1];
    if (lead > largestLead[0]) largestLead[0] = lead;
    if (-lead > largestLead[1]) largestLead[1] = -lead;
  };

  const stat = (ts: TeamState, i: number, f: number, v = 1) => {
    ts.box[i * NBF + f] += v;
  };

  // --- Rotation -------------------------------------------------------------------------------
  const chooseLineup = (ts: TeamState, side: 0 | 1) => {
    const el = elapsedTotal();
    const fracReg = clamp(el / regSec, 0, 1);
    const margin = score[side] - score[1 - side];
    const lastPeriod = period >= lg.periods;
    const closing = lastPeriod && clock <= 300 && Math.abs(margin) <= 10;
    const garbage = lastPeriod && period === lg.periods && clock <= 420 && Math.abs(margin) >= lg.blowout;
    const halfStart = clock === lg.periodSec && (period === 1 || period === (lg.periods === 4 ? 3 : 2));
    const foulLimit = foulTroubleLimit(lg.periods, lg.foulOut, period, clock);
    const pri: number[] = [];
    for (let i = 0; i < ts.n; i++) {
      const p = ts.t.players[i];
      if (ts.out[i] || p.targetMin <= 0) {
        pri.push(-1e9);
        continue;
      }
      const target = p.targetMin * 60;
      let v: number;
      if (halfStart && p.starter) v = 1e6 + target;
      else if (garbage) v = 1000 - target / 60 + rng() * 2;
      else if (closing) v = target / 60 + (ts.onCourt.includes(i) ? 1 : 0);
      else {
        const deficit = target * fracReg - ts.sec[i] + (ts.onCourt.includes(i) ? 90 : 0);
        v = deficit / 60 + target / 600 + rng() * 0.6;
      }
      if (!closing && !garbage && ts.fouls[i] >= foulLimit) v -= 50;
      pri.push(v);
    }
    const order = [...pri.keys()].filter((i) => pri[i] > -1e8).sort((a, b) => pri[b] - pri[a]);
    const picked: number[] = [];
    let centers = 0, guards = 0;
    for (const i of order) {
      if (picked.length === 5) break;
      const g = ts.t.players[i].group;
      if (g === 'C' && centers >= 2) continue;
      if (picked.length === 4 && guards === 0 && g !== 'G' && order.some((j) => !picked.includes(j) && ts.t.players[j].group === 'G')) continue;
      picked.push(i);
      if (g === 'C') centers++;
      if (g === 'G') guards++;
    }
    for (const i of order) {
      if (picked.length === 5) break;
      if (!picked.includes(i)) picked.push(i);
    }
    // Emergency: fewer than five eligible players (mass foul-outs). Bring back anyone not unavailable.
    for (let i = 0; i < ts.n && picked.length < 5; i++) {
      if (!picked.includes(i) && ts.t.players[i].targetMin > 0) picked.push(i);
    }
    if (log && ts.onCourt.length === 5) {
      const ins = picked.filter((i) => !ts.onCourt.includes(i));
      const outs = ts.onCourt.filter((i) => !picked.includes(i));
      if (ins.length && !halfStart) {
        emit(side, `${ts.t.abbr} sub: ${ins.map((i) => ts.t.players[i].short).join(', ')} in for ${outs.map((i) => ts.t.players[i].short).join(', ')}`);
      }
    }
    ts.onCourt = picked;
    refreshUsage(ts);
  };

  const subCheck = (force: boolean) => {
    const el = elapsedTotal();
    if (!force && el - lastSubAt < 150) return;
    lastSubAt = el;
    chooseLineup(teams[0], 0);
    chooseLineup(teams[1], 1);
  };

  const advance = (dur: number) => {
    clock -= dur;
    for (const ts of teams) for (const i of ts.onCourt) ts.sec[i] += dur;
  };

  // --- Possession pieces ------------------------------------------------------------------------
  const pickOnCourt = (ts: TeamState, w: (p: SimPlayer, i: number) => number, exclude = -1) => {
    const ws = [0, 0, 0, 0, 0];
    for (let k = 0; k < ts.onCourt.length; k++) {
      const i = ts.onCourt[k];
      ws[k] = i === exclude ? 0 : Math.max(0, w(ts.t.players[i], i));
    }
    const k = pickWeighted(rng, ws, ts.onCourt.length);
    return k < 0 ? -1 : ts.onCourt[k];
  };

  // Players in foul trouble defend more carefully.
  const caution = (ts: TeamState, i: number) => {
    const left = lg.foulOut - ts.fouls[i];
    return left <= 1 ? 0.3 : left === 2 ? 0.7 : 1;
  };

  const lineupSum = (ts: TeamState, f: (p: SimPlayer) => number) => {
    let s = 0;
    for (const i of ts.onCourt) s += f(ts.t.players[i]);
    return s;
  };

  const commitFoul = (def: 0 | 1, defender: number, kind: string, shooting: boolean) => {
    const ds = teams[def];
    if (defender < 0) return;
    stat(ds, defender, BF.pf);
    ds.fouls[defender]++;
    ds.teamFouls++;
    if (log) emit(def, `${kind} foul on ${ds.t.players[defender].short}${shooting ? '' : ` (team foul ${ds.teamFouls})`}`);
    if (ds.fouls[defender] >= lg.foulOut) {
      ds.out[defender] = 1;
      if (log) emit(def, `${ds.t.players[defender].name} fouls out`);
      forceSubs = true;
    } else if (ds.fouls[defender] >= foulTroubleLimit(lg.periods, lg.foulOut, period, clock)) {
      forceSubs = true; // coach sits him at the next dead ball
    }
  };

  /** Shoots `n` free throws; returns true if the last one was missed (live rebound). */
  const freeThrows = (off: 0 | 1, shooter: number, n: number, oneAndOne = false): boolean => {
    const os = teams[off];
    const p = os.t.players[shooter];
    let lastMiss = false;
    for (let k = 0; k < n; k++) {
      const made = rng() < p.ft;
      stat(os, shooter, BF.fta);
      if (made) {
        stat(os, shooter, BF.ftm);
        stat(os, shooter, BF.pts);
        addPoints(off, 1);
        if (log) emit(off, `${p.short} makes free throw ${k + 1} of ${oneAndOne ? '1-and-1' : n}`, 1);
      } else if (log) emit(off, `${p.short} misses free throw ${k + 1} of ${oneAndOne ? '1-and-1' : n}`);
      lastMiss = !made;
      if (oneAndOne && !made) break;
    }
    return lastMiss;
  };

  /** Rebound after a miss. Returns true if the offense keeps the ball. */
  const rebound = (off: 0 | 1, ftMiss: boolean): boolean => {
    const def = (1 - off) as 0 | 1;
    const os = teams[off], ds = teams[def];
    const o = lineupSum(os, (p) => p.oreb) / (5 * lgLineup.oreb);
    const d = lineupSum(ds, (p) => p.dreb) / (5 * lgLineup.dreb);
    const base = ftMiss ? lg.ftOrebPct : lg.orebPct;
    const pOff = (base * o) / (base * o + (1 - base) * d);
    const offensive = rng() < pOff;
    const ts = offensive ? os : ds;
    const side = offensive ? off : def;
    if (rng() < 0.9) {
      const r = pickOnCourt(ts, (p) => (offensive ? p.oreb : p.dreb));
      if (r >= 0) {
        stat(ts, r, offensive ? BF.oreb : BF.dreb);
        if (log) emit(side, `${ts.t.players[r].short} ${offensive ? 'offensive' : 'defensive'} rebound`);
      }
    } else if (log) emit(side, `${ts.t.abbr} team rebound`);
    return offensive;
  };

  const lgLineup = leagueLineupRates(spec);

  /** One possession for `off`. */
  const possession = (off: 0 | 1) => {
    const def = (1 - off) as 0 | 1;
    const os = teams[off], ds = teams[def];
    possessions[off]++;
    const transitionBoost = transition;
    transition = 0;
    let segment = 0;
    let putback = false;

    while (clock > 0) {
      const margin = score[off] - score[def];
      const finalPeriod = period >= lg.periods;
      const late = finalPeriod && clock <= 120;
      const shotClock = segment === 0 ? lg.shotClock : lg.orebShotClock;

      // Trailing defense fouls on purpose late: down 4+ to extend the game, or down 1-3 once the
      // leader could simply run out the clock.
      const foulToExtend = clock <= lg.intentionalFoulWindow && margin >= 4 && margin <= (lg.id === 'nba' ? 9 : 10);
      const foulToStop = clock <= lg.shotClock && clock > 2 && margin >= 1 && margin <= 3;
      if (finalPeriod && segment === 0 && (foulToExtend || foulToStop) && rng() < 0.8) {
        const dur = Math.min(clock, uniform(rng, 1, 5));
        advance(dur);
        const fouled = pickOnCourt(os, (p) => p.usage * p.ft ** 6);
        const fouler = pickOnCourt(ds, (_p, i) => Math.max(0.05, lg.foulOut - 1 - ds.fouls[i]));
        if (fouled < 0) return;
        commitFoul(def, fouler, 'Intentional', false);
        const miss = freeThrows(off, fouled, 2);
        if (miss && rebound(off, true)) {
          segment++;
          continue;
        }
        return;
      }

      // Segment duration.
      let dur: number;
      if (segment === 0) {
        dur = clamp(gammaInt(rng, 4, segMean / 4), 2.5, shotClock - 0.5);
        if (transitionBoost) dur *= 0.55;
        if (late && margin > 0) dur = Math.min(shotClock - 1, dur * 1.5);
        else if (late && margin < 0) dur *= 0.6;
        // Tied or down one to three with the shot clock off: hold for the last shot.
        if (finalPeriod && margin <= 0 && margin >= -3 && clock <= shotClock) dur = Math.max(0.5, clock - 1.5);
      } else {
        dur = clamp(gammaInt(rng, 2, 3.2), 1, shotClock - 0.5);
      }
      let heave = false;
      if (dur >= clock) {
        dur = clock;
        heave = clock < 3;
      }
      advance(dur);

      // Off-ball / reach-in fouls (no shot), more of them with a tight whistle.
      if (!heave && rng() < lg.nonShootFoul * spec.whistle) {
        const fouler = pickOnCourt(ds, (p, i) => (p.pf + 0.005) * caution(ds, i));
        commitFoul(def, fouler, 'Personal', false);
        if (ds.teamFouls >= lg.bonusAt) {
          const fouled = pickOnCourt(os, (p) => p.usage);
          if (fouled >= 0) {
            const dbl = lg.doubleBonusAt == null || ds.teamFouls >= lg.doubleBonusAt;
            const miss = freeThrows(off, fouled, 2, !dbl);
            if (miss && rebound(off, true)) {
              segment++;
              continue;
            }
            return;
          }
        }
        if (clock <= 0) return;
      }

      // Who ends the possession, and how.
      const actor = pickOnCourt(os, (_p, i) => os.usageW[i]);
      if (actor < 0) return;
      const a = os.t.players[actor];
      const eff = lineupEfficiency(os, lgLineup.ast);
      const pTO = heave ? 0 : clamp(a.pTO * eff.to * ds.t.toForce * (late && margin < 0 ? 0.9 : 1), 0.01, 0.45);
      const pTrip = heave ? 0.01 : a.pTrip * spec.whistle;
      const pFGA = Math.max(0.05, 1 - a.pTO - a.pTrip);
      const r = rng() * (pTO + pTrip + pFGA);

      if (r < pTO) {
        stat(os, actor, BF.tov);
        if (rng() < 0.12) {
          stat(os, actor, BF.pf);
          os.fouls[actor]++;
          if (log) emit(off, `${a.short} offensive foul (turnover)`);
          if (os.fouls[actor] >= lg.foulOut) {
            os.out[actor] = 1;
            forceSubs = true;
            if (log) emit(off, `${a.name} fouls out`);
          }
        } else if (rng() < 0.58) {
          const st = pickOnCourt(ds, (p) => p.stl + 0.002);
          if (st >= 0) {
            stat(ds, st, BF.stl);
            if (log) emit(off, `${a.short} turnover, stolen by ${ds.t.players[st].short}`);
          }
          transition = 1;
        } else if (log) emit(off, `${a.short} turnover`);
        return;
      }

      const trailing3 = finalPeriod && clock <= 20 && margin === -3;
      const needTwo = finalPeriod && clock <= 20 && (margin === -2 || margin === -1) && !putback;
      const chasing = finalPeriod && clock <= 90 && margin <= -4 && margin >= -12;
      const zone = heave ? AB3 : needTwo && rng() < 0.75 ? (rng() < 0.65 ? RIM : rng() < 0.5 ? PAINT : 2) : pickZone(a, putback, trailing3, chasing);
      const pts = zone >= C3 ? 3 : 2;
      // Score effects: big leads breed a little complacency, deficits a little urgency.
      const scoreEffect = 1 - TUNING.scoreEffect * clamp(margin, -20, 20);
      let pMake = a.zonePct[zone] * os.t.makeMult * eff.make * ds.t.zoneDefMult[zone] * scoreEffect;
      if (zone === RIM) {
        const blkRatio = lineupSum(ds, (p) => p.blk) / (5 * lgLineup.blk);
        pMake *= clamp(1 - 0.05 * (blkRatio - 1), 0.93, 1.05);
        if (transitionBoost || putback) pMake *= 1.06;
      }
      if (heave) pMake = clock > 1.5 ? pMake * 0.6 : 0.05;
      pMake = clamp(pMake, 0.02, 0.92);

      // Shooting foul: and-one or free throws.
      if (r < pTO + pTrip) {
        const fouler = pickOnCourt(ds, (p, i) => (p.pf + 0.005) * caution(ds, i));
        commitFoul(def, fouler, 'Shooting', true);
        if (rng() < 0.2) {
          const z = rng() < 0.94 ? (rng() < 0.75 ? RIM : PAINT) : AB3;
          const p2 = z >= C3 ? 3 : 2;
          made(off, actor, z, p2, true);
          const miss = freeThrows(off, actor, 1);
          if (miss && rebound(off, true)) {
            segment++;
            putback = true;
            continue;
          }
          return;
        }
        const n = zone >= C3 && rng() < 0.12 ? 3 : 2;
        if (log) emit(off, `${a.short} fouled shooting`);
        const miss = freeThrows(off, actor, n);
        if (miss && rebound(off, true)) {
          segment++;
          putback = true;
          continue;
        }
        return;
      }

      // Field goal attempt.
      if (rng() < pMake) {
        made(off, actor, zone, pts, false);
        return;
      }
      stat(os, actor, BF.fga);
      if (pts === 3) stat(os, actor, BF.tpa);
      let blocked = false;
      if (rng() < BLOCK_RATE_ON_MISS[zone] * clamp(lineupSum(ds, (p) => p.blk) / (5 * lgLineup.blk), 0.3, 2.2)) {
        const b = pickOnCourt(ds, (p) => p.blk + 0.001);
        if (b >= 0) {
          stat(ds, b, BF.blk);
          blocked = true;
          if (log) emit(off, `${ds.t.players[b].short} blocks ${a.short}'s ${ZONE_WORD[zone]}`);
        }
      }
      if (log && !blocked) emit(off, `${a.short} misses ${heave ? 'a heave at the buzzer' : ZONE_WORD[zone]}`);
      if (clock <= 0) return;
      if (rebound(off, false)) {
        segment++;
        putback = true;
        continue;
      }
      return;
    }
  };

  const made = (off: 0 | 1, shooter: number, zone: number, pts: number, andOne: boolean) => {
    const os = teams[off];
    const p = os.t.players[shooter];
    stat(os, shooter, BF.fga);
    stat(os, shooter, BF.fgm);
    if (pts === 3) {
      stat(os, shooter, BF.tpa);
      stat(os, shooter, BF.tpm);
    }
    stat(os, shooter, BF.pts, pts);
    let assister = -1;
    if (rng() < clamp(teamsAssisted[zone] * p.assistedFactor, 0, 0.98)) {
      // Passing network: assistTo[j] is the share of this passer's assists that went to player j.
      assister = pickOnCourt(os, (q) => q.ast * (1 + 4 * (q.assistTo[shooter] ?? 0)), shooter);
      if (assister >= 0) stat(os, assister, BF.ast);
    }
    addPoints(off, pts);
    if (log) {
      const what = pts === 3 ? (zone === C3 ? 'corner three' : 'three') : ZONE_WORD[zone];
      emit(off, `${p.short} makes ${what}${andOne ? ' and-one' : ''}${assister >= 0 ? ` (${os.t.players[assister].short} assist)` : ''}`, pts);
    }
  };

  const pickZone = (a: SimPlayer, putback: boolean, need3: boolean, chasing: boolean): number => {
    if (need3) return rng() < 0.2 ? C3 : AB3;
    const cum = a.zoneCum;
    const r = rng();
    if (putback && r < 0.55) return rng() < 0.85 ? RIM : PAINT;
    if (chasing && r < 0.25) return rng() < 0.2 ? C3 : AB3;
    const u = rng();
    for (let z = 0; z < 5; z++) if (u < cum[z]) return z;
    return AB3;
  };

  const teamsAssisted = [spec.league.assisted.rim, spec.league.assisted.paint, spec.league.assisted.mid, spec.league.assisted.c3, spec.league.assisted.ab3];

  // --- Game loop --------------------------------------------------------------------------------
  // Opening tip, then NBA-style alternation: the team that lost the tip starts quarters 2 and 3.
  const tipWinner: 0 | 1 = rng() < 0.5 ? 0 : 1;
  let off: 0 | 1 = tipWinner;
  if (spec.start) off = rng() < 0.5 ? 0 : 1;
  for (const ts of teams) {
    for (let i = 0; i < ts.n; i++) {
      ts.fouls[i] = ts.t.players[i].initFouls;
      ts.sec[i] = ts.t.players[i].initSec;
    }
  }
  subCheck(true);
  forceSubs = false;
  if (log && !spec.start) emit(-1, `Tip-off. ${teams[off].t.abbr} wins the tip.`);

  for (let guard = 0; guard < 5000; guard++) {
    if (clock <= 0) {
      periodScores.push([score[0] - periodStart[0], score[1] - periodStart[1]]);
      if (log) emit(-1, `End of ${periodName(period, lg.periods)}: ${spec.home.abbr} ${score[0]}, ${spec.away.abbr} ${score[1]}`);
      if (period >= lg.periods && score[0] !== score[1]) break;
      period++;
      clock = period > lg.periods ? lg.otSec : lg.periodSec;
      periodStart = [score[0], score[1]];
      teams[0].teamFouls = 0;
      teams[1].teamFouls = 0;
      if (period > lg.periods) off = rng() < 0.5 ? 0 : 1;
      else if (lg.periods === 4) off = period === 4 ? tipWinner : ((1 - tipWinner) as 0 | 1);
      else off = (1 - tipWinner) as 0 | 1;
      lastSubAt = -1e9;
      subCheck(true);
      if (log) emit(-1, `Start of ${periodName(period, lg.periods)}`);
      continue;
    }
    if (forceSubs) {
      subCheck(true);
      forceSubs = false;
    } else subCheck(false);
    possession(off);
    off = (1 - off) as 0 | 1;
  }

  for (const ts of teams) for (let i = 0; i < ts.n; i++) ts.box[i * NBF + BF.sec] = ts.sec[i] - ts.t.players[i].initSec;

  return {
    score,
    periodScores,
    ot: Math.max(0, period - lg.periods),
    box: [teams[0].box, teams[1].box],
    maxRun,
    leadChanges,
    largestLead,
    fouledOut: [outList(teams[0], lg.foulOut), outList(teams[1], lg.foulOut)],
    possessions,
    log,
  };

  function initTeam(t: SimTeam): TeamState {
    const n = t.players.length;
    const out = new Uint8Array(n);
    t.players.forEach((p, i) => {
      if (p.targetMin <= 0) out[i] = 1;
    });
    return {
      t,
      n,
      onCourt: [],
      sec: new Float64Array(n),
      fouls: new Int32Array(n),
      out,
      box: new Float64Array(n * NBF),
      teamFouls: 0,
      usageW: new Float64Array(n),
    };
  }

  function refreshUsage(ts: TeamState) {
    ts.usageW.fill(0);
    for (const i of ts.onCourt) ts.usageW[i] = ts.t.players[i].usage;
  }

  function outList(ts: TeamState, limit: number) {
    const o: number[] = [];
    for (let i = 0; i < ts.n; i++) if (ts.fouls[i] >= limit) o.push(i);
    return o;
  }
}

/**
 * Usage/efficiency trade-off. When the five on the floor don't normally use a full possession's
 * worth of usage (a star is sitting), everyone has to create more and shoots a little worse.
 */
function lineupEfficiency(ts: { onCourt: number[]; t: SimTeam }, lgAst: number) {
  let s = 0, ast = 0;
  for (const i of ts.onCourt) {
    s += ts.t.players[i].usage;
    ast += ts.t.players[i].ast;
  }
  if (s <= 0) return { make: 0.9, to: 1.2 };
  const stretch = 1 / s - 1; // > 0 means the lineup is short on shot creators
  // Playmaking: lineups without their passers get fewer easy looks.
  const creation = clamp(1 + 0.05 * (ast / (5 * lgAst) - 1), 0.96, 1.03);
  // Short on creators hurts a lot; a surplus of them only lets everyone be a bit pickier.
  const k = stretch > 0 ? 0.2 : 0.04;
  return {
    make: clamp((1 - k * stretch) * creation, 0.84, 1.03),
    to: clamp(1 + (stretch > 0 ? 0.45 : 0.1) * stretch, 0.95, 1.4),
  };
}

function leagueLineupRates(spec: SimSpec) {
  const pr = spec.league.priors;
  const avg = (k: 'oreb' | 'dreb' | 'blk' | 'ast') => (pr.G[k] * 2 + pr.F[k] * 2 + pr.C[k]) / 5;
  return { oreb: avg('oreb'), dreb: avg('dreb'), blk: avg('blk'), ast: avg('ast') };
}

function foulTroubleLimit(periods: number, foulOut: number, period: number, clock: number): number {
  if (periods === 4) {
    if (period === 1) return 2;
    if (period === 2) return 3;
    if (period === 3) return 4;
    return clock > 360 ? 5 : foulOut;
  }
  if (period === 1) return 2;
  return clock > 240 ? foulOut - 1 : foulOut;
}

export function periodName(p: number, periods: number): string {
  if (p > periods) return p - periods === 1 ? 'OT' : `${p - periods}OT`;
  if (periods === 2) return p === 1 ? '1st half' : '2nd half';
  return ['1st', '2nd', '3rd', '4th'][p - 1] + ' quarter';
}
