import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LeagueId } from '../model/types';
import { MODEL_VERSION } from '../model/version';
import { fmtAmerican } from '../lib/stats';
import { gradeEntry, summarize, type Graded, type Record3, type Summary } from '../track/grade';
import { loadForwardLog, type ForwardLog } from '../track/forward';
import { runBacktest, type BacktestProgress } from '../track/backtest';
import type { Entry } from '../track/types';
import { Reliability } from './charts';
import { lineText, pct, signed1 } from './format';

type Source = 'log' | 'backtest';
const BACKTEST_DAYS = [7, 14, 30];
const MIN_VERDICT_GAMES = 30;
const GAMES_SHOWN = 50;

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function rate(r: Record3): string {
  const n = r.win + r.loss;
  return n ? pct(r.win / n) : '–';
}

function units(u: number): string {
  return `${u >= 0 ? '+' : '−'}${Math.abs(u).toFixed(1)} units`;
}

function Verdict({ s }: { s: Summary }) {
  const v = s.vsMarket;
  if (!v) return <p class="muted">No moneylines in this sample, so there's no market to compare against.</p>;
  // A bootstrap interval from a handful of games is meaningless, so don't call it early.
  const few = v.n < MIN_VERDICT_GAMES;
  const better = !few && v.hi < 0, worse = !few && v.lo > 0;
  return (
    <div class="verdict">
      <strong class={better ? 'pos' : worse ? 'neg' : ''}>
        {few ? 'Too few games to tell' : better ? 'Model beats the market' : worse ? 'Market beats the model' : 'No clear difference yet'}
      </strong>
      <span class="muted">
        Brier score (lower is better) on {v.n} game{v.n === 1 ? '' : 's'} with a moneyline: model {v.model.toFixed(3)}, market {v.market.toFixed(3)}. Difference {signed(v.diff)}
        {few ? `. A verdict needs at least ${MIN_VERDICT_GAMES} games.` : `, 95% interval ${signed(v.lo)} to ${signed(v.hi)}.`}
      </span>
    </div>
  );
}

