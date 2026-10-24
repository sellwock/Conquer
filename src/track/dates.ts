/** yyyymmdd of an instant in US Eastern time, which is how ESPN's scoreboard splits days. */
export function easternYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/** The `days` Eastern dates before `end` (exclusive), newest first. */
export function daysBefore(end: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => easternYmd(new Date(end.getTime() - (i + 1) * 86_400_000)));
}
