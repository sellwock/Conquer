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
