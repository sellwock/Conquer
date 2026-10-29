// One row of the slate board: the model's numbers next to the market's for a game with a line,
// plus the best single bet on the game's lines and the best player prop, each clearing the
// parlays tab's bar for singles. Also packs a game's simulated outcomes, props included, small
// enough to cache in the browser.
import { impliedFromAmerican } from '../lib/stats';
import { defaultPickMode, evaluate, legsForGame, weightsFor, HIT_FLOOR, MAX_PRICE, type BlendWeights, type GameMarket, type Leg, type Parlay, type PropMarket } from './parlays';

export interface BoardRow {
  /** Home margin and game total, averaged over the simulations. */
  modelMargin: number;
  modelTotal: number;
  pHome: number;
  /** The market's no-vig home win chance, home margin (minus the spread) and total. */
  fairHome?: number;
  marketMargin?: number;
  marketTotal?: number;
  /** The top single on the game's own lines (moneyline, spread, total), as the parlays tab ranks it by default. */
  best?: Parlay;
  /** The top single among the game's player props, when it has any. */
  bestProp?: Parlay;
  hasProps: boolean;
}

/** The best single among these legs that clears the parlays tab's bar, if any. */
function topSingle(legs: Leg[]): Parlay | undefined {
  let top: Parlay | undefined;
  for (const l of legs) {
    const p = evaluate([l]);
    if (p.ev > 0 && p.pHit >= HIT_FLOOR[1] && p.price <= MAX_PRICE[1] && (!top || p.ev > top.ev)) top = p;
  }
  return top;
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
    ...picks(m, weights),
  };
}

function picks(m: GameMarket, weights: BlendWeights): Pick<BoardRow, 'best' | 'bestProp' | 'hasProps'> {
  const legs = legsForGame(m, weights);
  return { best: topSingle(legs.filter((l) => !l.prop)), bestProp: topSingle(legs.filter((l) => !!l.prop)), hasProps: !!m.props?.length };
}

export interface PackedProp extends Omit<PropMarket, 'hits'> {
  /** The over's result per simulation, 2 bits each, base64. */
  hits: string;
}

export interface PackedMarket extends Omit<GameMarket, 'margin' | 'total' | 'props'> {
  at: number;
  margin: string;
  total: string;
  props?: PackedProp[];
}

/** Props keep only each simulation's result (2 bits), so a game's ~80 lines fit in about 55 KB. */
export function packMarket(m: GameMarket, at: number): PackedMarket {
  const { props, ...rest } = m;
  const packed: PackedMarket = { ...rest, at, margin: toBase64(bytesOf(m.margin)), total: toBase64(bytesOf(m.total)) };
  if (props?.length) packed.props = props.map((p) => ({ ...p, hits: toBase64(pack2(p.hits)) }));
  return packed;
}

export function unpackMarket(p: PackedMarket): GameMarket {
  const { at: _at, props, ...rest } = p;
  const margin = new Int16Array(fromBase64(p.margin).buffer);
  const m: GameMarket = { ...rest, margin, total: new Int16Array(fromBase64(p.total).buffer) };
  if (props?.length) m.props = props.map((x) => ({ ...x, hits: unpack2(fromBase64(x.hits), margin.length) }));
  return m;
}

/** Values 0-3, four to a byte. */
export function pack2(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(a.length / 4));
  for (let i = 0; i < a.length; i++) out[i >> 2] |= (a[i] & 3) << ((i & 3) * 2);
  return out;
}

export function unpack2(b: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (b[i >> 2] >> ((i & 3) * 2)) & 3;
  return out;
}

const bytesOf = (a: Int16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
