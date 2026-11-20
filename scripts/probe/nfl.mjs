// Temporary probe of ESPN's NFL feeds (and the NBA in-game prop feed), run on GitHub Actions.
// Writes trimmed responses and a summary to data/probe-nfl/.
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT = 'data/probe-nfl';
mkdirSync(OUT, { recursive: true });
const md = [];
const say = (s) => { console.log(s); md.push(s); };
const save = (name, obj) => writeFileSync(`${OUT}/${name}`, JSON.stringify(obj, null, 1));
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const now = Date.now();

async function propsOf(sport, league, id, liveOnly) {
  const odds = await get(`${CORE}/${sport}/leagues/${league}/events/${id}/competitions/${id}/odds?lang=en&region=us`);
  const books = (odds?.items ?? []).map((it) => ({ name: it?.provider?.name, id: it?.provider?.id, props: !!it?.propBets?.$ref, ref: it?.propBets?.$ref, it }));
  const out = { books: books.map((b) => `${b.name} (${b.id})${b.props ? ' +props' : ''}`), byBook: {} };
  for (const b of books) {
    if (!b.ref) continue;
    const live = /live/i.test(b.name ?? '');
    if (liveOnly != null && live !== liveOnly) continue;
    const items = [];
    const u = new URL(b.ref);
    for (let page = 1, pages = 1; page <= pages && page <= 6; page++) {
      u.searchParams.set('limit', '1000');
      u.searchParams.set('page', String(page));
      const j = await get(u.toString().replace('http://', 'https://'));
      items.push(...(j?.items ?? []));
      pages = Number(j?.pageCount) || 1;
    }
    const types = {};
    for (const x of items) {
      const k = `${x?.type?.id}:${x?.type?.name}`;
      types[k] = (types[k] ?? 0) + 1;
    }
    const ages = items.map((x) => (x?.lastUpdated ? Math.round((now - Date.parse(x.lastUpdated)) / 60000) : null));
    const known = ages.filter((a) => a != null).sort((a, c) => a - c);
    out.byBook[b.name] = { items: items.length, types, withLastUpdated: known.length, ageMinMedianMax: known.length ? [known[0], known[known.length >> 1], known[known.length - 1]] : null, sample: items.slice(0, 40), gameLines: { details: b.it.details, spread: b.it.spread, overUnder: b.it.overUnder } };
  }
  return out;
}

// --- NFL ---------------------------------------------------------------------------------------
const sb = await get(`${SITE}/football/nfl/scoreboard`);
save('nfl-scoreboard.json', sb);
const evs = sb?.events ?? [];
say(`## NFL scoreboard: ${evs.length} events, season ${sb?.season?.year} type ${sb?.season?.type} week ${sb?.week?.number}`);
for (const e of evs) say(`- ${e.id} ${e.date} ${e.status?.type?.state} ${e.status?.type?.shortDetail} ${e.shortName}`);

const live = evs.filter((e) => e.status?.type?.state === 'in');
const pre = evs.filter((e) => e.status?.type?.state === 'pre');
for (const e of live.slice(0, 2)) {
  const p = await propsOf('football', 'nfl', e.id);
  save(`nfl-live-${e.id}-props.json`, p);
  say(`\n### NFL live ${e.shortName} (${e.status?.type?.shortDetail}): books ${p.books.join(', ')}`);
  for (const [b, v] of Object.entries(p.byBook)) say(`- ${b}: ${v.items} items, lastUpdated on ${v.withLastUpdated}, age min/median/max ${JSON.stringify(v.ageMinMedianMax)} min; lines ${JSON.stringify(v.gameLines)}\n  types ${JSON.stringify(v.types)}`);
  const s = await get(`${SITE}/football/nfl/summary?event=${e.id}`);
  if (s) save(`nfl-summary-live-${e.id}.json`, { header: s.header, boxscore: s.boxscore });
}
for (const e of pre.slice(0, 1)) {
  const p = await propsOf('football', 'nfl', e.id);
  save(`nfl-pre-${e.id}-props.json`, p);
  say(`\n### NFL upcoming ${e.shortName} ${e.date}: books ${p.books.join(', ')}`);
  for (const [b, v] of Object.entries(p.byBook)) say(`- ${b}: ${v.items} items, lastUpdated on ${v.withLastUpdated}; lines ${JSON.stringify(v.gameLines)}\n  types ${JSON.stringify(v.types)}`);
  const s = await get(`${SITE}/football/nfl/summary?event=${e.id}`);
  if (s) save(`nfl-summary-pre-${e.id}.json`, { header: s.header, boxscore: s.boxscore, pickcenter: s.pickcenter, injuries: s.injuries });
}

