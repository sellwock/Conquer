// Turns a simulation run into the compact prediction record the log stores.
import { Hist } from '../lib/stats';
import type { BuiltSpec } from '../model/build';
import { MODEL_VERSION } from '../model/version';
import type { SimSummary } from '../sim/run';
import { pmfFromCounts } from './grade';
import type { Prediction } from './types';

export function predictionFrom(s: SimSummary, built: BuiltSpec, takenAt: Date, tip: string): Prediction {
  const margin = Hist.from(s.margin);
  const total = Hist.from(s.total);
  return {
    model: MODEL_VERSION,
    takenAt: takenAt.toISOString(),
    minsToTip: Math.round((Date.parse(tip) - takenAt.getTime()) / 60000),
    n: s.n,
    homeWin: round(s.homeWin, 4),
    meanMargin: round(margin.mean(), 2),
    meanTotal: round(total.mean(), 2),
    otPct: round(s.otPct, 4),
    marginPmf: pmfFromCounts(margin.min, margin.counts),
    totalPmf: pmfFromCounts(total.min, total.counts),
    outs: [...built.plans.home.unavailable, ...built.plans.away.unavailable].sort(),
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
