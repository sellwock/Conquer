// Team colors are identity, so we use them when they read on the surface and stay distinct from
// each other; otherwise we fall back to the alternate color, then to a validated categorical pair.

const FALLBACK = { light: ['#2a78d6', '#eb6834'], dark: ['#3987e5', '#d95926'] };

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a), [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

const valid = (c?: string) => !!c && /^#[0-9a-f]{6}$/i.test(c);

function mix(hex: string, toward: string, t: number): string {
  const a = hexToRgb(hex), b = hexToRgb(toward);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** Lightens (dark surface) or darkens (light surface) a team color until it reads, keeping its hue. */
function fitToSurface(c: string, surface: string, dark: boolean): string | null {
  if (!valid(c)) return null;
  for (let t = 0; t <= 0.7; t += 0.05) {
    const v = t === 0 ? c : mix(c, dark ? '#ffffff' : '#000000', t);
    if (contrast(v, surface) >= 2.6) return v;
  }
  return null;
}

/** Picks [home, away] mark colors for a surface. */
export function teamPair(home: { color: string; altColor: string }, away: { color: string; altColor: string }, surface: string, dark: boolean): [string, string] {
  const ok = (c?: string | null) => !!c && valid(c) && contrast(c, surface) >= 2.2;
  const pick = (t: { color: string; altColor: string }) => {
    const fitted = fitToSurface(t.color, surface, dark);
    // Near-white or near-black brand colors carry no hue to keep; prefer the alternate then.
    const flat = valid(t.color) && (contrast(t.color, '#ffffff') < 1.25 || contrast(t.color, '#000000') < 1.25);
    if (fitted && !flat) return fitted;
    return ok(t.altColor) ? t.altColor : fitted;
  };
  let h = pick(home);
  let a = pick(away);
  if (h && a && deltaE(h, a) < 18) {
    const alt = ok(away.altColor) && deltaE(h, away.altColor) >= 18 ? away.altColor : null;
    a = alt;
  }
  const fb = dark ? FALLBACK.dark : FALLBACK.light;
  if (!h) h = a && deltaE(a, fb[0]) >= 18 ? fb[0] : fb[1];
  if (!a) a = deltaE(h, fb[1]) >= 18 ? fb[1] : fb[0];
  return [h, a];
}

export function prefersDark(): boolean {
  const root = document.documentElement;
  const t = root.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Text color (ink) that reads on a given fill. */
export function inkOn(fill: string): string {
  return contrast(fill, '#ffffff') >= contrast(fill, '#10151b') ? '#ffffff' : '#10151b';
}