// Finished games this season: are prop lines kept?
const year = sb?.season?.year ?? 2026;
const week = sb?.week?.number ?? 12;
const kept = [];
let savedFinal = false;
for (const w of [1, 3, 5, 7, 9, week - 1].filter((x) => x >= 1 && x < week)) {
  const ws = await get(`${SITE}/football/nfl/scoreboard?dates=${year}&seasontype=2&week=${w}`);
  const fin = (ws?.events ?? []).filter((e) => e.status?.type?.completed);
  let withProps = 0, items = 0;
  const providers = new Set();
  for (const e of fin.slice(0, 4)) {
    const p = await propsOf('football', 'nfl', e.id, false);
    p.books.forEach((b) => providers.add(b));
    const n = Object.values(p.byBook).reduce((a, v) => a + v.items, 0);
    if (n) withProps++;
    items += n;
    if (n && !savedFinal) {
      savedFinal = true;
      save(`nfl-final-${e.id}-props.json`, p);
      const s = await get(`${SITE}/football/nfl/summary?event=${e.id}`);
      if (s) save(`nfl-summary-final-${e.id}.json`, { header: s.header, boxscore: s.boxscore, pickcenter: s.pickcenter });
      // One player from each box category, and their game log.
      const cats = s?.boxscore?.players?.[0]?.statistics ?? [];
      say(`\n### Final box score ${e.shortName}: categories ${cats.map((c) => `${c.name}[${(c.keys ?? c.labels ?? []).join(',')}]`).join(' | ')}`);
      const qb = cats.find((c) => c.name === 'passing')?.athletes?.[0]?.athlete;
      const wr = cats.find((c) => c.name === 'receiving')?.athletes?.[0]?.athlete;
      for (const a of [qb, wr].filter(Boolean)) {
        const gl = await get(`${WEB}/football/nfl/athletes/${a.id}/gamelog`);
        if (gl) save(`nfl-gamelog-${a.id}.json`, gl);
        say(`- gamelog ${a.displayName} (${a.id}): ${gl ? `names ${JSON.stringify(gl.names ?? gl.labels)}; ${Object.keys(gl.events ?? {}).length} events` : 'none'}`);
      }
      const teamId = s?.boxscore?.players?.[0]?.team?.id;
      const roster = teamId ? await get(`${SITE}/football/nfl/teams/${teamId}/roster`) : null;
      if (roster) save(`nfl-roster-${teamId}.json`, roster);
      say(`- roster team ${teamId}: ${roster ? (roster.athletes ?? []).map((g) => `${g.position ?? g.name}:${(g.items ?? []).length}`).join(', ') : 'none'}`);
    }
  }
  kept.push(`week ${w}: ${withProps} of ${Math.min(4, fin.length)} finished games have pre-game props kept (${items} items); books ${[...providers].join(', ')}`);
}
say(`\n### Kept prop lines for finished games\n${kept.map((k) => `- ${k}`).join('\n')}`);

// --- NBA in-game feed: lastUpdated? ------------------------------------------------------------------
const nsb = await get(`${SITE}/basketball/nba/scoreboard`);
const nlive = (nsb?.events ?? []).filter((e) => e.status?.type?.state === 'in');
say(`\n## NBA: ${nlive.length} games in progress`);
for (const e of nlive.slice(0, 2)) {
  const p = await propsOf('basketball', 'nba', e.id, true);
  save(`nba-live-${e.id}-props.json`, { ...p, byBook: Object.fromEntries(Object.entries(p.byBook).map(([k, v]) => [k, { ...v, sample: v.sample.slice(0, 6) }])) });
  say(`- ${e.shortName} (${e.status?.type?.shortDetail}): books ${p.books.join(', ')}`);
  for (const [b, v] of Object.entries(p.byBook)) say(`  - ${b}: ${v.items} items, lastUpdated on ${v.withLastUpdated}, age min/median/max ${JSON.stringify(v.ageMinMedianMax)} min`);
}
writeFileSync(`${OUT}/summary.md`, md.join('\n') + '\n');
