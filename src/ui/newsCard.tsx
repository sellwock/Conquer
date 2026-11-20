// The slate board's injury-news card: players newly ruled out for today's games, and the props their
// absence moves the most, with the book's line now and (when the forward log has it) before the news.
import { useEffect, useState } from 'preact/hooks';
import type { ScoreboardGame } from '../model/types';
import { PROP_WORDS } from '../model/parlays';
import { fmtAmerican } from '../lib/stats';
import { loadPropLog } from '../track/forward';
import type { PropEntry } from '../track/types';
import type { NewsItem, NewsScan } from './news';
import { pct, tipTime } from './format';
import { propMixText } from './parlays';

const ROWS = 5;

function ago(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

const signed = (x: number) => `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
/** Expected return per $100, compact for a phone: "+$16". */
const dollars = (ev: number) => `${ev >= 0 ? '+' : '−'}$${Math.abs(Math.round(ev * 100))}`;

/** The line this prop had in the forward log's pre-game snapshot, if that was saved before the news. */
function lineBefore(entry: PropEntry | undefined, item: NewsItem, athleteId: string, stat: string): number | undefined {
  const pre = entry?.pre;
  const since = item.event.since;
  if (!pre || !since || Date.parse(pre.takenAt) >= Date.parse(since)) return undefined;
  return pre.rows.find(([id, s]) => id === athleteId && s === stat)?.[2];
}

function NewsEvent(props: { item: NewsItem; team: string; entry?: PropEntry; now: number; onOpen: (id: string) => void }) {
  const { item, entry, now } = props;
  const e = item.event;
  const p = item.pricing;
  const rows = p?.rows.slice(0, ROWS) ?? [];
  return (
    <article class="news-item">
      <p class="news-head">
        <strong>{e.name}</strong> ({props.team}) {e.kind === 'back' ? <span class="chip good">Back</span> : null} {e.status.toLowerCase()}
        {e.since ? <span class="muted"> · {ago(e.since, now)}</span> : null}
        {e.was ? <span class="muted"> · was {e.was.toLowerCase()}</span> : null}
      </p>
      {e.note && <p class="muted small">{e.note}</p>}
      <p class="muted small">
        <button type="button" class="link" onClick={() => props.onOpen(e.gameId)}>
          {p?.label ?? 'His game'}
        </button>{' '}
        · tips {tipTime(e.tip)}
        {p ? ` · projected ${Math.round(p.minutes)} min ${e.kind === 'back' ? 'if he plays' : 'had he played'}` : ''}
        {item.loggedAt ? ` · logged ${ago(item.loggedAt, now)}` : ''}
      </p>
      {item.status === 'pricing' && !p && <p class="muted">Repricing his game with and without him…</p>}
      {item.status === 'error' && <p class="muted">Couldn't reprice his game: {item.error}</p>}
      {p && !p.out.length && <p class="muted">No props are posted for this game yet.</p>}
      {p && p.out.length > 0 && !rows.length && <p class="muted">No posted prop moves enough to matter.</p>}
      {rows.length > 0 && (
        <div class="table-wrap">
          <table class="data props-table">
            <thead>
              <tr>
                <th scope="col">Bet</th>
                <th scope="col" class="num" title="The book's price now">
                  Price
                </th>
                <th scope="col" class="num" title="How far his absence moves the player's simulated average">
                  Shift
                </th>
                <th scope="col" class="num" title={`Hit chance at ${propMixText()}`}>
                  Hit
                </th>
                <th scope="col" class="num" title="Expected return per $100 staked, at that hit chance">
                  Per $100
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const before = lineBefore(entry, item, r.athleteId, r.stat);
                return (
                  <tr key={`${r.athleteId}:${r.stat}`}>
                    <th scope="row">
                      {r.player} {r.side} {r.line} {PROP_WORDS[r.stat]}
                      <br />
                      <span class="muted small">
                        {r.team}
                        {before != null && before !== r.line ? ` · was ${before} before the news` : before != null ? ' · line unchanged since before the news' : ''}
                      </span>
                    </th>
                    <td class="num">{fmtAmerican(r.price)}</td>
                    <td class="num">{signed(r.shift)}</td>
                    <td class="num">{pct(r.pHit, 0)}</td>
                    <td class={`num ${r.pick ? 'pos' : 'muted'}`}>{dollars(r.ev)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function NewsCard(props: { news: NewsScan; games: ScoreboardGame[]; onOpen: (id: string) => void }) {
  const { news } = props;
  const [log, setLog] = useState<Record<string, PropEntry>>({});
  const priced = news.items.some((i) => i.status === 'ok');
  // The forward log's pre-game lines show where each line stood before the news.
  useEffect(() => {
    if (!priced) return;
    const ac = new AbortController();
    loadPropLog('nba', ac.signal)
      .then((es) => setLog(Object.fromEntries(es.map((e) => [e.id, e]))))
      .catch(() => {});
    return () => ac.abort();
  }, [priced]);
  const teams = new Map(props.games.flatMap((g) => [[g.home.id, g.home.abbr] as const, [g.away.id, g.away.abbr] as const]));
  const now = Date.now();
  const shown = news.items.filter((i) => i.status !== 'quiet');
  const quiet = news.items.filter((i) => i.status === 'quiet');
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <section class="card news-card">
      <header class="card-head">
        <h2>Injury news</h2>
        <p class="muted small">
          {news.watching} upcoming game{news.watching === 1 ? '' : 's'} watched
          {news.checkedAt ? ` · checked ${time(news.checkedAt)}` : ''}
          {news.paused ? ' · paused' : ' · every 2 minutes'}
        </p>
      </header>
      <div class="scan">
        {news.status === 'running' && <span class="spinner" aria-hidden="true" />}
        {news.paused ? (
          <button type="button" class="btn" onClick={news.resume}>
            Resume
          </button>
        ) : (
          <button type="button" class="ghost-btn" onClick={news.pause}>
            Pause
          </button>
        )}
        {!news.paused && news.status !== 'running' && (
          <button type="button" class="ghost-btn" onClick={news.refresh}>
            Check now
          </button>
        )}
        {news.notify.supported && (
          <button type="button" class={news.notify.on ? 'btn' : 'ghost-btn'} aria-pressed={news.notify.on} onClick={news.notify.toggle} disabled={news.notify.denied && !news.notify.on}>
            {news.notify.on ? 'Notifications on' : 'Notify me'}
          </button>
        )}
      </div>
      {news.notify.denied && <p class="muted small">Notifications are blocked for this site in your browser's settings.</p>}
      {news.error && <p class="note">Couldn't read ESPN's injury report: {news.error}</p>}
      {!shown.length && !news.error && (
        <p class="muted">
          {news.checkedAt ? 'Nobody with real minutes has been ruled out, or come back, since the last report.' : "Reading ESPN's injury report…"} When someone is, his
          game is simulated with and without him, and the props the news moves most show here.
        </p>
      )}
      {shown.length > 0 && (
        <p class="note caution">
          Books often move props within minutes of news, so check the line before betting. The shift is the simulation as reported minus the other way (him in after a
          scratch, him out after a return). A player upgraded from out isn't certain to play. Hit chances
          count {propMixText()}. The track record grades these as "After news". Suggestions, not advice.
        </p>
      )}
      {shown.map((i) => (
        <NewsEvent key={i.event.key} item={i} team={teams.get(i.event.teamId) ?? ''} entry={log[i.event.gameId]} now={now} onOpen={props.onOpen} />
      ))}
      {quiet.length > 0 && (
        <p class="muted small">
          Also in the news, without real minutes to move: {quiet.map((i) => `${i.event.name} (${teams.get(i.event.teamId) ?? ''})`).join(', ')}.
        </p>
      )}
    </section>
  );
}
