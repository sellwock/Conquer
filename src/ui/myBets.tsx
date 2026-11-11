// "My bets": bets the user logs from the best-bets lists, kept in this browser, with a suggested
// stake from a bankroll they set. Graded from the forward log's box lines.
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import type { Leg } from '../model/parlays';
import { PROP_WORDS } from '../model/parlays';
import { KELLY_SHARE, MAX_STAKE_SHARE, kellyStake } from '../model/stake';
import type { LeagueId } from '../model/types';
import { fmtAmerican } from '../lib/stats';
import { loadPropLog } from '../track/forward';
import { gradeBet, parseBets, summarizeBets, type GradedBet, type MyBet } from '../track/myBets';
import type { PropEntry } from '../track/types';
import { pct, signedPct } from './format';

const BETS_KEY = 'conquer.mybets.v1';
const BANKROLL_KEY = 'conquer.bankroll.v1';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private windows and blocked storage: the list lasts for this visit only */
  }
};

export interface Tracker {
  bets: MyBet[];
  bankroll: number;
  setBankroll: (x: number) => void;
  add: (b: Omit<MyBet, 'id' | 'at'>) => void;
  remove: (id: string) => void;
  /** Adds bets from an exported file, skipping ones already here; returns how many were new. */
  merge: (bets: MyBet[]) => number;
}

export function useTracker(): Tracker {
  const [bets, setBets] = useState<MyBet[]>(() => {
    try {
      return parseBets(JSON.parse(read(BETS_KEY) ?? '[]'));
    } catch {
      return [];
    }
  });
  const [bankroll, setRoll] = useState(() => Number(read(BANKROLL_KEY)) || 0);
  useEffect(() => write(BETS_KEY, JSON.stringify(bets)), [bets]);
  const setBankroll = useCallback((x: number) => {
    const v = Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : 0;
    setRoll(v);
    write(BANKROLL_KEY, String(v));
  }, []);
  const add = useCallback((b: Omit<MyBet, 'id' | 'at'>) => setBets((bs) => [{ ...b, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() }, ...bs]), []);
  const remove = useCallback((id: string) => setBets((bs) => bs.filter((b) => b.id !== id)), []);
  const merge = useCallback(
    (more: MyBet[]) => {
      const have = new Set(bets.map((b) => b.id));
      const fresh = more.filter((b) => !have.has(b.id));
      if (fresh.length) setBets((bs) => [...fresh, ...bs].sort((a, b) => b.at.localeCompare(a.at)));
      return fresh.length;
    },
    [bets],
  );
  return useMemo(() => ({ bets, bankroll, setBankroll, add, remove, merge }), [bets, bankroll, setBankroll, add, remove, merge]);
}

/** The tracker, for the bet lists deep in the page; absent in tests and wherever none is provided. */
export const TrackerContext = createContext<Tracker | undefined>(undefined);

