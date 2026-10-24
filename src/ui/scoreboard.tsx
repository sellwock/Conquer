import { useEffect, useState } from 'preact/hooks';
import { Hist } from '../lib/stats';
import { periodName } from '../sim/engine';
import { LEAGUES } from '../model/leagues';
import type { GameData, GameSnapshot } from '../model/types';
import { SplitBar } from './charts';
import { inkOn } from './colors';
import { pct, spreadText, tipTime } from './format';
import type { Palette, SimState } from './app';

function Digits(props: { value: number | string; label: string }) {
  const s = String(props.value);
  return (
    <span class="led" aria-label={`${props.label} ${s}`}>
      <span class="led-ghost" aria-hidden="true">{'8'.repeat(Math.max(3, s.length))}</span>
      <span class="led-on" aria-hidden="true">{s.padStart(Math.max(3, s.length), ' ')}</span>
    </span>
  );
}

function TeamBlock(props: { side: 'home' | 'away'; t: GameData['home']; color: string; score?: number }) {
  const { t } = props;
  return (
    <div class={`sb-team ${props.side}`} style={{ '--team': props.color } as Record<string, string>}>
      {t.logo ? (
        <img
          src={t.logo}
          alt=""
          width={44}
          height={44}
          loading="lazy"
          onError={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            img.replaceWith(Object.assign(document.createElement('span'), { className: 'sb-logo-fallback', textContent: t.abbr }));
          }}
        />
      ) : (
        <span class="sb-logo-fallback">{t.abbr}</span>
      )}
      <div class="sb-name">
        <span class="sb-loc">{t.name.replace(new RegExp(`\\s*${t.shortName}$`), '') || t.abbr}</span>
        <span class="sb-nick">{t.shortName}</span>
        <span class="sb-rec">{[props.side === 'home' ? 'Home' : 'Away', t.record].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  );
}

export interface LiveState {
  /** When the last refresh landed. */
  updatedAt?: number;
  failing?: boolean;
}

/** "Updated 12s ago", ticking. */
function LiveAge(props: { live: LiveState }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (props.live.failing) return <span>Update failed, retrying</span>;
  if (!props.live.updatedAt) return <span>Auto-updating</span>;
  const secs = Math.max(0, Math.round((Date.now() - props.live.updatedAt) / 1000));
  return <span>Updated {secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`} ago</span>;
}

export function Scoreboard(props: { game: GameData; sim: SimState; palette: Palette; start?: GameSnapshot; live?: LiveState }) {
  const { game: g, sim, palette } = props;
  const s = sim.scenario;
  const lg = LEAGUES[g.league];
  const margin = s ? Hist.from(s.margin).mean() : 0;
  const total = s ? s.homeScore + s.awayScore : 0;
  const score = g.homeScore != null ? ` · ${g.away.abbr} ${g.awayScore}, ${g.home.abbr} ${g.homeScore}` : '';
  const status = g.phase === 'pre' ? `Tip ${tipTime(g.date)}` : g.phase === 'in' ? `Live · ${g.statusText}${score}` : `Final${score}`;
  const fromText = props.start
    ? `Simulating from ${g.away.abbr} ${props.start.awayScore}–${props.start.homeScore} ${g.home.abbr}, ${periodName(props.start.period, lg.periods)}`
    : g.phase === 'pre'
      ? 'Projected final'
      : 'Projected from tip-off';
  return (
    <section class="scoreboard" aria-label="Matchup">
      <div class="sb-inner">
        <div class="sb-status">
          <span class={g.phase === 'in' ? 'live-dot' : ''} aria-live="polite">
            {status}
          </span>
          {props.live && <LiveAge live={props.live} />}
          {g.venue && <span>{g.venue}</span>}
          {g.neutral && <span>Neutral site</span>}
          {g.demo && <span class="sb-flag">Sample data</span>}
        </div>
        <div class="sb-main">
          <TeamBlock side="away" t={g.away} color={palette.away} />
          <div class="sb-center">
            <div class="sb-digits">
              <Digits value={s ? Math.round(s.awayScore) : '–'} label={`${g.away.abbr} projected`} />
              <span class="sb-dash" aria-hidden="true" />
              <Digits value={s ? Math.round(s.homeScore) : '–'} label={`${g.home.abbr} projected`} />
            </div>
            <div class="sb-caption">{fromText}</div>
          </div>
          <TeamBlock side="home" t={g.home} color={palette.home} />
        </div>
        {s && (
          <SplitBar
            left={{ label: g.away.abbr, p: 1 - s.homeWin, color: palette.away, ink: inkOn(palette.away) }}
            right={{ label: g.home.abbr, p: s.homeWin, color: palette.home, ink: inkOn(palette.home) }}
          />
        )}
        <div class={`sb-progress${sim.status === 'running' ? ' on' : ''}`} aria-hidden={sim.status !== 'running'}>
          <span style={{ width: `${Math.round(sim.progress * 100)}%` }} />
        </div>
        {s && (
          <dl class="sb-lines">
            <div>
              <dt>Model</dt>
              <dd>
                {spreadText(margin >= 0 ? g.home.abbr : g.away.abbr, Math.abs(margin))} · {total.toFixed(1)} total
              </dd>
            </div>
            {g.odds && (g.odds.details || g.odds.total != null) && (
              <div>
                <dt>{g.odds.provider}</dt>
                <dd>
                  {g.odds.details ?? '–'}
                  {g.odds.total != null ? ` · O/U ${g.odds.total}` : ''}
                </dd>
              </div>
            )}
            {g.espnHomeWinPct != null && (
              <div>
                <dt>ESPN BPI</dt>
                <dd>
                  {g.home.abbr} {pct(g.espnHomeWinPct)}
                </dd>
              </div>
            )}
            {g.officials.length > 0 && (
              <div>
                <dt>Officials</dt>
                <dd>{g.officials.join(', ')}</dd>
              </div>
            )}
            <div>
              <dt>Sims</dt>
              <dd>
                {s.n.toLocaleString()} · seed {s.seed}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}
