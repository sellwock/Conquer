// The day's games in one table: the model's line, total and win chance next to the market's, the
// best single on the game's lines and the best player prop, ranked as the parlays tab does by
// default (the simulation's own picks where the backtest blend finds nothing). Games that have
// started show what the forward log saved before tip-off.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { LeagueId, ScoreboardGame } from '../model/types';
import { boardRow } from '../model/slate';
import { MODEL_WEIGHT, modelHasSay, type Parlay } from '../model/parlays';
import { LEAGUES } from '../model/leagues';
import { fmtAmerican, impliedFromAmerican } from '../lib/stats';
import { loadForwardLog } from '../track/forward';
import { gradeEntry, type Graded } from '../track/grade';
import type { Entry } from '../track/types';
import { dateLabel, lineText, pct, perHundred, tipTime } from './format';
import type { Slate } from './useSlate';
import { blendText } from './parlays';

type SortKey = 'tip' | 'spread' | 'total' | 'win' | 'edge' | 'prop';

interface Numbers {
  modelMargin: number;
  modelTotal: number;
  pHome: number;
  fairHome?: number;
  marketMargin?: number;
  marketTotal?: number;
}

interface Row {
  g: ScoreboardGame;
  /** Upcoming game: from the slate scan. Started game: from the forward log. */
  n?: Numbers;
  best?: Parlay;
  bestProp?: Parlay;
  hasProps?: boolean;
  note?: string;
  logged?: { e: Entry; graded: Graded | null };
}

function fromEntry(e: Entry): Numbers | undefined {
  if (!e.pred) return undefined;
  const l = e.line;
  let fairHome: number | undefined;
  if (l?.homeML != null && l.awayML != null) {
    const h = impliedFromAmerican(l.homeML), a = impliedFromAmerican(l.awayML);
    fairHome = h / (h + a);
  }
  return {
    modelMargin: e.pred.meanMargin,
    modelTotal: e.pred.meanTotal,
    pHome: e.pred.homeWin,
    fairHome,
    marketMargin: l?.spread != null ? -l.spread : undefined,
    marketTotal: l?.total,
  };
}

const gap = (a?: number, b?: number) => (a != null && b != null ? Math.abs(a - b) : -1);

const SORTS: Record<SortKey, (r: Row) => number> = {
  tip: (r) => -Date.parse(r.g.date),
  spread: (r) => gap(r.n?.modelMargin, r.n?.marketMargin),
  total: (r) => gap(r.n?.modelTotal, r.n?.marketTotal),
  win: (r) => gap(r.n?.pHome, r.n?.fairHome),
  edge: (r) => r.best?.ev ?? -Infinity,
  prop: (r) => r.bestProp?.ev ?? -Infinity,
};