const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(3)}`;

function SummaryCards({ s, source }: { s: Summary; source: Source }) {
  return (
    <>
      <section class="card stats-row" aria-label="Record">
        <div class="stat">
          <span class="kicker">Winners</span>
          <strong>{s.straightUp.n ? pct(s.straightUp.correct / s.straightUp.n) : '–'}</strong>
          <span class="muted">
            {s.straightUp.correct}–{s.straightUp.n - s.straightUp.correct} picking the model's favorite
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Against the spread</span>
          <strong>{rate(s.ats)}</strong>
          <span class="muted">
            {s.ats.win}–{s.ats.loss}
            {s.ats.push ? `–${s.ats.push}` : ''} · {units(s.ats.units)}
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Over/under</span>
          <strong>{rate(s.ou)}</strong>
          <span class="muted">
            {s.ou.win}–{s.ou.loss}
            {s.ou.push ? `–${s.ou.push}` : ''} · {units(s.ou.units)}
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Average miss</span>
          <strong>{s.marginMAE.toFixed(1)} pts</strong>
          <span class="muted">on the margin · {s.totalMAE.toFixed(1)} on the total</span>
        </div>
        {source === 'log' && s.clv && (
          <div class="stat">
            <span class="kicker">Line movement</span>
            <strong>{signed1(s.clv.mean)} pts</strong>
            <span class="muted">toward the model's spread pick after the snapshot ({s.clv.n} games)</span>
          </div>
        )}
      </section>
      <section class="card">
        <header class="card-head">
          <h2>Against the market</h2>
        </header>
        <Verdict s={s} />
        <p class="muted small">
          A pick-by-pick record needs hundreds of games before it means much: at 500 games, a 52% against-the-spread rate is still within about two points of a coin flip. The Brier
          comparison uses every game's probability, so it settles sooner. Units are hypothetical, staking 1 unit on every pick at the listed price. Not advice.
        </p>
      </section>
      <section class="card">
        <header class="card-head">
          <h2>Calibration</h2>
          <p class="muted small">When the model says 70%, the home team should win about 70% of the time. Dots near the diagonal mean honest probabilities.</p>
        </header>
        <Reliability bins={s.calibration} color="var(--accent)" />
      </section>
    </>
  );
}

function GamesTable({ rows }: { rows: { e: Entry; g: Graded }[] }) {
  const cell = (r?: string) => (r === 'win' ? <span class="pos">Won</span> : r === 'loss' ? <span class="neg">Lost</span> : r === 'push' ? <span class="muted">Push</span> : <span class="muted">–</span>);
  return (
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Game</th>
            <th scope="col" class="num">Home win</th>
            <th scope="col" class="num">Model line</th>
            <th scope="col" class="num">Market</th>
            <th scope="col" class="num">Final</th>
            <th scope="col">Spread pick</th>
            <th scope="col">Total pick</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ e, g }) => {
            const m = e.pred!.meanMargin;
            return (
              <tr key={e.id}>
                <td>{new Date(e.tip).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                <th scope="row">
                  {e.away.abbr} @ {e.home.abbr}
                </th>
                <td class="num">{pct(g.pHome, 0)}</td>
                <td class="num">{lineText(e.home.abbr, e.away.abbr, m)}</td>
                <td class="num">{e.line?.spread != null ? lineText(e.home.abbr, e.away.abbr, -e.line.spread) : (e.line?.details ?? '–')}</td>
                <td class="num">
                  {e.result!.away}–{e.result!.home}
                </td>
                <td>
                  {g.ats ? (
                    <>
                      {g.ats.pick === 'home' ? e.home.abbr : e.away.abbr} {fmtAmerican(g.ats.pick === 'home' ? g.ats.line : -g.ats.line)} · {cell(g.ats.result)}
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td>
                  {g.ou ? (
                    <>
                      {g.ou.pick === 'over' ? 'Over' : 'Under'} {g.ou.line} · {cell(g.ou.result)}
                    </>
                  ) : (
                    '–'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TrackRecord(props: { league: LeagueId }) {
  const [source, setSource] = useState<Source>('log');
  const [log, setLog] = useState<{ status: 'loading' | 'ok' | 'error'; data?: ForwardLog; error?: string }>({ status: 'loading' });
  const [days, setDays] = useState(7);
  const [bt, setBt] = useState<{ status: 'idle' | 'running' | 'done' | 'error'; progress?: BacktestProgress; entries: Entry[]; failed: number; error?: string }>({
    status: 'idle',
    entries: [],
    failed: 0,
  });
  const [model, setModel] = useState<string>('all');
  const [allGames, setAllGames] = useState(false);
  const btAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLog({ status: 'loading' });
    loadForwardLog(props.league, ac.signal)
      .then((data) => setLog({ status: 'ok', data }))
      .catch((e) => {
        if (e?.name !== 'AbortError') setLog({ status: 'error', error: e?.message ?? String(e) });
      });
    return () => ac.abort();
  }, [props.league]);

  useEffect(() => {
    btAbort.current?.abort();
    setBt({ status: 'idle', entries: [], failed: 0 });
  }, [props.league]);
  useEffect(() => () => btAbort.current?.abort(), []);

  const startBacktest = () => {
    btAbort.current?.abort();
    const ac = new AbortController();
    btAbort.current = ac;
    setBt({ status: 'running', entries: [], failed: 0, progress: { done: 0, total: 0 } });
    runBacktest({ league: props.league, days, signal: ac.signal, onProgress: (progress) => setBt((b) => ({ ...b, progress })) })
      .then(({ entries, failed }) => setBt({ status: 'done', entries, failed }))
      .catch((e) => {
        if (e?.name !== 'AbortError') setBt({ status: 'error', entries: [], failed: 0, error: e?.message ?? String(e) });
      });
  };

  const entries = source === 'log' ? log.data?.entries ?? [] : bt.entries;
  const models = useMemo(() => [...new Set(entries.map((e) => e.pred?.model).filter(Boolean) as string[])].sort().reverse(), [entries]);
  // A version picked for one source may not exist in the other.
  const pick = models.includes(model) ? model : 'all';
  const rows = useMemo(
    () =>
      entries
        .filter((e) => pick === 'all' || e.pred?.model === pick)
        .map((e) => ({ e, g: gradeEntry(e) }))
        .filter((r): r is { e: Entry; g: Graded } => !!r.g),
    [entries, pick],
  );
  const summary = useMemo(() => summarize(rows.map((r) => r.g)), [rows]);
  const open = source === 'log' ? (log.data?.entries ?? []).filter((e) => e.status === 'open').length : 0;
  const lastRun = log.data?.status?.lastRun;
  const stale = lastRun ? Date.now() - Date.parse(lastRun) > 36 * 3_600_000 : false;

  return (
    <div class="record">
      <section class="card">
        <header class="card-head">
          <h2>Track record</h2>
          <div class="seg small" role="radiogroup" aria-label="Which record">
            <button type="button" role="radio" aria-checked={source === 'log'} class={source === 'log' ? 'on' : ''} onClick={() => setSource('log')}>
              Saved before tip-off
            </button>
            <button type="button" role="radio" aria-checked={source === 'backtest'} class={source === 'backtest' ? 'on' : ''} onClick={() => setSource('backtest')}>
              Backtest
            </button>
          </div>
        </header>
        {source === 'log' ? (
          <p class="muted">
            Every prediction here was saved before its game tipped off and never changed afterwards, so this record has no hindsight.
            {log.status === 'ok' && lastRun ? ` The log last updated ${ago(lastRun)}.` : ''}
            {open ? ` ${open} game${open === 1 ? '' : 's'} waiting on a result.` : ''}
          </p>
        ) : (
          <>
            <p class="muted">
              Re-runs the current model on finished games as they looked before tip-off. Season stats stop at tip, but who suited up comes from the box score, so this has a little
              hindsight the saved log doesn't.
            </p>
            <div class="scan">
              <div class="seg small" role="radiogroup" aria-label="How far back">
                {BACKTEST_DAYS.map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={days === d} class={days === d ? 'on' : ''} onClick={() => setDays(d)} disabled={bt.status === 'running'}>
                    Last {d} days
                  </button>
                ))}
              </div>
              {bt.status === 'running' ? (
                <>
                  <span class="spinner" aria-hidden="true" />
                  <span>
                    {bt.progress?.total ? `Simulating ${bt.progress.done} of ${bt.progress.total} games` : 'Finding games'}
                    {bt.progress?.label ? ` · ${bt.progress.label}` : ''}
                  </span>
                  <button type="button" class="ghost-btn" onClick={() => btAbort.current?.abort()}>
                    Stop
                  </button>
                </>
              ) : (
                <button type="button" class="btn" onClick={startBacktest}>
                  {bt.status === 'done' ? 'Run again' : 'Run backtest'}
                </button>
              )}
            </div>
            <p class="muted small">The first run reads every game's history from ESPN and can take a few minutes; results are cached for model {MODEL_VERSION}.</p>
            {bt.failed > 0 && <p class="note">{bt.failed} games couldn't be loaded and were skipped.</p>}
            {bt.status === 'error' && <p class="note">The backtest stopped: {bt.error}</p>}
          </>
        )}
        {source === 'log' && stale && <p class="note">The log hasn't updated in over a day. In the offseason that's expected; during the season, check the Forward log workflow in GitHub Actions.</p>}
        {source === 'log' && log.status === 'error' && <p class="note">Couldn't load the prediction log: {log.error}</p>}
        {models.length > 1 && (
          <label class="model-filter">
            <span class="ctl-label">Model</span>
            <select id="record-model" value={pick} onChange={(e) => setModel((e.currentTarget as HTMLSelectElement).value)}>
              <option value="all">All versions</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === MODEL_VERSION ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {source === 'log' && log.status === 'loading' && (
        <div class="loading-panel">
          <span class="spinner" aria-hidden="true" />
          Loading the prediction log…
        </div>
      )}
      {rows.length === 0 && !(source === 'log' && log.status === 'loading') && bt.status !== 'running' && (
        <div class="empty-panel">
          {source === 'log'
            ? 'No graded games yet. The scheduled job saves predictions within 12 hours of tip-off and grades them once the games end.'
            : bt.status === 'done'
              ? 'No finished games with results in that range.'
              : 'Pick a range and run the backtest to grade the model on recent games.'}
        </div>
      )}
      {rows.length > 0 && (
        <>
          <SummaryCards s={summary} source={source} />
          <section class="card">
            <header class="card-head">
              <h2>Games</h2>
              <p class="muted small">{rows.length} graded, newest first.</p>
            </header>
            <GamesTable rows={allGames ? rows : rows.slice(0, GAMES_SHOWN)} />
            {rows.length > GAMES_SHOWN && (
              <button type="button" class="ghost-btn" onClick={() => setAllGames(!allGames)}>
                {allGames ? `Show the latest ${GAMES_SHOWN}` : `Show all ${rows.length} games`}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
