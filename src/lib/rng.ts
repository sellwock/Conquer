// Seeded, splittable PRNG. Every simulated game gets its own stream derived from
// (seed, index), so any single game can be replayed exactly (used for the "typical game").

export type Rng = () => number;

/** xmur3-style string hash -> uint32. */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** sfc32: small fast counter PRNG with a 128-bit state. */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed: string, index = 0): Rng {
  const base = `${seed}#${index}`;
  const rng = sfc32(hashString(base), hashString(base + 'b'), hashString(base + 'c'), hashString(base + 'd'));
  for (let i = 0; i < 12; i++) rng(); // warm up
  return rng;
}

/** Index drawn with probability proportional to weights[i]. Returns -1 if all weights are 0. */
export function pickWeighted(rng: Rng, weights: ArrayLike<number>, count = weights.length): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += weights[i];
  if (!(total > 0)) return -1;
  let r = rng() * total;
  for (let i = 0; i < count; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  for (let i = count - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** Gamma(k, theta) for small integer k (sum of exponentials). */
export function gammaInt(rng: Rng, k: number, theta: number): number {
  let p = 1;
  for (let i = 0; i < k; i++) p *= 1 - rng();
  return -Math.log(p) * theta;
}

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function randomSeed(): string {
  return Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
}
