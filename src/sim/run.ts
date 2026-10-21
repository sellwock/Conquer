// Runs N simulated games and condenses them into distributions, player projections and the
// single most representative ("typical") game, replayed with a full play-by-play log.
import { makeRng } from '../lib/rng';
import { Hist } from '../lib/stats';
import { simulateGame } from './engine';
import { BF, NBF, type GameResult, type SimSpec } from './types';

type HistJSON = ReturnType<Hist['toJSON']>;

export interface PlayerSummary {
  id: string;
  name: string;
  short: string;
  team: 0 | 1;
  targetMin: number;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  tpm: number;
  stl: number;
  blk: number;
  tov: number;
  pf: number;
  fga: number;
  fta: number;
  foulOutPct: number;
  hists: { pts: HistJSON; reb: HistJSON; ast: HistJSON; tpm: HistJSON; pra: HistJSON };
}

export interface SimSummary {
  n: number;
  seed: string;
  homeWin: number;
  homeScore: number;
  awayScore: number;
  margin: HistJSON;
  total: HistJSON;
  firstHalfMargin: HistJSON;
  otPct: number;
  maxRun: [HistJSON, HistJSON];
  largestLead: [HistJSON, HistJSON];
  leadChanges: number;
  periodMeans: [number, number][];
  possessions: number;
  players: PlayerSummary[];
  typical: { index: number; result: SerializedResult };
  elapsedMs: number;
}

export type SerializedResult = Omit<GameResult, 'box'> & { box: [number[], number[]] };

export function serializeResult(r: GameResult): SerializedResult {
  return { ...r, box: [Array.from(r.box[0]), Array.from(r.box[1])] };
}

export function runSims(spec: SimSpec, n: number, seed: string, onProgress?: (done: number) => void): SimSummary {
  const t0 = Date.now();
  const lg = spec.league;
  const ptsMax = lg.id === 'nba' ? 200 : 140;
  const margin = new Hist(-80, 80);
  const total = new Hist(lg.id === 'nba' ? 120 : 60, lg.id === 'nba' ? 330 : 220);
  const firstHalf = new Hist(-60, 60);
  const maxRun: [Hist, Hist] = [new Hist(0, 60), new Hist(0, 60)];
  const largestLead: [Hist, Hist] = [new Hist(0, 80), new Hist(0, 80)];
  const periodSum: [number, number][] = Array.from({ length: lg.periods }, () => [0, 0]);
  let homeWins = 0, ot = 0, leadChanges = 0, possSum = 0, homeSum = 0, awaySum = 0;

  const teams = [spec.home, spec.away] as const;
  const np = [teams[0].players.length, teams[1].players.length];
  const sums = [new Float64Array(np[0] * NBF), new Float64Array(np[1] * NBF)];
  const foulOuts = [new Float64Array(np[0]), new Float64Array(np[1])];
  const mk = () => ({ pts: new Hist(0, 80), reb: new Hist(0, 35), ast: new Hist(0, 25), tpm: new Hist(0, 15), pra: new Hist(0, 110) });
  const hists = [teams[0].players.map(mk), teams[1].players.map(mk)];

  const simMargin = new Int16Array(n);
  const simTotal = new Int16Array(n);
  const simPts = new Int16Array(n * (np[0] + np[1]));

  for (let s = 0; s < n; s++) {
    const r = simulateGame(spec, makeRng(seed, s));
    const m = r.score[0] - r.score[1];
    simMargin[s] = m;
    simTotal[s] = r.score[0] + r.score[1];
    if (m > 0) homeWins++;
    homeSum += r.score[0];
    awaySum += r.score[1];
    margin.add(m);
    total.add(Math.min(r.score[0] + r.score[1], ptsMax * 2));
    if (r.ot) ot++;
    leadChanges += r.leadChanges;
    possSum += (r.possessions[0] + r.possessions[1]) / 2;
    const half = lg.periods / 2;
    let h1 = 0;
    for (let p = 0; p < r.periodScores.length; p++) {
      if (p < half) h1 += r.periodScores[p][0] - r.periodScores[p][1];
      if (p < lg.periods) {
        periodSum[p][0] += r.periodScores[p][0];
        periodSum[p][1] += r.periodScores[p][1];
      }
    }
    if (!spec.start || spec.start.period <= half) firstHalf.add(h1 + (spec.start && spec.start.period <= half ? spec.start.homeScore - spec.start.awayScore : 0));
    for (let t = 0; t < 2; t++) {
      maxRun[t].add(r.maxRun[t]);
      largestLead[t].add(r.largestLead[t]);
      const box = r.box[t];
      const acc = sums[t];
      for (let k = 0; k < box.length; k++) acc[k] += box[k];
      for (const i of r.fouledOut[t]) foulOuts[t][i]++;
      for (let i = 0; i < np[t]; i++) {
        const o = i * NBF;
        const pts = box[o + BF.pts], reb = box[o + BF.oreb] + box[o + BF.dreb], ast = box[o + BF.ast];
        const h = hists[t][i];
        h.pts.add(pts);
        h.reb.add(reb);
        h.ast.add(ast);
        h.tpm.add(box[o + BF.tpm]);
        h.pra.add(pts + reb + ast);
        simPts[s * (np[0] + np[1]) + (t === 0 ? i : np[0] + i)] = pts;
      }
    }
    if (onProgress && (s + 1) % 250 === 0) onProgress(s + 1);
  }

  const players: PlayerSummary[] = [];
  for (let t = 0; t < 2; t++) {
    teams[t].players.forEach((p, i) => {
      const o = i * NBF;
      const a = sums[t];
      players.push({
        id: p.id,
        name: p.name,
        short: p.short,
        team: t as 0 | 1,
        targetMin: p.targetMin,
        min: a[o + BF.sec] / 60 / n,
        pts: a[o + BF.pts] / n,
        reb: (a[o + BF.oreb] + a[o + BF.dreb]) / n,
        ast: a[o + BF.ast] / n,
        tpm: a[o + BF.tpm] / n,
        stl: a[o + BF.stl] / n,
        blk: a[o + BF.blk] / n,
        tov: a[o + BF.tov] / n,
        pf: a[o + BF.pf] / n,
        fga: a[o + BF.fga] / n,
        fta: a[o + BF.fta] / n,
        foulOutPct: foulOuts[t][i] / n,
        hists: {
          pts: hists[t][i].pts.toJSON(),
          reb: hists[t][i].reb.toJSON(),
          ast: hists[t][i].ast.toJSON(),
          tpm: hists[t][i].tpm.toJSON(),
          pra: hists[t][i].pra.toJSON(),
        },
      });
    });
  }

  const typicalIndex = pickTypical(n, simMargin, simTotal, simPts, players, margin, total);
  const typical = simulateGame(spec, makeRng(seed, typicalIndex), true);

  return {
    n,
    seed,
    homeWin: homeWins / n,
    homeScore: homeSum / n,
    awayScore: awaySum / n,
    margin: margin.toJSON(),
    total: total.toJSON(),
    firstHalfMargin: firstHalf.toJSON(),
    otPct: ot / n,
    maxRun: [maxRun[0].toJSON(), maxRun[1].toJSON()],
    largestLead: [largestLead[0].toJSON(), largestLead[1].toJSON()],
    leadChanges: leadChanges / n,
    periodMeans: periodSum.map(([h, a]) => [h / n, a / n] as [number, number]),
    possessions: possSum / n,
    players,
    typical: { index: typicalIndex, result: serializeResult(typical) },
    elapsedMs: Date.now() - t0,
  };
}

