// Pairs each posted prop line with the player's stat in every simulation, so the parlay builder
// can score props jointly with the game. Players the simulation gives fewer than MIN_MINUTES are
// left out: their minutes are too uncertain to price, and books void a prop when the player sits.
import type { PropLine } from '../data/espn/props';
import type { PropMarket } from './parlays';
import type { PropStat } from './types';
import type { PlayerOutcomes } from '../sim/run';

export const MIN_MINUTES = 15;

const PARTS: Record<PropStat, ('pts' | 'reb' | 'ast' | 'tpm')[]> = {
  pts: ['pts'],
  reb: ['reb'],
  ast: ['ast'],
  tpm: ['tpm'],
  pra: ['pts', 'reb', 'ast'],
  pr: ['pts', 'reb'],
  pa: ['pts', 'ast'],
  ar: ['reb', 'ast'],
};

export function propMarkets(lines: PropLine[], po: PlayerOutcomes, players: { id: string; short: string; min: number }[]): PropMarket[] {
  const P = po.ids.length;
  if (!P) return [];
  const n = po.pts.length / P;
  const index = new Map(po.ids.map((id, i) => [id, i]));
  const info = new Map(players.map((p) => [p.id, p]));
  const out: PropMarket[] = [];
  for (const l of lines) {
    const j = index.get(l.athleteId);
    const p = info.get(l.athleteId);
    if (j == null || !p || p.min < MIN_MINUTES) continue;
    const values = new Uint8Array(n);
    let sum = 0;
    for (let s = 0; s < n; s++) {
      let v = 0;
      for (const k of PARTS[l.stat]) v += po[k][s * P + j];
      values[s] = Math.min(255, v);
      sum += v;
    }
    out.push({ athleteId: l.athleteId, player: p.short, stat: l.stat, line: l.line, over: l.over, under: l.under, values, mean: sum / n });
  }
  return out;
}
