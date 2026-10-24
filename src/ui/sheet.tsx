import { useMemo, useState } from 'preact/hooks';
import { planMinutes } from '../model/build';
import { LEAGUES } from '../model/leagues';
import type { GameData, PlayerProfile, TeamProfile } from '../model/types';
import { randomSeed } from '../lib/rng';
import { periodName } from '../sim/engine';
import { SIM_COUNTS, type UrlState } from './state';
import type { Palette, SimState } from './app';

type Status = { kind: 'in' | 'out-injury' | 'out-user' | 'cleared' | 'dnp'; label: string };

function statusOf(p: PlayerProfile, url: UrlState, asPlayed: boolean): Status {
  if (asPlayed && p.actual) return p.actual.played ? { kind: 'in', label: 'Played' } : { kind: 'dnp', label: 'Did not play' };
  if (url.outs.includes(p.id)) return { kind: 'out-user', label: 'Out (your call)' };
  if (p.injury?.out) return url.ins.includes(p.id) ? { kind: 'cleared', label: `Cleared · ${p.injury.status}` } : { kind: 'out-injury', label: p.injury.status };
  return { kind: 'in', label: p.injury ? p.injury.status : 'Available' };
}

function Roster(props: { team: TeamProfile; color: string; game: GameData; url: UrlState; sim: SimState; asPlayed: boolean; onToggle: (id: string, injuredOut: boolean) => void }) {
  const { team, sim, url } = props;
  const lg = LEAGUES[props.game.league];
  const side = team.id === props.game.home.id ? 'home' : 'away';
  const plan = sim.built?.plans[side];
  const healthy = useMemo(
    () => (sim.options ? planMinutes(team, lg, { ...sim.options, healthy: true, minutesMode: 'projected' }) : undefined),
    [team, sim.options],
  );
  const rows = [...team.players].sort((a, b) => (plan?.minutes[b.id] ?? 0) - (plan?.minutes[a.id] ?? 0) || (healthy?.minutes[b.id] ?? 0) - (healthy?.minutes[a.id] ?? 0));
  return (
    <div class="roster">
      <h3 class="roster-head" style={{ '--team': props.color } as Record<string, string>}>
        <span>{team.name}</span>
        <small>{team.source}</small>
      </h3>
      <table class="roster-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col" class="num">
              Min
            </th>
            <th scope="col" class="num">
              <span class="sr-only">Change vs everyone available</span>±
            </th>
            <th scope="col" class="toggle-col">
              Plays
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const st = statusOf(p, url, props.asPlayed);
            const m = plan?.minutes[p.id] ?? 0;
            const d = healthy && !props.asPlayed ? m - (healthy.minutes[p.id] ?? 0) : 0;
            const isOut = st.kind === 'out-injury' || st.kind === 'out-user' || st.kind === 'dnp';
            const starter = plan?.starters.has(p.id);
            return (
              <tr key={p.id} class={isOut ? 'is-out' : ''}>
                <th scope="row">
                  <span class="pl-name">
                    {p.jersey != null && <span class="jersey">{p.jersey}</span>}
                    <span title={p.name}>{p.short}</span>
                    <span class="pos">{p.pos}</span>
                    {starter && !isOut && <span class="starter" title="Projected starter">S</span>}
                  </span>
                  <span class="pl-meta">
                    {st.kind !== 'in' || p.injury ? <span class={`pill ${st.kind}`}>{st.label}</span> : null}
                    {p.injury?.detail && st.kind !== 'in' && <span class="inj-detail">{p.injury.detail}</span>}
                    {p.source !== team.source && !p.source.startsWith('Last') && (
                      <span class="src" title="Where this player's ratings come from">
                        {p.source}
                      </span>
                    )}
                  </span>
                </th>
                <td class="num">
                  <span class="minbar">
                    <span style={{ width: `${Math.min(100, (m / lg.playerMinCap) * 100)}%`, background: props.color }} />
                  </span>
                  {m >= 0.5 ? m.toFixed(0) : '–'}
                </td>
                <td class={`num delta ${d > 0.5 ? 'up' : d < -0.5 ? 'down' : ''}`}>{Math.abs(d) >= 0.5 ? (d > 0 ? '+' : '−') + Math.abs(d).toFixed(0) : ''}</td>
                <td class="toggle-col">
                  <label class="switch" title={props.asPlayed ? 'Minutes follow the actual box score' : isOut ? 'Put back in the lineup' : 'Rule out'}>
                    <input
                      id={`play-${p.id}`}
                      type="checkbox"
                      checked={!isOut}
                      disabled={props.asPlayed}
                      onChange={() => props.onToggle(p.id, !!p.injury?.out)}
                      aria-label={`${p.name} plays`}
                    />
                    <span />
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Sheet(props: {
  game: GameData;
  url: UrlState;
  sim: SimState;
  palette: Palette;
  unknownOuts: string[];
  onToggle: (id: string, injuredOut: boolean) => void;
  onChange: (p: Partial<UrlState>) => void;
  onReset: () => void;
}) {
  const { game: g, url } = props;
  const lg = LEAGUES[g.league];
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const asPlayed = g.phase !== 'pre' && url.mode === 'actual';
  const hasActual = g.phase !== 'pre' && [...g.home.players, ...g.away.players].some((p) => p.actual?.played);
  const fromPlay = url.from !== 'tip' && url.from !== 'now' ? g.plays.find((p) => String(p.seq) === url.from) : undefined;
  const scenarioCount = url.outs.length + url.ins.length;

  const copy = () => {
    const link = location.href;
    navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied('ok'))
      .catch(() => setCopied('fail'));
    if (!navigator.clipboard) setCopied('fail');
    setTimeout(() => setCopied('idle'), 2400);
  };

  return (
    <aside class="sheet" aria-label="Scenario">
      <div class="controls">
        <div class="ctl">
          <span class="ctl-label" id="sims-label">Simulations</span>
          <div class="seg small" role="radiogroup" aria-labelledby="sims-label">
            {SIM_COUNTS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={url.n === n} class={url.n === n ? 'on' : ''} onClick={() => props.onChange({ n })}>
                {n >= 1000 ? `${n / 1000}k` : n}
              </button>
            ))}
          </div>
        </div>
        <div class="ctl">
          <label class="ctl-label" for="whistle">
            Whistle
          </label>
          <div class="whistle">
            <input
              id="whistle"
              type="range"
              min={0.8}
              max={1.25}
              step={0.05}
              value={url.whistle}
              onInput={(e) => props.onChange({ whistle: Number((e.currentTarget as HTMLInputElement).value) })}
            />
            <span class="ctl-value">
              {url.whistle === 1 ? 'League average' : url.whistle < 1 ? `Let them play (${Math.round((url.whistle - 1) * 100)}%)` : `Tight (+${Math.round((url.whistle - 1) * 100)}%)`}
            </span>
          </div>
        </div>
        <div class="ctl row">
          <label class="check">
            <input id="hca" type="checkbox" checked={url.hca && !g.neutral} disabled={g.neutral} onChange={(e) => props.onChange({ hca: (e.currentTarget as HTMLInputElement).checked })} />
            Home court ({g.neutral ? 'neutral site' : `+${lg.homeAdvPts} pts`})
          </label>
          <label class="seed">
            <span class="ctl-label">Seed</span>
            <input id="seed" type="text" value={url.seed} maxLength={24} spellcheck={false} onChange={(e) => props.onChange({ seed: (e.currentTarget as HTMLInputElement).value.trim() || 'tipoff' })} />
            <button type="button" class="icon-btn" aria-label="New random seed" title="New random seed" onClick={() => props.onChange({ seed: randomSeed() })}>
              ↻
            </button>
          </label>
        </div>
        {g.phase !== 'pre' && (
          <div class="ctl">
            <span class="ctl-label" id="from-label">
              Simulate from
            </span>
            <div class="seg small" role="radiogroup" aria-labelledby="from-label">
              <button type="button" role="radio" aria-checked={url.from === 'tip'} class={url.from === 'tip' ? 'on' : ''} onClick={() => props.onChange({ from: 'tip' })}>
                Tip-off
              </button>
              {g.phase === 'in' && (
                <button type="button" role="radio" aria-checked={url.from === 'now'} class={url.from === 'now' ? 'on' : ''} onClick={() => props.onChange({ from: 'now' })}>
                  Right now
                </button>
              )}
              <button type="button" role="radio" aria-checked={!!fromPlay} class={fromPlay ? 'on' : ''} onClick={() => props.onChange({ tab: 'flow' })}>
                {fromPlay ? `${periodName(fromPlay.period, lg.periods).replace(' quarter', '')} ${fromPlay.clock}` : 'A moment…'}
              </button>
            </div>
          </div>
        )}
        {hasActual && (
          <div class="ctl">
            <span class="ctl-label" id="mode-label">
              Minutes
            </span>
            <div class="seg small" role="radiogroup" aria-labelledby="mode-label">
              <button type="button" role="radio" aria-checked={url.mode === 'projected'} class={url.mode === 'projected' ? 'on' : ''} onClick={() => props.onChange({ mode: 'projected' })}>
                Projected roles
              </button>
              <button type="button" role="radio" aria-checked={url.mode === 'actual'} class={url.mode === 'actual' ? 'on' : ''} onClick={() => props.onChange({ mode: 'actual' })}>
                As played
              </button>
            </div>
          </div>
        )}
        <div class="ctl-actions">
          <button type="button" class="btn" onClick={copy}>
            {copied === 'ok' ? 'Link copied' : copied === 'fail' ? 'Copy from the address bar' : 'Copy link to this scenario'}
          </button>
          {scenarioCount > 0 && (
            <button type="button" class="ghost-btn" onClick={props.onReset}>
              Reset lineups
            </button>
          )}
        </div>
        {props.unknownOuts.length > 0 && (
          <p class="note">
            {props.unknownOuts.length === 1 ? 'One player id' : `${props.unknownOuts.length} player ids`} in this link ({props.unknownOuts.join(', ')}) didn't match either roster. Links from
            other sites use different player ids; rule players out with the switches below.
          </p>
        )}
      </div>
      <Roster team={g.away} color={props.palette.away} game={g} url={url} sim={props.sim} asPlayed={asPlayed} onToggle={props.onToggle} />
      <Roster team={g.home} color={props.palette.home} game={g} url={url} sim={props.sim} asPlayed={asPlayed} onToggle={props.onToggle} />
    </aside>
  );
}
