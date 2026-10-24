export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Beta-binomial style shrinkage of a rate toward a prior mean with `k` pseudo-observations. */
export function shrink(successes: number, trials: number, priorMean: number, k: number): number {
  return (successes + priorMean * k) / (trials + k);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Integer histogram with a fixed offset; values outside the range are clamped into the edge bins. */
export class Hist {
  readonly counts: Float64Array;
  n = 0;
  constructor(readonly min: number, readonly max: number) {
    this.counts = new Float64Array(max - min + 1);
  }
  add(v: number, w = 1) {
    const i = clamp(Math.round(v), this.min, this.max) - this.min;
    this.counts[i] += w;
    this.n += w;
  }
  merge(o: Hist) {
    for (let i = 0; i < this.counts.length; i++) this.counts[i] += o.counts[i];
    this.n += o.n;
  }
  /** P(X >= v) */
  probAtLeast(v: number): number {
    if (!this.n) return 0;
    let s = 0;
    const start = Math.max(0, Math.ceil(v) - this.min);
    for (let i = start; i < this.counts.length; i++) s += this.counts[i];
    return s / this.n;
  }
  /** P(X > v) for possibly fractional lines. */
  probOver(v: number): number {
    return this.probAtLeast(Math.floor(v) + 1);
  }
  probEq(v: number): number {
    if (!this.n || v < this.min || v > this.max) return 0;
    return this.counts[v - this.min] / this.n;
  }
  quantile(q: number): number {
    if (!this.n) return 0;
    let s = 0;
    const target = q * this.n;
    for (let i = 0; i < this.counts.length; i++) {
      s += this.counts[i];
      if (s >= target) return i + this.min;
    }
    return this.max;
  }
  mean(): number {
    if (!this.n) return 0;
    let s = 0;
    for (let i = 0; i < this.counts.length; i++) s += this.counts[i] * (i + this.min);
    return s / this.n;
  }
  sd(): number {
    if (!this.n) return 0;
    const m = this.mean();
    let s = 0;
    for (let i = 0; i < this.counts.length; i++) s += this.counts[i] * (i + this.min - m) ** 2;
    return Math.sqrt(s / this.n);
  }
  toJSON() {
    return { min: this.min, max: this.max, counts: Array.from(this.counts), n: this.n };
  }
  static from(o: { min: number; max: number; counts: number[]; n: number }): Hist {
    const h = new Hist(o.min, o.max);
    h.counts.set(o.counts);
    h.n = o.n;
    return h;
  }
}

/** American odds -> implied probability (with vig). */
export function impliedFromAmerican(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/** Probability -> fair American odds. */
export function americanFromProb(p: number): number {
  const q = clamp(p, 0.001, 0.999);
  return q >= 0.5 ? -Math.round((q / (1 - q)) * 100) : Math.round(((1 - q) / q) * 100);
}

export function fmtAmerican(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function fmtPct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function signed(x: number, digits = 1): string {
  const v = x.toFixed(digits);
  if (Number(v) === 0) return (0).toFixed(digits);
  return x > 0 ? `+${v}` : v;
}