/**
 * The "most typical game": the simulation closest to the median margin and total, with the
 * rotation players' scoring close to their averages. The winner matches the more likely winner.
 */
function pickTypical(
  n: number,
  simMargin: Int16Array,
  simTotal: Int16Array,
  simPts: Int16Array,
  players: PlayerSummary[],
  margin: Hist,
  total: Hist,
): number {
  const medM = margin.quantile(0.5) || (margin.mean() >= 0 ? 1 : -1);
  const medT = total.quantile(0.5);
  const sdM = Math.max(1, margin.sd());
  const sdT = Math.max(1, total.sd());
  const key = players.map((p, idx) => ({ p, idx })).filter(({ p }) => p.min >= 18);
  const sdP = key.map(({ p }) => Math.max(2, Hist.from(p.hists.pts).sd()));
  const width = players.length;
  let best = 0, bestD = Infinity;
  for (let s = 0; s < n; s++) {
    if (Math.sign(simMargin[s]) !== Math.sign(medM)) continue;
    let d = ((simMargin[s] - medM) / sdM) ** 2 + ((simTotal[s] - medT) / sdT) ** 2;
    let pd = 0;
    key.forEach(({ p, idx }, k) => {
      pd += ((simPts[s * width + idx] - p.pts) / sdP[k]) ** 2;
    });
    if (key.length) d += (0.6 * pd) / key.length;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Win probability from a game state using the simulated per-game margin distribution. */
export function stateWinProb(lead: number, fracRemaining: number, meanMargin: number, sdMargin: number): number {
  if (fracRemaining <= 1e-4) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5;
  const mu = lead + meanMargin * fracRemaining;
  const sd = Math.max(0.5, sdMargin * Math.sqrt(fracRemaining));
  // Normal approximation with continuity correction (ties go to overtime ~ 50/50).
  const z = mu / sd;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
