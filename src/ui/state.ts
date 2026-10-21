// Shareable URL state. Keeps compatibility with links of the form
//   #game=401909088&date=20261020&out=1642269
// (unknown player ids are reported and ignored).
import type { LeagueId } from '../model/types';
import type { MinutesMode } from '../model/build';

export type Tab = 'outlook' | 'typical' | 'players' | 'flow' | 'method';
export const TABS: Tab[] = ['outlook', 'typical', 'players', 'flow', 'method'];

export interface UrlState {
  league: LeagueId;
  date?: string;
  game?: string;
  outs: string[];
  ins: string[];
  n: number;
  seed: string;
  whistle: number;
  hca: boolean;
  mode: MinutesMode;
  /** 'tip' (whole game), 'now' (live state) or a play sequence number. */
  from: string;
  tab: Tab;
}

export const SIM_COUNTS = [1000, 5000, 10000, 25000];

export const DEFAULTS: UrlState = {
  league: 'nba',
  outs: [],
  ins: [],
  n: 5000,
  seed: 'tipoff',
  whistle: 1,
  hca: true,
  mode: 'projected',
  from: 'tip',
  tab: 'outlook',
};

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function parseHash(hash: string): UrlState {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const league = q.get('league') === 'ncaam' ? 'ncaam' : 'nba';
  const n = Number(q.get('n'));
  const whistle = Number(q.get('whistle'));
  const tab = q.get('tab') as Tab;
  const date = q.get('date') ?? undefined;
  return {
    league,
    date: date && /^\d{8}$/.test(date) ? date : undefined,
    game: q.get('game') ?? undefined,
    outs: list(q.get('out')),
    ins: list(q.get('in')),
    n: SIM_COUNTS.includes(n) ? n : DEFAULTS.n,
    seed: (q.get('seed') ?? DEFAULTS.seed).slice(0, 24) || DEFAULTS.seed,
    whistle: whistle >= 0.7 && whistle <= 1.35 ? whistle : DEFAULTS.whistle,
    hca: q.get('hca') !== '0',
    mode: q.get('mode') === 'actual' ? 'actual' : 'projected',
    from: q.get('from') ?? 'tip',
    tab: TABS.includes(tab) ? tab : DEFAULTS.tab,
  };
}

export function toHash(s: UrlState): string {
  const q = new URLSearchParams();
  if (s.league !== 'nba') q.set('league', s.league);
  if (s.game) q.set('game', s.game);
  if (s.date) q.set('date', s.date);
  if (s.outs.length) q.set('out', s.outs.join(','));
  if (s.ins.length) q.set('in', s.ins.join(','));
  if (s.n !== DEFAULTS.n) q.set('n', String(s.n));
  if (s.seed !== DEFAULTS.seed) q.set('seed', s.seed);
  if (s.whistle !== 1) q.set('whistle', s.whistle.toFixed(2));
  if (!s.hca) q.set('hca', '0');
  if (s.mode !== 'projected') q.set('mode', s.mode);
  if (s.from !== 'tip') q.set('from', s.from);
  if (s.tab !== 'outlook') q.set('tab', s.tab);
  return '#' + q.toString().replace(/%2C/g, ',');
}
