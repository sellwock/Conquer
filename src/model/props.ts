// Scores each posted prop line in every simulation, so the parlay builder can price props jointly
// with the game. Only the over's result per simulation is kept (the under is its complement), which
// packs into 2 bits per simulation for the slate cache. Players the simulation gives fewer than
// MIN_MINUTES are left out: their minutes are too uncertain to price, and books void a prop when the
// player sits.
import type { PropLine } from '../data/espn/props';
import type { PropMarket } from './parlays';
import type { GameData, PropStat } from './types';
import type { PlayerOutcomes } from '../sim/players';

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

/** `names` maps player ids to short names, e.g. from the game's rosters. */
export function propMarkets(lines: PropLine[], po: PlayerOutcomes, names: Map<string, string>): PropMarket[] {
  const P = po.ids.length;
  if (!P) return [];
  const n = po.pts.length / P;
  const index = new Map(po.ids.map((id, i) => [id, i]));
  const out: PropMarket[] = [];
  for (const l of lines) {
    const j = index.get(l.athleteId);
    const name = names.get(l.athleteId);
    if (j == null || !name || po.min[j] < MIN_MINUTES) continue;
    const hits = new Uint8Array(n);
    let sum = 0;
    for (let s = 0; s < n; s++) {
      let v = 0;
      for (const k of PARTS[l.stat]) v += po[k][s * P + j];
      hits[s] = v > l.line ? 1 : v < l.line ? 0 : 2;
      sum += v;
    }
    out.push({ athleteId: l.athleteId, player: name, stat: l.stat, line: l.line, over: l.over, under: l.under, hits, mean: sum / n });
  }
  return out;
}

export const rosterNames = (g: GameData) => new Map([...g.home.players, ...g.away.players].map((p) => [p.id, p.short]));
