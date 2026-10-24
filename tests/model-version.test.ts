import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../src/model/build';
import { MODEL_VERSION } from '../src/model/version';
import { runQuick } from '../src/sim/quick';
import { setFetch, setStore } from '../src/data/espn/client';
import { loadGame } from '../src/data/espn/load';
import { leagueAverageGame } from './helpers';

// A fingerprint of the model's output on fixed inputs: hand-built league-average teams, plus a game
// loaded from the ESPN fixtures so loader changes (samples, weighting, rest) count too. When a
// change moves it, update the fingerprint AND bump MODEL_VERSION, so logged predictions and cached
// backtests stay separable.
const base = { outs: new Set<string>(), ins: new Set<string>(), whistle: 1, homeCourt: true, minutesMode: 'projected' as const };
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url), 'utf8'));

async function fingerprint() {
  const rows = (['nba', 'ncaam'] as const).map((league) => leagueAverageGame(league));
  const mem = new Map<string, string>();
  setStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), clearPrefix: () => mem.clear() });
  setFetch((async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    let body: unknown;
    if (u.pathname.endsWith('/summary')) body = fx(u.searchParams.get('event') === '401810131' ? 'synthetic-nba-summary-pregame.json' : 'synthetic-nba-summary-final.json');
    else if (u.pathname.includes('/roster')) body = fx('synthetic-nba-team-roster.json');
    else if (u.pathname.includes('/schedule')) {
      const s = fx('synthetic-nba-team-schedule.json');
      s.events = [{ ...s.events[0], id: '401800001', date: '2026-01-10T00:30Z' }, ...s.events];
      // The home side (NY) played the night before: a back-to-back.
      if (u.pathname.includes('/teams/18/')) s.events.push({ ...s.events[0], id: '401800002', date: '2026-01-16T00:30Z' });
      body = s;
    } else if (u.pathname.endsWith('/gamelog')) body = fx('synthetic-nba-athlete-gamelog-v3.json');
    else if (u.pathname.endsWith('/stats')) body = fx('synthetic-nba-athlete-stats-v3.json');
    return body === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
  const loaded = await loadGame('nba', '401810131', { sampleGames: 3 });
  return [...rows, loaded].map((g, i) => {
    const q = runQuick(buildSpec(g, base).spec, 400, 'fingerprint');
    return [i === 2 ? 'loaded' : g.league, q.homeWin.toFixed(4), q.home.toFixed(2), q.away.toFixed(2)].join(':');
  });
}

describe('model version', () => {
  it('changes only together with the model output', async () => {
    expect({ version: MODEL_VERSION, fingerprint: await fingerprint() }).toEqual({
      version: '1.2.0',
      fingerprint: FINGERPRINT,
    });
  });
});

const FINGERPRINT = ['nba:0.5775:113.50:111.26', 'ncaam:0.5600:72.67:70.97', 'loaded:0.4975:112.34:112.39'];
