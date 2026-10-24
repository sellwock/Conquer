import type { LeagueId, ScoreboardGame } from '../model/types';
import type { View } from './state';
import { dateLabel, parseYmd, tipTime, yyyymmdd } from './format';

export function TopBar(props: {
  view: View;
  league: LeagueId;
  date: string;
  onView: (v: View) => void;
  onLeague: (l: LeagueId) => void;
  onDate: (d: string) => void;
  onSample: () => void;
}) {
  const shift = (days: number) => {
    const d = parseYmd(props.date);
    d.setDate(d.getDate() + days);
    props.onDate(yyyymmdd(d));
  };
  const iso = `${props.date.slice(0, 4)}-${props.date.slice(4, 6)}-${props.date.slice(6, 8)}`;
  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M1.5 12h21M12 1.5v21M4.6 4.6c3.6 3.2 3.6 11.6 0 14.8M19.4 4.6c-3.6 3.2-3.6 11.6 0 14.8" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </span>
        <span class="brand-name">Conquer</span>
        <span class="brand-sub">Game Sim</span>
      </div>
      <div class="seg" role="radiogroup" aria-label="View">
        {(
          [
            ['game', 'Games'],
            ['record', 'Track record'],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={props.view === v} class={props.view === v ? 'on' : ''} onClick={() => props.onView(v)}>
            {label}
          </button>
        ))}
      </div>
      <div class="seg" role="radiogroup" aria-label="League">
        {(['nba', 'ncaam'] as LeagueId[]).map((l) => (
          <button key={l} type="button" role="radio" aria-checked={props.league === l} class={props.league === l ? 'on' : ''} onClick={() => props.onLeague(l)}>
            {l === 'nba' ? 'NBA' : 'College'}
          </button>
        ))}
      </div>
      <div class="datebar" hidden={props.view === 'record'}>
        <button type="button" class="icon-btn" aria-label="Previous day" onClick={() => shift(-1)}>
          ‹
        </button>
        <label class="date-pick">
          <span>{dateLabel(props.date)}</span>
          <input
            id="date-input"
            type="date"
            value={iso}
            aria-label="Game date"
            onChange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (v) props.onDate(v.replace(/-/g, ''));
            }}
          />
        </label>
        <button type="button" class="icon-btn" aria-label="Next day" onClick={() => shift(1)}>
          ›
        </button>
        <button type="button" class="ghost-btn" onClick={() => props.onDate(yyyymmdd(new Date()))}>
          Today
        </button>
        <button type="button" class="ghost-btn" onClick={props.onSample}>
          Sample
        </button>
      </div>
    </header>
  );
}

export function GameStrip(props: { board: { status: string; games: ScoreboardGame[]; error?: string }; selected?: string; onSelect: (id: string) => void }) {
  const { board } = props;
  if (board.status === 'loading' && !board.games.length) return <div class="strip strip-empty">Loading the slate…</div>;
  if (board.status === 'error') return <div class="strip strip-empty">Couldn't load the slate. {board.error}</div>;
  if (!board.games.length) return null;
  return (
    <div class="strip" role="listbox" aria-label="Games on this date">
      {board.games.map((g) => {
        const live = g.phase === 'in';
        const showScore = g.phase !== 'pre';
        return (
          <button key={g.id} type="button" role="option" aria-selected={props.selected === g.id} class={`chip-game${props.selected === g.id ? ' on' : ''}`} onClick={() => props.onSelect(g.id)}>
            <span class="cg-team">
              <i style={{ background: g.away.color }} />
              {g.away.abbr}
              {showScore && <b>{g.away.score}</b>}
            </span>
            <span class="cg-team">
              <i style={{ background: g.home.color }} />
              {g.home.abbr}
              {showScore && <b>{g.home.score}</b>}
            </span>
            <span class={`cg-status${live ? ' live' : ''}`}>{g.phase === 'pre' ? tipTime(g.date) : g.statusText}</span>
          </button>
        );
      })}
    </div>
  );
}
