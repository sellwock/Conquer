import { americanFromProb, fmtAmerican, signed } from '../lib/stats';

export const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
export const one = (x: number) => x.toFixed(1);
export const int = (x: number) => Math.round(x).toString();
export const fair = (p: number) => fmtAmerican(americanFromProb(p));
export const thousands = (n: number) => n.toLocaleString('en-US');

export function spreadText(abbr: string, margin: number): string {
  if (Math.abs(margin) < 0.05) return 'Pick’em';
  return `${abbr} ${margin > 0 ? '-' : '+'}${Math.abs(margin).toFixed(1)}`;
}

/** A home margin as "BOS -3.5", naming whichever side is favored. */
export const lineText = (home: string, away: string, homeMargin: number) => (homeMargin >= 0 ? spreadText(home, homeMargin) : spreadText(away, -homeMargin));

/** Minutes after which a live line is too old to bet without checking the book. */
export const STALE_LINE_MIN = 5;

/** Whole minutes since the book last changed a line, or undefined when the feed doesn't say. */
export function lineAgeMin(updated: string | undefined, now = Date.now()): number | undefined {
  const t = updated ? Date.parse(updated) : NaN;
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((now - t) / 60_000));
}

/** "just now", "4 min", "1 h 12 min" */
export const ageText = (min: number) => (min < 1 ? 'just now' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);

/** A signed share as "+2.7%" or "−10.5%". */
export const signedPct = (x: number, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${pct(Math.abs(x), d)}`;

/** Expected profit as "+$4 per $100". */
export function perHundred(ev: number): string {
  const v = Math.round(ev * 100);
  return `${v >= 0 ? '+' : '−'}$${Math.abs(v)} per $100`;
}

export function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function parseYmd(s: string): Date {
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

export function dateLabel(s: string): string {
  return parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function tipTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export const signed1 = (x: number) => signed(x, 1);