export function SlateBoard(props: {
  league: LeagueId;
  date: string;
  board: { status: 'loading' | 'ok' | 'error'; games: ScoreboardGame[]; error?: string };
  slate: Slate;
  openGame?: string;
  onOpen: (id: string) => void;
}) {
  const { slate, board } = props;
  const [sort, setSort] = useState<SortKey>('tip');
  const hasSay = modelHasSay(props.league);
  const [log, setLog] = useState<Record<string, Entry>>({});

  // Started games show the prediction saved before tip, when the log has one.
  const started = board.games.some((g) => g.phase !== 'pre');
  useEffect(() => {
    if (!started) return;
    const ac = new AbortController();
    loadForwardLog(props.league, ac.signal)
      .then(({ entries }) => setLog(Object.fromEntries(entries.map((e) => [e.id, e]))))
      .catch(() => {});
    return () => ac.abort();
  }, [props.league, started]);

  const rows = useMemo(() => {
    const out: Row[] = board.games.map((g) => {
      const m = slate.markets[g.id];
      if (g.phase === 'pre') {
        if (!m) return { g };
        const r = boardRow(m);
        return { g, n: r, best: r.best, bestProp: r.bestProp, hasProps: r.hasProps, note: m.note };
      }
      const e = log[g.id];
      return { g, n: e && fromEntry(e), logged: e ? { e, graded: e.status === 'final' ? gradeEntry(e) : null } : undefined };
    });
    const key = SORTS[sort];
    return out.sort((a, b) => key(b) - key(a) || Date.parse(a.g.date) - Date.parse(b.g.date));
  }, [board.games, slate.markets, log, sort]);

  const pendingIds = new Set(slate.pending.map((g) => g.id));
  // The prop column appears once any game on the board has posted props priced.
  const showProps = rows.some((r) => r.hasProps);
  const simulated = rows.filter((r) => r.g.phase === 'pre' && r.n).length;
  const upcoming = rows.filter((r) => r.g.phase === 'pre').length;

  const Th = (p: { k: SortKey; label: string; num?: boolean }) => (
    <th scope="col" class={p.num ? 'num' : ''} aria-sort={sort === p.k ? 'descending' : 'none'}>
      <button type="button" class={sort === p.k ? 'sort on' : 'sort'} onClick={() => setSort(p.k)}>
        {p.label}
      </button>
    </th>
  );

  return (
    <div class="slate">
      <section class="card">
        <header class="card-head">
          <h2>Slate · {dateLabel(props.date)}</h2>
          <p class="muted small">
            {board.games.length} game{board.games.length === 1 ? '' : 's'}
            {upcoming ? ` · ${simulated} of ${upcoming} upcoming simulated` : ''}
          </p>
        </header>
        <p class="muted small">
          Model numbers come from 2,000 simulations per game with everyone available (the open game uses your settings).{' '}
          {hasSay
            ? `Line picks weight the simulation against the market by how it did in backtests (${blendText(MODEL_WEIGHT[props.league])}) and clear the same bar as the parlays tab's singles.`
            : `Line picks rank by the simulation alone and clear the same bar as the parlays tab's singles. In backtests the market's odds were more accurate than the simulation's on ${LEAGUES[props.league].label} games, so treat them as the simulation's leans.`}
          {showProps &&
            (hasSay
              ? ' Props have no backtest, so the blend leaves them to the market and the prop column passes; switch the parlays tab to Simulation only to see prop leans.'
              : " Prop picks are the simulation's best player prop for each game, also unbacktested.")}{' '}
          Suggestions, not advice.
        </p>
        <div class="scan">
          {slate.scan.status === 'running' ? (
            <>
              <span class="spinner" aria-hidden="true" />
              <span>
                Simulating {slate.scan.current ?? 'the slate'} ({slate.scan.done} of {slate.scan.total} done)
              </span>
              <button type="button" class="ghost-btn" onClick={slate.stop}>
                Stop
              </button>
            </>
          ) : slate.pending.length > 0 ? (
            <>
              <span>
                {slate.pending.length} upcoming {slate.pending.length === 1 ? 'game hasn’t' : 'games haven’t'} been simulated.
              </span>
              <button type="button" class="btn" onClick={slate.start}>
                Simulate {slate.pending.length === 1 ? 'it' : `all ${slate.pending.length}`}
              </button>
            </>
          ) : null}
          {slate.scan.failed > 0 && <span class="muted small">{slate.scan.failed} couldn't be loaded and were skipped.</span>}
        </div>
      </section>

      {board.status === 'loading' && !board.games.length && (
        <div class="loading-panel">
          <span class="spinner" aria-hidden="true" />
          Loading the slate…
        </div>
      )}
      {board.status === 'error' && <div class="error-panel" role="alert">{board.error}</div>}
      {board.status === 'ok' && !board.games.length && <div class="empty-panel">No games on this date. Pick another day.</div>}

      {rows.length > 0 && (
        <section class="card">
          <div class="table-wrap">
            <table class="data board">
              <thead>
                <tr>
                  <th scope="col">Game</th>
                  <Th k="tip" label="Tip" />
                  <Th k="spread" label="Model line" num />
                  <th scope="col" class="num">
                    Market
                  </th>
                  <Th k="total" label="Total" num />
                  <Th k="win" label="Home win" num />
                  <Th k="edge" label="Line pick" />
                  {showProps && <Th k="prop" label="Prop pick" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <BoardRowView
                    key={r.g.id}
                    r={r}
                    showProps={showProps}
                    queued={pendingIds.has(r.g.id)}
                    scanning={slate.scan.status === 'running'}
                    open={r.g.id === props.openGame}
                    onOpen={props.onOpen}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted small">
            Total and home win show the model first, then the market. Click a game to open it. Started games show the prediction saved before tip-off, when there is one.
          </p>
        </section>
      )}
    </div>
  );
}

function BoardRowView(props: { r: Row; showProps: boolean; queued: boolean; scanning: boolean; open: boolean; onOpen: (id: string) => void }) {
  const { g, n, best, bestProp, logged } = props.r;
  const pre = g.phase === 'pre';
  const waiting = pre && !n;
  const placeholder = waiting ? (props.queued ? (props.scanning ? 'Queued' : '–') : props.open && g.odds ? 'Simulating' : 'No line') : '–';
  return (
    <tr class={g.phase === 'in' ? 'live' : ''}>
      <th scope="row">
        <button type="button" class="link" onClick={() => props.onOpen(g.id)}>
          {g.away.abbr} @ {g.home.abbr}
        </button>
        {!pre && g.home.score != null && g.away.score != null && (
          <span class="muted small score">
            {' '}
            {g.away.score}–{g.home.score}
          </span>
        )}
        {props.r.note && (
          <span class="muted small" title={props.r.note}>
            {' '}
            · your scenario
          </span>
        )}
      </th>
      <td>{pre ? tipTime(g.date) : <span class={g.phase === 'in' ? 'live-text' : 'muted'}>{g.statusText}</span>}</td>
      {n ? (
        <>
          <td class="num">{lineText(g.home.abbr, g.away.abbr, n.modelMargin)}</td>
          <td class="num">{n.marketMargin != null ? lineText(g.home.abbr, g.away.abbr, n.marketMargin) : '–'}</td>
          <td class="num">
            {n.modelTotal.toFixed(1)} <span class="muted">· {n.marketTotal ?? '–'}</span>
          </td>
          <td class="num">
            {pct(n.pHome, 0)} <span class="muted">· {n.fairHome != null ? pct(n.fairHome, 0) : '–'}</span>
          </td>
        </>
      ) : (
        <td colSpan={4} class="muted">
          {pre ? placeholder : 'No saved prediction'}
        </td>
      )}
      <td class="best">{!pre ? <ResultCell g={g} logged={logged} /> : <BestCell best={best} waiting={waiting} />}</td>
      {props.showProps && (
        <td class="best">{!pre || (n && !props.r.hasProps) ? <span class="muted">–</span> : <BestCell best={bestProp} waiting={waiting} />}</td>
      )}
    </tr>
  );
}

function BestCell(props: { best?: Parlay; waiting: boolean }) {
  if (props.waiting) return <span class="muted">–</span>;
  const p = props.best;
  if (!p) return <span class="muted">Pass</span>;
  return (
    <span>
      {p.legs[0].label} {fmtAmerican(p.price)} <span class="pos small">{perHundred(p.ev)}</span>
    </span>
  );
}

function ResultCell(props: { g: ScoreboardGame; logged?: Row['logged'] }) {
  const ats = props.logged?.graded?.ats;
  const e = props.logged?.e;
  if (!e || !ats) return <span class="muted">{props.g.phase === 'in' ? 'In progress' : '–'}</span>;
  const team = ats.pick === 'home' ? e.home.abbr : e.away.abbr;
  const line = ats.pick === 'home' ? ats.line : -ats.line;
  return (
    <span>
      Spread pick {team} {fmtAmerican(line)} ·{' '}
      {ats.result === 'win' ? <span class="pos">Won</span> : ats.result === 'loss' ? <span class="neg">Lost</span> : <span class="muted">Push</span>}
    </span>
  );
}
