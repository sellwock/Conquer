// Anchors a game's simulation to the book's spread and total. The book's game lines are sharper
// than the simulation's (in backtests its margin missed by about 10.7 points to the simulation's
// 12.1), and a player's line rides on his team's scoring, so props are priced from a simulation
// whose average score matches the book's. Only the level moves: who scores, and how the game
// varies around that level, stay the simulation's own.
import { runQuick } from './quick';
import type { SimSpec } from './types';

export interface AnchorTarget {
  /** The book's home margin (minus the home spread) and total; either can be missing. */
  margin?: number;
  total?: number;
}

export interface AnchorOptions {
  /** Share of a total gap closed by pace; the rest by shot-making. Margin is always shot-making. */
  paceShare?: number;
  sims?: number;
  rounds?: number;
  /** Average home and away points of a spec; defaults to a quick batch of simulations. */
  measure?: (spec: SimSpec, n: number, seed: string) => { home: number; away: number };
}

export interface Anchored {
  spec: SimSpec;
  /** Average points before anchoring, and what it aimed for. */
  before: { home: number; away: number };
  target: { home: number; away: number };
}

/** A team can be moved this far from where the simulation had it, and no further. */
const MAX_SHIFT = 0.15;
const clamp = (x: number) => Math.min(1 + MAX_SHIFT, Math.max(1 - MAX_SHIFT, x));
/** Makes are most of scoring but not all (free throws don't move), so a gap takes a bit more than its size in make rate. */
const MAKE_POWER = 1.2;

/**
 * The spec with each team's make rate (and, by `paceShare`, the pace) scaled until the simulated
 * average score matches the book's. A missing margin or total keeps the simulation's own.
 */
export function anchorSpec(spec: SimSpec, target: AnchorTarget, seed: string, opts: AnchorOptions = {}): Anchored {
  const measure = opts.measure ?? ((s, n, sd) => runQuick(s, n, sd));
  const sims = opts.sims ?? 400, rounds = opts.rounds ?? 3, paceShare = opts.paceShare ?? 0;
  const before = measure(spec, sims, `${seed}-anchor`);
  const margin = target.margin ?? before.home - before.away, total = target.total ?? before.home + before.away;
  const want = { home: (total + margin) / 2, away: (total - margin) / 2 };
  let cur = spec, got = before;
  let home = 1, away = 1, pace = 1;
  for (let r = 0; r < rounds; r++) {
    // The total's gap is split between pace and makes; what's left of each team's gap is makes.
    const p = ((want.home + want.away) / (got.home + got.away)) ** paceShare;
    pace = clamp(pace * p);
    home = clamp(home * (want.home / (got.home * p)) ** MAKE_POWER);
    away = clamp(away * (want.away / (got.away * p)) ** MAKE_POWER);
    cur = { ...spec, pace: spec.pace * pace, home: { ...spec.home, makeMult: spec.home.makeMult * home }, away: { ...spec.away, makeMult: spec.away.makeMult * away } };
    if (r < rounds - 1) got = measure(cur, sims, `${seed}-anchor`);
  }
  return { spec: cur, before, target: want };
}
