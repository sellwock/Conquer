import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildSpec, type BuildOptions, type BuiltSpec } from '../model/build';
import type { GameData, GameSnapshot, ScoreboardGame } from '../model/types';
import { loadGame, loadScoreboard, refreshGame, snapshotAtPlay, snapshotFromGame } from '../data/espn/load';
import { loadProps, type PropBoard } from '../data/espn/props';
import { propMarkets } from '../model/props';
import { DataError, getProxy, setProxy } from '../data/espn/client';
import { demoGame } from '../data/demo';
import { CancelledError, runInBackground, runQuickInBackground, type Job } from '../sim/client';
import type { SimSummary } from '../sim/run';
import { DEFAULTS, parseHash, toHash, type Tab, type UrlState } from './state';
import { yyyymmdd } from './format';
import { prefersDark, teamPair } from './colors';
import { TopBar, GameStrip } from './header';
import { Scoreboard, type LiveState } from './scoreboard';
import { Poller } from './live';
import { Sheet } from './sheet';
import { Outlook } from './outlook';
import { TypicalGame } from './typical';
import { Players, type ImpactRow } from './players';
import { Recent } from './recent';
import { Flow } from './flow';
import { Method } from './method';
import { Parlays } from './parlays';
import { TrackRecord } from './record';
import { SlateBoard } from './slate';
import { marketFrom, useSlate } from './useSlate';

export interface SimState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  scenario?: SimSummary;
  baseline?: SimSummary;
  built?: BuiltSpec;
  options?: BuildOptions;
  error?: string;
  /** Set when this simulation prices the open game for the parlays tab (a pre-game run from tip). */
  market?: { note?: string };
}

/** The open game's posted player props. */
export interface PropState {
  gameId: string;
  status: 'loading' | 'ok' | 'error';
  board?: PropBoard;
}

export interface Palette {
  home: string;
  away: string;
  dark: boolean;
}

const SAMPLE_GAMES = 10;
/** Start polling an upcoming game this long before tip. */
const LIVE_LEAD_MS = 15 * 60_000;
export const IMPACT_SIMS = 2000;
const NO_GAMES: ScoreboardGame[] = [];