const money = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 2 })}`;

/**
 * Under a listed bet: the suggested stake, and a way to log the bet as placed. `tested` is whether
 * the pick model's record for this kind of line is proven; the stake is halved until it is.
 */
export function LogBet(props: { leg: Leg; league: LeagueId; live?: boolean; tested: boolean }) {
  const t = useContext(TrackerContext);
  const [open, setOpen] = useState(false);
  const l = props.leg;
  const suggested = t ? kellyStake(l.pBlend, l.decimal, t.bankroll, props.tested) : 0;
  const [stake, setStake] = useState('');
  const [price, setPrice] = useState('');
  if (!t || !l.prop) return null;
  const logged = t.bets.find((b) => b.gameId === l.gameId && b.athleteId === l.prop!.athleteId && b.stat === l.prop!.stat && b.side === l.side && b.line === l.prop!.line);
  if (logged)
    return (
      <span class="bet-log">
        Logged {money(logged.stake)} at {fmtAmerican(logged.price)}
      </span>
    );
  if (!open)
    return (
      <span class="bet-log">
        {suggested > 0 && <>Stake {money(suggested)} · </>}
        <button
          type="button"
          class="link"
          onClick={() => {
            setStake(suggested > 0 ? String(suggested) : '');
            setPrice(String(l.price));
            setOpen(true);
          }}
        >
          Log this bet
        </button>
      </span>
    );
  const s = Number(stake), p = Number(price);
  const ok = s > 0 && Number.isFinite(p) && Math.abs(p) >= 100;
  return (
    <form
      class="bet-log bet-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        t.add({ league: props.league, gameId: l.gameId, game: l.game, athleteId: l.prop!.athleteId, player: l.prop!.player, stat: l.prop!.stat, line: l.prop!.line, side: l.side as 'over' | 'under', listed: l.price, price: p, stake: s, pFit: l.pBlend, pFair: l.pFair, ...(props.live ? { live: true } : {}) });
        setOpen(false);
      }}
    >
      <label>
        Stake $ <input type="number" inputMode="decimal" min="0" step="0.01" value={stake} onInput={(e) => setStake((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label>
        Price you got <input type="number" inputMode="numeric" step="1" value={price} onInput={(e) => setPrice((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <button type="submit" class="btn" disabled={!ok}>
        Save
      </button>
      <button type="button" class="ghost-btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** Where the suggested stakes come from: the bankroll, and what the rule is. */
export function BankrollNote() {
  const t = useContext(TrackerContext);
  if (!t) return null;
  return (
    <p class="muted small bankroll">
      <label>
        Bankroll ${' '}
        <input type="number" inputMode="decimal" min="0" step="1" value={t.bankroll || ''} placeholder="0" onChange={(e) => t.setBankroll(Number((e.currentTarget as HTMLInputElement).value))} />
      </label>{' '}
      {t.bankroll > 0
        ? `Stakes are a quarter of the Kelly fraction, capped at ${pct(MAX_STAKE_SHARE, 0)} of it, and halved until the record reads Tested.`
        : 'Set one to see a stake for each bet.'}{' '}
      <a href="#view=bets">My bets</a>
    </p>
  );
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The My bets view: what was logged, how it has done, and export / import. */
export function MyBets(props: { league: LeagueId }) {
  const t = useContext(TrackerContext);
  const [log, setLog] = useState<Record<string, PropEntry>>({});
  const [note, setNote] = useState('');
  const leagues = [...new Set((t?.bets ?? []).map((b) => b.league))].sort().join();
  useEffect(() => {
    if (!leagues) return;
    const ac = new AbortController();
    Promise.all((leagues.split(',') as LeagueId[]).map((l) => loadPropLog(l, ac.signal)))
      .then((all) => setLog(Object.fromEntries(all.flat().map((e) => [e.id, e]))))
      .catch(() => {});
    return () => ac.abort();
  }, [leagues]);
  const graded = useMemo(() => (t?.bets ?? []).map((b) => gradeBet(b, log[b.gameId])), [t?.bets, log]);
  const s = useMemo(() => summarizeBets(graded), [graded]);
  if (!t) return null;
  const decided = s.win + s.loss;
  const movedAll = s.moved.toward + s.moved.away + s.moved.same;
  const cell = (g: GradedBet) =>
    !g.result ? <span class="muted">Open</span> : g.result === 'win' ? <span class="pos">Won {money(g.profit!)}</span> : g.result === 'loss' ? <span class="neg">Lost {money(-g.profit!)}</span> : <span class="muted">{g.result === 'push' ? 'Push' : 'Void'}</span>;
  return (
    <div class="record">
      <section class="card">
        <header class="card-head">
          <h2>My bets</h2>
          <p class="muted small">Kept in this browser only</p>
        </header>
        <p class="muted">
          Bets you log from the best-bets lists, with the stake and the price you got. They're graded from the saved box scores once a game is final, usually within a few
          hours. Nothing here leaves your device; export a copy to keep it or move it.
        </p>
        <BankrollNote />
        <div class="scan">
          <button type="button" class="ghost-btn" disabled={!t.bets.length} onClick={() => download('conquer-bets.json', JSON.stringify({ v: 1, bankroll: t.bankroll, bets: t.bets }, null, 1))}>
            Export
          </button>
          <label class="ghost-btn">
            Import
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const f = (e.currentTarget as HTMLInputElement).files?.[0];
                if (!f) return;
                try {
                  const added = t.merge(parseBets(JSON.parse(await f.text())));
                  setNote(`${added} bet${added === 1 ? '' : 's'} added.`);
                } catch {
                  setNote("That file isn't a bets export.");
                }
              }}
            />
          </label>
          {note && <span class="muted small">{note}</span>}
        </div>
      </section>
      {t.bets.length > 0 && (
        <section class="card stats-row" aria-label="How my bets have done">
          <div class="stat">
            <span class="kicker">Record</span>
            <strong>
              {s.win}-{s.loss}
            </strong>
            <span class="muted">
              {decided ? `${pct(s.win / decided)} won; the pick model said ${pct(s.said)}` : 'No decided bets yet'}
              {s.open ? ` · ${s.open} open` : ''}
              {s.returned ? ` · ${s.returned} returned` : ''}
            </span>
          </div>
          <div class="stat">
            <span class="kicker">Profit</span>
            <strong class={s.profit > 0 ? 'pos' : s.profit < 0 ? 'neg' : ''}>{money(s.profit)}</strong>
            <span class="muted">{decided ? `${signedPct(s.roi)} on ${money(s.staked)} staked` : 'on decided bets'}</span>
          </div>
          <div class="stat">
            <span class="kicker">Price you got</span>
            <strong>{signedPct(-s.slippage)}</strong>
            <span class="muted">break-even chance against the listed price, on average (negative means you paid more)</span>
          </div>
          {movedAll > 0 && (
            <div class="stat">
              <span class="kicker">Beat the close</span>
              <strong>{pct(s.moved.toward / movedAll, 0)}</strong>
              <span class="muted">
                {s.moved.toward} of {movedAll} pre-game bets saw the line move their way by tip ({s.moved.away} away, {s.moved.same} unchanged)
              </span>
            </div>
          )}
        </section>
      )}
      <section class="card">
        {t.bets.length ? (
          <div class="table-wrap">
            <table class="data props-table">
              <thead>
                <tr>
                  <th scope="col">Bet</th>
                  <th scope="col" class="num">
                    Stake
                  </th>
                  <th scope="col" class="num">
                    Price
                  </th>
                  <th scope="col">Result</th>
                  <th scope="col">
                    <span class="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {graded.map((g) => (
                  <tr key={g.bet.id}>
                    <th scope="row">
                      {g.bet.player} {g.bet.side} {g.bet.line} {PROP_WORDS[g.bet.stat]}
                      <br />
                      <span class="muted small">
                        {new Date(g.bet.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {g.bet.game}
                        {g.bet.live ? ' · live' : ''} · fit {pct(g.bet.pFit, 0)}
                        {g.final != null ? ` · finished with ${g.final}` : ''}
                      </span>
                    </th>
                    <td class="num">{money(g.bet.stake)}</td>
                    <td class="num">{fmtAmerican(g.bet.price)}</td>
                    <td>{cell(g)}</td>
                    <td>
                      <button type="button" class="link" aria-label={`Remove ${g.bet.player} ${g.bet.side} ${g.bet.line}`} onClick={() => t.remove(g.bet.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">
            No bets logged yet. Each pick under <a href={`#view=slate&league=${props.league}`}>Best bets</a> has a "Log this bet" link.
          </p>
        )}
        <p class="muted small">
          A bet is void when the player didn't play, as at the book. A game the scheduled job didn't log stays open; remove it once you've settled it yourself. Even
          at {pct(KELLY_SHARE, 0)} of Kelly, a long run of losses is normal with edges this thin.
        </p>
      </section>
    </div>
  );
}
