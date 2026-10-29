// One row of the slate board: the model's numbers next to the market's for a game with a line,
// plus the best single the parlays tab would suggest for it. Also packs a game's simulated
// outcomes small enough to cache in the browser.
import { impliedFromAmerican } from '../lib/stats';
import { defaultPickMode, suggestParlays, weightsFor, type BlendWeights, type GameMarket, type Parlay } from './parlays';

export interface BoardRow {
  /** Home margin and game total, averaged over the simulations. */
  modelMargin: number;
  modelTotal: number;
  pHome: number;
  /** The market's no-vig home win chance, home margin (minus the spread) and total. */
  fairHome?: number;
  marketMargin?: number;
  marketTotal?: number;
  /** The top suggested single for this game, exactly as the parlays tab ranks it by default. */
  best?: Parlay;
}

export function boardRow(m: GameMarket, weights: BlendWeights = weightsFor(m.league, defaultPickMode(m.league))): BoardRow {
  const n = Math.max(1, m.margin.length);
  let margin = 0, total = 0, wins = 0;
  for (let i = 0; i < m.margin.length; i++) {
    margin += m.margin[i];
    total += m.total[i];
    if (m.margin[i] > 0) wins++;
  }
  const o = m.odds;
  let fairHome: number | undefined;
  if (o.homeML != null && o.awayML != null) {
    const h = impliedFromAmerican(o.homeML), a = impliedFromAmerican(o.awayML);
    fairHome = h / (h + a);
  }
  return {
    modelMargin: margin / n,
    modelTotal: total / n,
    pHome: wins / n,
    fairHome,
    marketMargin: o.spread != null ? -o.spread : undefined,
    marketTotal: o.total,
    best: suggestParlays([m], 1, weights).bySize[1][0],
  };
}

export interface PackedMarket extends Omit<GameMarket, 'margin' | 'total' | 'props'> {
  at: number;
  margin: string;
  total: string;
}

/** Props stay out of the cache: they're per-sim player lines, far too big for local storage. */
export function packMarket(m: GameMarket, at: number): PackedMarket {
  const { props: _props, ...rest } = m;
  return { ...rest, at, margin: toBase64(m.margin), total: toBase64(m.total) };
}

export function unpackMarket(p: PackedMarket): GameMarket {
  const { at: _at, ...rest } = p;
  return { ...rest, margin: fromBase64(p.margin), total: fromBase64(p.total) };
}

function toBase64(a: Int16Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Int16Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