export function App() {
  const [url, setUrl] = useState<UrlState>(() => {
    const s = parseHash(location.hash);
    return { ...s, date: s.date ?? yyyymmdd(new Date()) };
  });
  const [board, setBoard] = useState<{ status: 'loading' | 'ok' | 'error'; games: ScoreboardGame[]; error?: string }>({ status: 'loading', games: [] });
  const [game, setGame] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; data?: GameData; msg?: string; error?: string }>({ status: 'idle' });
  const [sim, setSim] = useState<SimState>({ status: 'idle', progress: 0 });
  const [impact, setImpact] = useState<{ status: 'idle' | 'running' | 'done'; rows: ImpactRow[] }>({ status: 'idle', rows: [] });
  const [offline, setOffline] = useState(false);
  const [dark, setDark] = useState(prefersDark());
  // Simulated games on the current date with posted lines, for the slate board and parlays.
  const slate = useSlate(url.league, url.date!, board.status === 'ok' ? board.games : NO_GAMES, url.seed, url.game, url.view === 'slate');

  // --- URL sync ---------------------------------------------------------------------------------
  const update = useCallback((patch: Partial<UrlState>) => setUrl((u) => ({ ...u, ...patch })), []);
  useEffect(() => {
    const h = toHash(url);
    if (h !== location.hash && !(h === '#' && !location.hash)) history.replaceState(null, '', h === '#' ? location.pathname + location.search : h);
  }, [url]);
  useEffect(() => {
    const onHash = () => {
      const s = parseHash(location.hash);
      setUrl((u) => (toHash(u) === location.hash ? u : { ...s, date: s.date ?? u.date }));
    };
    addEventListener('hashchange', onHash);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => setDark(prefersDark());
    mq.addEventListener?.('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      removeEventListener('hashchange', onHash);
      mq.removeEventListener?.('change', onTheme);
      mo.disconnect();
    };
  }, []);

  // Effects that finish later must see the game selected *now*, not when they started.
  const urlRef = useRef(url);
  urlRef.current = url;
  const jobs = useRef<Job<unknown>[]>([]);
  const cancelJobs = () => {
    jobs.current.forEach((j) => j.cancel());
    jobs.current = [];
  };

  // --- Scoreboard -------------------------------------------------------------------------------
  useEffect(() => {
    const ac = new AbortController();
    setBoard((b) => ({ status: 'loading', games: b.games }));
    loadScoreboard(url.league, url.date!, ac.signal)
      .then((games) => {
        setOffline(false);
        setBoard({ status: 'ok', games });
        if (!urlRef.current.game && games.length) {
          const pick = games.find((g) => g.phase === 'in') ?? games.find((g) => g.phase === 'pre') ?? games[0];
          update({ game: pick.id });
        }
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setBoard({ status: 'error', games: [], error: e?.message ?? String(e) });
        // No network path to ESPN at all (offline, or an embed that blocks requests): show the sample.
        if (e instanceof DataError && e.status == null) {
          setOffline(true);
          if (!urlRef.current.game) update({ game: 'demo' });
        }
      });
    return () => ac.abort();
  }, [url.league, url.date]);

  // --- Game data --------------------------------------------------------------------------------
  useEffect(() => {
    // Never show one game's results under another game's teams.
    cancelJobs();
    setSim({ status: 'idle', progress: 0 });
    if (!url.game) return;
    if (url.game === 'demo') {
      setGame({ status: 'ok', data: demoGame() });
      return;
    }
    const ac = new AbortController();
    setGame({ status: 'loading', msg: 'Loading game' });
    setImpact({ status: 'idle', rows: [] });
    loadGame(url.league, url.game, { sampleGames: SAMPLE_GAMES, signal: ac.signal, onStatus: (msg) => setGame((g) => ({ ...g, msg })) })
      .then((data) => setGame({ status: 'ok', data }))
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setGame({ status: 'error', error: e?.message ?? String(e) });
        if (e instanceof DataError && e.status == null) setOffline(true);
      });
    return () => ac.abort();
  }, [url.league, url.game]);

  const data = game.status === 'ok' ? game.data : undefined;

  // --- Live refresh -----------------------------------------------------------------------------
  // Live games, and games about to tip, re-read ESPN's summary every 30 seconds.
  const [live, setLive] = useState<LiveState | undefined>();
  const dataRef = useRef(data);
  dataRef.current = data;
  const [, wake] = useState(0);
  const tipIn = data?.phase === 'pre' ? Date.parse(data.date) - Date.now() : Infinity;
  const pollable = url.view === 'game' && !!data && !data.demo && (data.phase === 'in' || tipIn < LIVE_LEAD_MS);
  useEffect(() => {
    // Wake up when an upcoming game gets close enough to tip to start polling.
    if (pollable || !(tipIn > 0 && tipIn < 12 * 3_600_000)) return;
    const t = setTimeout(() => wake((x) => x + 1), tipIn - LIVE_LEAD_MS + 1000);
    return () => clearTimeout(t);
  }, [data?.id, pollable]);
  useEffect(() => {
    setLive(undefined);
    if (!pollable) return;
    const id = data!.id;
    setLive({});
    const p = new Poller({
      tick: async (signal) => {
        const cur = dataRef.current;
        if (!cur || cur.id !== id) return false;
        const next = await refreshGame(cur, signal);
        setGame((g) => (g.data?.id === id ? { ...g, data: next } : g));
        setLive({ updatedAt: Date.now() });
        return next.phase !== 'post';
      },
      onError: () => setLive((l) => ({ ...l, failing: true })),
    });
    p.start();
    return () => p.stop();
  }, [data?.id, pollable]);

  // A refresh replaces the game object; the simulation only re-runs when it reads what changed:
  // the live state (simulating from now, or as-played minutes) or the game starting or ending.
  const readsLive = !!data && data.phase !== 'pre' && (url.from === 'now' || url.mode === 'actual');
  const simKey = data ? [data.id, data.phase, readsLive ? [data.period, data.clockSec, data.homeScore, data.awayScore].join(':') : ''].join('|') : '';
  const simData = useMemo(() => data, [simKey]);

  // Ids in the link that match nobody on either roster (e.g. NBA.com ids from another site).
  const unknownOuts = useMemo(() => {
    if (!data) return [];
    const ids = new Set([...data.home.players, ...data.away.players].map((p) => p.id));
    return url.outs.filter((id) => !ids.has(id));
  }, [data, url.outs]);

  // --- Simulation -------------------------------------------------------------------------------
  const start = useMemo((): GameSnapshot | undefined => {
    if (!simData) return undefined;
    if (url.from === 'now') return snapshotFromGame(simData);
    const seq = Number(url.from);
    if (url.from !== 'tip' && Number.isFinite(seq)) return snapshotAtPlay(simData, seq);
    return undefined;
  }, [simData, url.from]);

  useEffect(() => {
    if (!simData) return;
    const timer = setTimeout(() => {
      cancelJobs();
      const options: BuildOptions = {
        outs: new Set(url.outs),
        ins: new Set(url.ins),
        whistle: url.whistle,
        homeCourt: url.hca,
        minutesMode: simData.phase === 'pre' ? 'projected' : url.mode,
        start,
      };
      let built: BuiltSpec;
      let base: BuiltSpec | undefined;
      try {
        built = buildSpec(simData, options);
        const anyOut = [...built.plans.home.unavailable, ...built.plans.away.unavailable].length > 0;
        if (anyOut && options.minutesMode === 'projected') base = buildSpec(simData, { ...options, healthy: true });
      } catch (e) {
        setSim({ status: 'error', progress: 0, error: (e as Error).message });
        return;
      }
      setSim((s) => ({ ...s, status: 'running', progress: 0, built, options, error: undefined }));
      const main = runInBackground(built.spec, url.n, url.seed, (done) => setSim((s) => ({ ...s, progress: done / url.n })));
      const bl = base ? runInBackground(base.spec, Math.min(url.n, 5000), url.seed) : undefined;
      jobs.current = [main, ...(bl ? [bl] : [])];
      Promise.all([main.promise, bl?.promise])
        .then(([scenario, baseline]) => {
          const tweaks = [
            url.outs.length ? `${url.outs.length} ruled out by you` : '',
            url.ins.length ? `${url.ins.length} injured player${url.ins.length > 1 ? 's' : ''} cleared` : '',
            url.whistle !== 1 ? 'custom whistle' : '',
            !url.hca ? 'no home court' : '',
          ].filter(Boolean);
          const market = start ? undefined : { note: tweaks.length ? `your scenario (${tweaks.join(', ')})` : undefined };
          setSim({ status: 'done', progress: 1, scenario, baseline, built, options, market });
        })
        .catch((e) => {
          if (e instanceof CancelledError) return;
          setSim((s) => ({ ...s, status: 'error', error: (e as Error).message }));
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [simData, url.outs.join(), url.ins.join(), url.n, url.seed, url.whistle, url.hca, url.mode, start]);

  useEffect(() => () => cancelJobs(), []);

  // Posted player props for the open game, fetched once per game before tip-off.
  const [props, setProps] = useState<PropState>();
  const propGame = simData && simData.phase === 'pre' && !simData.demo ? simData : undefined;
  useEffect(() => {
    if (!propGame) return setProps(undefined);
    const ac = new AbortController();
    const gameId = propGame.id;
    setProps({ gameId, status: 'loading' });
    loadProps(propGame.league, gameId, ac.signal)
      .then((board) => setProps({ gameId, status: 'ok', board }))
      .catch((e) => {
        if ((e as Error)?.name !== 'AbortError') setProps({ gameId, status: 'error' });
      });
    return () => ac.abort();
  }, [propGame?.id, propGame?.league]);

  // The open game's market for the parlays tab: the simulation's outcomes plus any props.
  useEffect(() => {
    const sc = sim.scenario;
    if (!simData || !sc || !sim.market) return;
    const lines = props?.gameId === simData.id ? (props.board?.lines ?? []) : [];
    const po = sc.outcomes.players;
    const m = marketFrom(simData, sc.outcomes, sim.market.note, po && lines.length ? propMarkets(lines, po, sc.players) : undefined);
    if (m) slate.put(m);
  }, [sim.scenario, sim.market, props]);
  useEffect(() => setImpact({ status: 'idle', rows: [] }), [simData, url.outs.join(), url.ins.join(), url.n, url.seed, url.whistle, url.hca, url.mode, start]);

  const runImpact = useCallback(() => {
    if (!simData || !sim.built || !sim.options) return;
    const opts = sim.options;
    const cand = [simData.home, simData.away].flatMap((t, side) =>
      t.players
        .filter((p) => (side === 0 ? sim.built!.plans.home : sim.built!.plans.away).minutes[p.id] >= 14)
        .sort((a, b) => (side === 0 ? sim.built!.plans.home : sim.built!.plans.away).minutes[b.id] - (side === 0 ? sim.built!.plans.home : sim.built!.plans.away).minutes[a.id])
        .slice(0, 8)
        .map((p) => ({ p, side: side as 0 | 1 })),
    );
    const specs = [buildSpec(simData, opts).spec, ...cand.map(({ p }) => buildSpec(simData, { ...opts, outs: new Set([...opts.outs, p.id]) }).spec)];
    setImpact({ status: 'running', rows: [] });
    const n = IMPACT_SIMS;
    const chunks = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
    const per = Math.ceil(specs.length / chunks);
    const parts = Array.from({ length: chunks }, (_, i) => specs.slice(i * per, (i + 1) * per)).filter((c) => c.length);
    const js = parts.map((c) => runQuickInBackground(c, n, url.seed + ':impact'));
    jobs.current.push(...js);
    Promise.all(js.map((j) => j.promise))
      .then((res) => {
        const flat = res.flat();
        const base = flat[0];
        const rows: ImpactRow[] = cand.map(({ p, side }, i) => {
          const r = flat[i + 1];
          const own = side === 0 ? base.homeWin - r.homeWin : r.homeWin - base.homeWin;
          const pts = side === 0 ? base.margin - r.margin : r.margin - base.margin;
          return { id: p.id, name: p.short, side, winSwing: own, pointSwing: pts };
        });
        rows.sort((a, b) => b.winSwing - a.winSwing);
        setImpact({ status: 'done', rows });
      })
      .catch(() => setImpact({ status: 'idle', rows: [] }));
  }, [simData, sim.built, sim.options, url.seed]);

  // --- Theme colors -----------------------------------------------------------------------------
  const palette: Palette | undefined = useMemo(() => {
    if (!data) return undefined;
    const surface = dark ? '#161b22' : '#ffffff';
    const [home, away] = teamPair(data.home, data.away, surface, dark);
    return { home, away, dark };
  }, [data, dark]);

  const setTab = (tab: Tab) => update({ tab });

  const togglePlayer = useCallback(
    (id: string, injuredOut: boolean) => {
      setUrl((u) => {
        if (u.outs.includes(id)) return { ...u, outs: u.outs.filter((x) => x !== id) };
        if (injuredOut) return u.ins.includes(id) ? { ...u, ins: u.ins.filter((x) => x !== id) } : { ...u, ins: [...u.ins, id] };
        return { ...u, outs: [...u.outs, id] };
      });
    },
    [],
  );

  return (
    <div class="app">
      <TopBar
        view={url.view}
        onView={(view) => update({ view })}
        league={url.league}
        date={url.date!}
        onLeague={(league) => update({ league, game: undefined, outs: [], ins: [], from: 'tip', mode: 'projected' })}
        onDate={(date) => update({ date, game: undefined, outs: [], ins: [], from: 'tip', mode: 'projected' })}
        onSample={() => update({ game: 'demo', outs: [], ins: [], from: 'tip', mode: 'projected' })}
      />
      {url.view === 'record' ? (
        <TrackRecord league={url.league} />
      ) : url.view === 'slate' ? (
        <SlateBoard
          league={url.league}
          date={url.date!}
          board={board}
          slate={slate}
          openGame={url.game}
          onOpen={(id) => update({ view: 'game', game: id, outs: [], ins: [], from: 'tip', mode: 'projected' })}
        />
      ) : (
        <>
      {offline && (
        <div class="banner" role="status">
          {url.game === 'demo'
            ? "ESPN's live data can't be reached from here, so you're looking at a synthetic sample matchup. Everything else works the same."
            : "ESPN's live data can't be reached from here. Open the sample matchup to try the simulator, or retry once you're online."}
          <button type="button" class="link" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      )}
      <GameStrip board={offline ? { ...board, error: undefined, status: board.games.length ? 'ok' : 'empty' } : board} selected={url.game} onSelect={(id) => update({ game: id, outs: [], ins: [], from: 'tip', mode: 'projected', tab: url.tab })} />
      {game.status === 'loading' && <div class="loading-panel"><span class="spinner" aria-hidden="true" />{game.msg}…</div>}
      {game.status === 'error' && (
        <div class="error-panel" role="alert">
          <p>{game.error}</p>
          <button type="button" class="btn" onClick={() => update({ game: 'demo' })}>Open the sample matchup</button>
        </div>
      )}
      {!url.game && board.status === 'ok' && !board.games.length && <div class="empty-panel">No games on this date. Pick another day.</div>}
      {data && palette && (
        <>
          <Scoreboard game={data} sim={sim} palette={palette} start={start} live={live} />
          <main class="workspace">
            <Sheet
              game={data}
              url={url}
              sim={sim}
              palette={palette}
              unknownOuts={unknownOuts}
              onToggle={togglePlayer}
              onChange={update}
              onReset={() => update({ outs: [], ins: [] })}
            />
            <section class="results" aria-label="Simulation results">
              <nav class="tabs" role="tablist">
                {(
                  [
                    ['outlook', 'Outlook'],
                    ['typical', 'Typical game'],
                    ['players', 'Players'],
                    ['recent', 'Last 5'],
                    ['parlays', 'Parlays'],
                    ['flow', data.phase === 'pre' ? 'Runs' : 'Game flow'],
                    ['method', 'Method'],
                  ] as [Tab, string][]
                ).map(([t, label]) => (
                  <button key={t} type="button" role="tab" aria-selected={url.tab === t} class={url.tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
                    {label}
                  </button>
                ))}
              </nav>
              {url.tab === 'recent' && (
                <div class="tabpanel" role="tabpanel">
                  <Recent game={data} summary={sim.scenario} palette={palette} />
                </div>
              )}
              {url.tab !== 'recent' && sim.status === 'error' && <div class="error-panel" role="alert">The simulation failed: {sim.error}</div>}
              {url.tab !== 'recent' && !sim.scenario && sim.status !== 'error' && <div class="loading-panel"><span class="spinner" aria-hidden="true" />Simulating {url.n.toLocaleString()} games…</div>}
              {url.tab !== 'recent' && sim.scenario && sim.built && (
                <div class={sim.status === 'running' ? 'tabpanel stale' : 'tabpanel'} role="tabpanel">
                  {url.tab === 'outlook' && <Outlook game={data} sim={sim as Required<SimState>} palette={palette} start={start} />}
                  {url.tab === 'typical' && <TypicalGame game={data} summary={sim.scenario} built={sim.built} palette={palette} />}
                  {url.tab === 'players' && <Players game={data} summary={sim.scenario} built={sim.built} palette={palette} impact={impact} onImpact={runImpact} />}
                  {url.tab === 'flow' && (
                    <Flow game={data} summary={sim.scenario} palette={palette} from={url.from} onFrom={(from) => update({ from })} />
                  )}
                  {url.tab === 'parlays' && (
                    <Parlays
                      game={data}
                      markets={slate.markets}
                      remaining={slate.pending.length}
                      scan={slate.scan}
                      onScan={slate.start}
                      onCancelScan={slate.stop}
                      onOpen={(id) => update({ game: id, outs: [], ins: [], from: 'tip', mode: 'projected', tab: 'parlays' })}
                      props={props}
                    />
                  )}
                  {url.tab === 'method' && <Method game={data} />}
                </div>
              )}
            </section>
          </main>
        </>
      )}
        </>
      )}
      <footer class="foot">
        <p>
          Data: ESPN public scoreboard, summary, roster and schedule feeds. Projections are simulations, not predictions of record.{' '}
          <button type="button" class="link" onClick={() => update({ ...DEFAULTS, date: url.date, league: url.league, game: url.game })}>
            Reset all settings
          </button>
        </p>
        <ProxySettings />
      </footer>
    </div>
  );
}

/** Optional CORS proxy for hosts where ESPN's API can't be called directly. */
function ProxySettings() {
  const [value, setValue] = useState(getProxy());
  const [saved, setSaved] = useState(false);
  return (
    <details class="settings">
      <summary>Data connection</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setProxy(value);
          setSaved(true);
          setTimeout(() => location.reload(), 400);
        }}
      >
        <label for="proxy">Proxy prefix (optional). Requests go to this prefix plus the ESPN URL; use {'{url}'} to place an encoded URL instead.</label>
        <div class="settings-row">
          <input id="proxy" type="url" placeholder="https://your-proxy.example/?url={url}" value={value} onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)} />
          <button type="submit" class="btn">
            {saved ? 'Saved' : 'Save and reload'}
          </button>
        </div>
      </form>
    </details>
  );
}
