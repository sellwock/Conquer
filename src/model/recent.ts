// Per-game averages over a player's recent game lines, for the "Last 5" tab. Shooting
// percentages come from total makes over total attempts, not an average of each game's percentage.
import type { GameLogLine } from './types';

export interface LineAverages {
  games: number;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  tpm: number;
  stl: number;
  blk: number;
  tov: number;
  /** Points + rebounds + assists. */
  pra: number;
  /** Undefined when there were no attempts. */
  fgPct?: number;
  tpPct?: number;
  ftPct?: number;
}

export function averageLines(lines: GameLogLine[]): LineAverages | undefined {
  const n = lines.length;
  if (!n) return undefined;
  const sum = (f: (l: GameLogLine) => number) => lines.reduce((a, l) => a + f(l), 0);
  const ratio = (made: number, att: number) => (att > 0 ? made / att : undefined);
  const pts = sum((l) => l.box.pts) / n;
  const reb = sum((l) => l.box.oreb + l.box.dreb) / n;
  const ast = sum((l) => l.box.ast) / n;
  return {
    games: n,
    min: sum((l) => l.box.min) / n,
    pts,
    reb,
    ast,
    tpm: sum((l) => l.box.tpm) / n,
    stl: sum((l) => l.box.stl) / n,
    blk: sum((l) => l.box.blk) / n,
    tov: sum((l) => l.box.tov) / n,
    pra: pts + reb + ast,
    fgPct: ratio(sum((l) => l.box.fgm), sum((l) => l.box.fga)),
    tpPct: ratio(sum((l) => l.box.tpm), sum((l) => l.box.tpa)),
    ftPct: ratio(sum((l) => l.box.ftm), sum((l) => l.box.fta)),
  };
}
