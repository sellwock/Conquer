// Which NFL prop types carry prices? Counts items with and without odds per type, for one upcoming
// game and one finished game, and keeps a few priced items of each type.
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT = 'data/probe-nfl';
mkdirSync(OUT, { recursive: true });
const get = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u.replace('http://', 'https://')); if (r.ok) return r.json(); if (r.status === 404) return null; } catch {} await new Promise((s) => setTimeout(s, 1000)); } return null; };
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const md = [];
for (const id of ['401873070', '401872656', '401873066']) {
  const odds = await get(`${CORE}/events/${id}/competitions/${id}/odds?lang=en&region=us`);
  for (const b of odds?.items ?? []) {
    if (!b?.propBets?.$ref) continue;
    const items = [];
    const u = new URL(b.propBets.$ref.replace('http://', 'https://'));
    for (let p = 1, n = 1; p <= n && p <= 8; p++) {
      u.searchParams.set('limit', '1000');
      u.searchParams.set('page', String(p));
      const j = await get(u.toString());
      items.push(...(j?.items ?? []));
      n = Number(j?.pageCount) || 1;
    }
    const by = {};
    for (const it of items) {
      const k = `${it?.type?.id}:${it?.type?.name}`;
      by[k] ??= { n: 0, priced: 0, samples: [] };
      by[k].n++;
      if (it.odds) {
        by[k].priced++;
        if (by[k].samples.length < 4) by[k].samples.push({ athlete: it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1], odds: it.odds, current: it.current, lastUpdated: it.lastUpdated });
      }
    }
    md.push(`## ${id} ${b.provider?.name}: ${items.length} items, ${items.filter((x) => x.odds).length} priced`);
    for (const [k, v] of Object.entries(by)) md.push(`- ${k}: ${v.priced}/${v.n} priced${v.samples[0] ? ` e.g. ${JSON.stringify(v.samples[0].odds?.american)} at ${JSON.stringify(v.samples[0].current?.target?.value)}` : ''}`);
    writeFileSync(`${OUT}/odds-${id}-${b.provider?.id}.json`, JSON.stringify(by, null, 1));
  }
}
writeFileSync(`${OUT}/odds-summary.md`, md.join('\n') + '\n');
console.log(md.join('\n'));
