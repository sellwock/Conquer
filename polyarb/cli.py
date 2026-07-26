"""Command line interface.

Start with `measure`. It is one command — discover, record, analyse, verdict — and it
answers the only question that decides whether any of this is worth funding: do gaps
that clear fees actually exist, and do they last long enough for us to reach them?
It needs no wallet, no funds and no API keys, because it only reads the public feed.

The individual rungs exist for when you want them separately:

    doctor -> discover -> record -> analyze -> replay -> paper -> live

Each answers a question the next depends on. `live` refuses to run until you have
said, explicitly and twice, that you want real money at risk.
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib.util
import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

import typer
from rich.console import Console
from rich.table import Table

from .analysis import analyse_frames
from .config import CLOB_API, DEFAULT_FEE_RATES, Settings
from .discovery import discover
from .execution.paper import PaperEngine
from .feed import FrameRecorder, MarketFeed, replay_frames
from .fees import breakeven_spread
from .journal import Journal, summarise, summarise_dir, read_journal
from .latency import compare_to_assumed, probe_rest_rtt
from .models import Market
from .risk import RiskManager
from .runner import Runner

app = typer.Typer(add_completion=False, help="Polymarket binary-complement arbitrage bot")
console = Console()


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def _load_settings(config: Optional[Path]) -> Settings:
    return Settings.load(config)


def _save_markets(path: Path, markets: list[Market]) -> None:
    path.write_text(json.dumps([dataclasses.asdict(m) for m in markets], indent=2))


def _load_markets(path: Path) -> dict[str, Market]:
    rows = json.loads(Path(path).read_text())
    markets = [Market(**r) for r in rows]
    return {m.condition_id: m for m in markets}


# --------------------------------------------------------------------------
@app.command()
def doctor(
    config: Optional[Path] = typer.Option(None, help="YAML config file"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Check connectivity, credentials and every unverified assumption.

    Run this first, on a machine with network access. It is the only place the
    assumptions this bot was built on get checked against reality.
    """
    _setup_logging(verbose)
    s = _load_settings(config)
    ok = True

    table = Table(title="polyarb doctor", show_lines=False)
    table.add_column("check")
    table.add_column("result")
    table.add_column("detail", overflow="fold")

    def row(name: str, passed: bool | None, detail: str = "") -> None:
        nonlocal ok
        if passed is False:
            ok = False
        mark = {True: "[green]pass[/]", False: "[red]FAIL[/]", None: "[yellow]warn[/]"}[passed]
        table.add_row(name, mark, detail)

    # Secrets
    row("credentials present", s.has_credentials() or None,
        "set in env" if s.has_credentials() else "missing — paper mode only")

    # Gamma reachability
    try:
        markets = asyncio.run(discover(s.discovery))
        row("gamma api", True, f"{len(markets)} tradable markets after filters")
        if markets:
            m = markets[0]
            row("market parsing", True,
                f"e.g. {m.slug} tick={m.tick_size} min={m.min_order_size} cat={m.category or '?'}")
        uncategorised = [m for m in markets if not m.category]
        if uncategorised:
            row("category coverage", None,
                f"{len(uncategorised)} markets have no recognised category and will be "
                f"priced at the worst fee rate ({s.unknown_fee_rate})")
    except Exception as e:
        row("gamma api", False, f"{type(e).__name__}: {e}")

    # SDK availability. `find_spec` answers "is it installed?" without actually
    # importing it — the SDK is only ever needed on the live path, and `doctor`
    # should not pull it into memory just to tick a box.
    if importlib.util.find_spec("py_clob_client_v2") is not None:
        row("py-clob-client-v2", True, "installed")
    else:
        row("py-clob-client-v2", None, "not installed — required only for live mode")

    # Latency. This is checked hard rather than warned about: `assumed_latency_ms`
    # is what the paper engine uses to decide whether an opportunity would still be
    # there on arrival, so an optimistic value does not produce a small error — it
    # produces encouraging results that are entirely fictional.
    try:
        if markets:
            url = f"{CLOB_API}/book?token_id={markets[0].yes_token_id}"
            samples = asyncio.run(probe_rest_rtt(url, count=10))
            ok_latency, message = compare_to_assumed(
                samples, s.execution.assumed_latency_ms
            )
            row("latency vs assumed", ok_latency, message)
            if len(samples):
                row("latency detail", None, json.dumps(samples.summary()))
    except Exception as e:
        row("latency vs assumed", False, f"{type(e).__name__}: {e}")

    # Assumptions that could not be verified offline.
    row("VERIFY fee model", None,
        "fee = shares x rate x p x (1-p), taker only. Confirm against a real fill; "
        "the live engine halts automatically if charged fees diverge from this.")
    row("VERIFY pUSD address", bool(s.pusd_address) or None,
        s.pusd_address or "not configured — set `pusd_address` before live settlement")
    row("VERIFY fee rates", None,
        ", ".join(f"{k}={v}" for k, v in sorted(DEFAULT_FEE_RATES.items())))

    console.print(table)

    console.print("\n[bold]Fee reality check[/] — gross gap needed just to break even:")
    fee_table = Table()
    fee_table.add_column("price")
    for cat in ("geopolitics", "politics", "sports", "crypto"):
        fee_table.add_column(f"{cat}\n({DEFAULT_FEE_RATES[cat]})")
    for price in (0.50, 0.75, 0.90, 0.95, 0.99):
        cells = [f"{price:.2f}"]
        for cat in ("geopolitics", "politics", "sports", "crypto"):
            cells.append(f"{breakeven_spread(price, DEFAULT_FEE_RATES[cat]) * 100:.2f}c")
        fee_table.add_row(*cells)
    console.print(fee_table)

    if not ok:
        console.print("\n[red]Some checks failed. Do not enable live trading.[/]")
        raise typer.Exit(1)
    console.print("\n[green]Checks passed.[/] Next: `polyarb discover`, then `polyarb record`.")


# --------------------------------------------------------------------------
@app.command(name="discover")
def discover_cmd(
    config: Optional[Path] = typer.Option(None, "--config"),
    out: Optional[Path] = typer.Option(None, help="Write the market list to JSON"),
    limit: int = typer.Option(30, help="Rows to display"),
) -> None:
    """List tradable markets, ranked by how cheap they are to trade."""
    _setup_logging(False)
    s = _load_settings(config)
    markets = asyncio.run(discover(s.discovery))

    table = Table(title=f"{len(markets)} candidate markets")
    table.add_column("slug", overflow="fold", max_width=44)
    table.add_column("category")
    table.add_column("fee rate", justify="right")
    table.add_column("liquidity", justify="right")
    table.add_column("tick", justify="right")
    table.add_column("min", justify="right")

    for m in markets[:limit]:
        rate = s.fee_rate_for(m.category)
        table.add_row(
            m.slug, m.category or "[red]?[/]",
            f"{rate:.3f}" if rate else "[green]0[/]",
            f"{m.liquidity:,.0f}", f"{m.tick_size}", f"{m.min_order_size:g}",
        )
    console.print(table)

    if out:
        _save_markets(out, markets)
        console.print(f"wrote {len(markets)} markets to {out}")


# --------------------------------------------------------------------------
@app.command()
def record(
    minutes: float = typer.Option(60.0, help="How long to record"),
    config: Optional[Path] = typer.Option(None, "--config"),
    out_dir: Optional[Path] = typer.Option(None, help="Where to write the recording"),
    rotate_minutes: float = typer.Option(
        60.0, help="Split output every N minutes (0 = one file)"
    ),
) -> None:
    """Capture live websocket frames for offline replay.

    This is how the bot gets tested against real market behaviour without risking
    anything: record here, then `replay` as many times as you like.
    """
    _setup_logging(False)
    s = _load_settings(config)
    directory = Path(out_dir or s.recording_dir)
    directory.mkdir(parents=True, exist_ok=True)

    markets = asyncio.run(discover(s.discovery))
    if not markets:
        console.print("[red]no markets matched the discovery filters[/]")
        raise typer.Exit(1)



    stamp = time.strftime("%Y%m%d-%H%M%S")
    frames_path = directory / f"{stamp}-frames.jsonl"
    markets_path = directory / f"{stamp}-markets.json"
    _save_markets(markets_path, markets)

    asset_ids = [tid for m in markets for tid in m.token_ids]
    console.print(
        f"recording {len(asset_ids)} tokens across {len(markets)} markets "
        f"for {minutes:g} min -> {frames_path}"
    )

    rec = _capture(
        s, asset_ids, frames_path, seconds=minutes * 60,
        rotate_seconds=(rotate_minutes * 60) if rotate_minutes > 0 else None,
    )
    console.print(
        f"[green]recorded {rec.count} frames[/] across {len(rec.paths)} "
        f"file(s) in {directory}"
    )


def _bytes_on_disk(paths: list[Path]) -> int:
    total = 0
    for p in paths:
        try:
            total += p.stat().st_size
        except OSError:
            pass
    return total


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def _capture(
    s: Settings,
    asset_ids: list[str],
    frames_path: Path,
    *,
    seconds: float,
    rotate_seconds: float | None,
    progress_every_s: float = 300.0,
) -> FrameRecorder:
    """Run the market feed into a recorder for `seconds`.

    Ctrl-C stops the capture cleanly rather than killing the process, so a partial
    run still leaves a usable recording — losing 30 hours of capture to an impatient
    keystroke would be an expensive way to learn that lesson.
    """
    rec = FrameRecorder(frames_path, rotate_seconds=rotate_seconds)

    async def _run() -> None:
        feed = MarketFeed(
            asset_ids, lambda frame: None, recorder=rec,
            assets_per_connection=s.discovery.assets_per_connection,
        )
        task = asyncio.create_task(feed.run())
        started = time.monotonic()
        try:
            while True:
                elapsed = time.monotonic() - started
                remaining = seconds - elapsed
                if remaining <= 0:
                    break
                await asyncio.sleep(min(progress_every_s, remaining))
                _report_progress(rec, time.monotonic() - started, seconds)
        finally:
            feed.stop()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        console.print("\n[yellow]interrupted — keeping what was captured[/]")
    finally:
        rec.close()
    return rec


def _report_progress(rec: FrameRecorder, elapsed_s: float, total_s: float) -> None:
    """Progress plus a projected disk footprint.

    The projection matters: hundreds of tokens of book updates over two days can run
    to gigabytes, and discovering that at hour 30 with a full disk loses the entire
    capture. Better to see it coming in the first five minutes.
    """
    written = _bytes_on_disk(rec.paths)
    hours_done = elapsed_s / 3600.0
    projected = written / elapsed_s * total_s if elapsed_s > 0 else 0.0
    console.print(
        f"  {hours_done:.2f}h / {total_s / 3600:.2f}h · {rec.count:,} frames · "
        f"{_human(written)} written · ~{_human(projected)} projected"
    )


# --------------------------------------------------------------------------
@app.command()
def replay(
    frames: Path = typer.Argument(..., help="Recorded *-frames.jsonl"),
    markets: Optional[Path] = typer.Option(None, help="Market JSON (defaults to sibling file)"),
    config: Optional[Path] = typer.Option(None, "--config"),
    capital: float = typer.Option(500.0, help="Starting capital for the simulation"),
    speed: float = typer.Option(0.0, help="0 = as fast as possible, 1 = real time"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Replay a recording through the full pipeline.

    This is the key experiment. It answers, from real market data, whether
    net-of-fee opportunities existed and whether the latency model says we would
    have caught them.
    """
    _setup_logging(verbose)
    s = _load_settings(config)

    markets_path = markets or _sibling_markets(frames)
    if markets_path is None or not Path(markets_path).exists():
        console.print("[red]could not find the market list for this recording[/]")
        raise typer.Exit(1)

    market_map = _load_markets(markets_path)
    risk = RiskManager(s, starting_capital=capital)
    store_settings = s
    runner = Runner(store_settings, market_map, engine=None, risk=risk)
    runner.engine = PaperEngine(runner.store, s)

    count = asyncio.run(replay_frames(frames, runner.on_frame, speed=speed))
    runner.finish()

    console.print(f"replayed [bold]{count}[/] frames from {frames}")
    _print_summary(runner.summary())


def _sibling_markets(frames: Path) -> Path | None:
    """Find the market list saved beside a recording.

    Handles a plain file, a rotated part (`…-frames.001.jsonl`), and a directory of
    parts, since a multi-day capture produces all three shapes.
    """
    p = Path(frames)
    if p.is_dir():
        found = sorted(p.glob("*-markets.json"))
        return found[0] if found else None
    idx = p.name.find("-frames")
    if idx != -1:
        return p.with_name(p.name[:idx] + "-markets.json")
    found = sorted(p.parent.glob("*-markets.json"))
    return found[0] if found else None


# --------------------------------------------------------------------------
@app.command()
def analyze(
    frames: Path = typer.Argument(..., help="Recording: a file, a directory of parts, or a glob"),
    markets: Optional[Path] = typer.Option(None, help="Market JSON (defaults to sibling file)"),
    config: Optional[Path] = typer.Option(None, "--config"),
    latency_ms: Optional[float] = typer.Option(
        None, help="Latency to judge capturability against (defaults to config)"
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Measure how long opportunities actually last. **Run this before paper.**

    Detection only — no trading, no execution model, nothing consumed. So a gap
    lifetime here means how long the opportunity existed for *anyone*, which is the
    number that decides whether this strategy is reachable at your latency or
    whether the edge belongs to someone closer to the exchange.
    """
    _setup_logging(verbose)
    s = _load_settings(config)

    markets_path = markets or _sibling_markets(frames)
    if markets_path is None or not Path(markets_path).exists():
        console.print("[red]could not find the market list for this recording[/]")
        raise typer.Exit(1)

    latency = latency_ms if latency_ms is not None else s.execution.assumed_latency_ms
    tracker, on_frame = analyse_frames(_load_markets(markets_path), s)
    count = asyncio.run(replay_frames(frames, on_frame))
    tracker.finish()

    console.print(f"analysed [bold]{count}[/] frames from {frames}")
    _print_analysis(tracker.summary(latency))


def _print_analysis(summary: dict[str, Any]) -> None:
    head = Table(title="gap analysis")
    head.add_column("metric")
    head.add_column("value", overflow="fold")
    for key in (
        "window_hours", "scans", "markets_observed", "gaps_detected",
        "gaps_per_hour", "assumed_latency_ms", "theoretical_profit_all_gaps",
    ):
        if key in summary:
            head.add_row(key, str(summary[key]))
    for key in ("lifetime_ms", "peak_edge_bps", "capturable"):
        if key in summary:
            for k2, v2 in summary[key].items():
                head.add_row(f"{key}.{k2}", str(v2))
    console.print(head)

    for section, title in (("by_category", "by category"), ("by_extremity", "by price extremity")):
        rows = summary.get(section)
        if not rows:
            continue
        table = Table(title=title)
        table.add_column(section.replace("by_", ""))
        for col in ("gaps", "capturable", "median_edge_bps", "median_lifetime_ms", "profit"):
            table.add_column(col, justify="right")
        for name, vals in rows.items():
            table.add_row(
                name, str(vals["gaps"]), str(vals["capturable"]),
                str(vals["median_edge_bps"]), str(vals["median_lifetime_ms"]),
                f"{vals['profit']:.4f}",
            )
        console.print(table)

    verdict = summary.get("verdict")
    if verdict:
        frac = summary.get("capturable", {}).get("fraction", 0.0)
        if summary.get("sample_too_small_for_rates"):
            colour = "yellow"
        else:
            colour = "green" if frac >= 0.2 else "yellow" if frac >= 0.05 else "red"
        console.print(f"\n[{colour}]{verdict}[/]")


# --------------------------------------------------------------------------
@app.command()
def measure(
    hours: float = typer.Option(48.0, help="How long to capture before analysing"),
    config: Optional[Path] = typer.Option(None, "--config"),
    out_dir: Optional[Path] = typer.Option(None, help="Where to write the recording"),
    rotate_minutes: float = typer.Option(60.0, help="Split output every N minutes"),
) -> None:
    """**Start here.** Capture the market, then tell you whether the edge is reachable.

    One command for the whole gate: discover, record, analyse, verdict. Needs no
    wallet, no funds and no API keys — it only reads the public market feed.

    Leave it running (a couple of days is a reasonable first sample) and read the
    verdict at the end. "Do not deploy capital" is a successful outcome: it is the
    cheapest possible way to learn the strategy does not work at your latency.
    """
    _setup_logging(False)
    s = _load_settings(config)
    directory = Path(out_dir or s.recording_dir)
    directory.mkdir(parents=True, exist_ok=True)

    markets = asyncio.run(discover(s.discovery))
    if not markets:
        console.print("[red]no markets matched the discovery filters[/]")
        raise typer.Exit(1)

    # Judge against real latency, not a configured guess. If the config is
    # optimistic we use the measured value rather than aborting — refusing to start
    # a two-day capture over a config number would waste the run for no reason, and
    # the honest figure is the one we just measured anyway.
    latency = s.execution.assumed_latency_ms
    try:
        samples = asyncio.run(
            probe_rest_rtt(f"{CLOB_API}/book?token_id={markets[0].yes_token_id}", count=10)
        )
        ok_latency, message = compare_to_assumed(samples, latency)
        if not ok_latency:
            latency = samples.p50
            console.print(f"[yellow]{message}[/]")
            console.print(f"[yellow]judging capturability against the measured "
                          f"p50 of {latency:.0f}ms instead.[/]")
        else:
            console.print(f"latency: {message}")
    except Exception as e:
        console.print(f"[yellow]latency probe failed ({type(e).__name__}); "
                      f"using configured {latency:.0f}ms[/]")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    frames_path = directory / f"{stamp}-frames.jsonl"
    _save_markets(directory / f"{stamp}-markets.json", markets)

    asset_ids = [tid for m in markets for tid in m.token_ids]
    console.print(
        f"capturing {len(asset_ids)} tokens across {len(markets)} markets for "
        f"{hours:g}h -> {directory}\n[dim]Ctrl-C stops early and still analyses.[/]"
    )

    rec = _capture(
        s, asset_ids, frames_path,
        seconds=hours * 3600,
        rotate_seconds=(rotate_minutes * 60) if rotate_minutes > 0 else None,
    )
    console.print(
        f"[green]captured {rec.count:,} frames[/] "
        f"({_human(_bytes_on_disk(rec.paths))}) across {len(rec.paths)} file(s)\n"
    )

    if rec.count == 0:
        console.print("[red]no frames captured — check connectivity and rerun[/]")
        raise typer.Exit(1)

    market_map = {m.condition_id: m for m in markets}
    tracker, on_frame = analyse_frames(market_map, s)
    asyncio.run(replay_frames(frames_path, on_frame))
    tracker.finish()
    _print_analysis(tracker.summary(latency))
    console.print(f"\n[dim]recording kept at {directory} — "
                  f"`polyarb analyze` it again with a different --latency-ms.[/]")


# --------------------------------------------------------------------------
@app.command()
def paper(
    config: Optional[Path] = typer.Option(None, "--config"),
    capital: float = typer.Option(500.0, help="Simulated starting capital"),
    minutes: float = typer.Option(0.0, help="Stop after N minutes (0 = run until Ctrl-C)"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Trade on paper against the live feed. No orders are ever sent."""
    _setup_logging(verbose)
    s = _load_settings(config)
    markets = asyncio.run(discover(s.discovery))
    if not markets:
        console.print("[red]no markets matched the discovery filters[/]")
        raise typer.Exit(1)
    market_map = {m.condition_id: m for m in markets}

    risk = RiskManager(s, starting_capital=capital)
    with Journal(s.journal_dir) as journal:
        runner = Runner(s, market_map, engine=None, risk=risk, journal=journal)
        runner.engine = PaperEngine(runner.store, s)

        asset_ids = [tid for m in markets for tid in m.token_ids]
        console.print(
            f"[bold]PAPER[/] mode: {len(markets)} markets, ${capital:,.2f} simulated. "
            f"Journal: {journal.path}"
        )

        probe_url = f"{CLOB_API}/book?token_id={markets[0].yes_token_id}"

        async def _main() -> None:
            # Latency drifts over a multi-day run, and the whole paper result is
            # conditional on it, so keep measuring rather than trusting the config.
            stop = asyncio.Event()
            probe = asyncio.create_task(_latency_probe_loop(probe_url, journal, stop))
            try:
                await _run_feed(runner, asset_ids, s, minutes)
            finally:
                stop.set()
                probe.cancel()
                await asyncio.gather(probe, return_exceptions=True)

        asyncio.run(_main())
        runner.finish()
        _print_summary(runner.summary())


async def _latency_probe_loop(
    url: str, journal: Journal, stop: asyncio.Event, interval_s: float = 300.0
) -> None:
    """Sample round-trip latency into the journal until stopped."""
    while not stop.is_set():
        try:
            samples = await probe_rest_rtt(url, count=5, delay_s=0.1)
            if len(samples):
                journal.event("latency_probe", **samples.summary())
        except Exception:  # a probe failure must never take down a paper run
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
            return
        except asyncio.TimeoutError:
            continue


async def _run_feed(runner: Runner, asset_ids: list[str], s: Settings, minutes: float) -> None:
    feed = MarketFeed(
        asset_ids,
        runner.on_frame,
        assets_per_connection=s.discovery.assets_per_connection,
        on_reconnect=runner.invalidate,
    )
    task = asyncio.create_task(feed.run())
    try:
        if minutes > 0:
            await asyncio.sleep(minutes * 60)
        else:
            await task
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        feed.stop()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


# --------------------------------------------------------------------------
@app.command()
def live(
    config: Optional[Path] = typer.Option(None, "--config"),
    i_understand_the_risks: bool = typer.Option(
        False, "--i-understand-the-risks",
        help="Required. Real money will be at risk.",
    ),
    capital: float = typer.Option(..., help="Capital to deploy, in pUSD"),
    minutes: float = typer.Option(0.0, help="Stop after N minutes (0 = until Ctrl-C)"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Trade for real. Requires the flag AND `live_enabled: true` in config."""
    _setup_logging(verbose)
    s = _load_settings(config)

    if not i_understand_the_risks:
        console.print("[red]refusing to trade:[/] pass --i-understand-the-risks")
        raise typer.Exit(1)
    if not s.live_enabled:
        console.print("[red]refusing to trade:[/] set `live_enabled: true` in the config file")
        raise typer.Exit(1)
    if not s.has_credentials():
        console.print("[red]refusing to trade:[/] credentials missing from environment")
        raise typer.Exit(1)

    console.print(
        "[bold red]LIVE TRADING[/] — real funds. "
        "Have you completed replay and paper stages and seen positive net edge?"
    )
    if not typer.confirm("Proceed?", default=False):
        raise typer.Exit(1)

    from .execution.gateway import ClobGateway
    from .execution.live import LiveEngine
    from .settle import Web3Settler

    markets = asyncio.run(discover(s.discovery))
    market_map = {m.condition_id: m for m in markets}

    gateway = ClobGateway(s)
    gateway.connect()
    settler = Web3Settler(s.rpc_url, s.private_key, s.pusd_address)

    kill_path = Path("state/HALT")
    kill_path.parent.mkdir(parents=True, exist_ok=True)
    risk = RiskManager(s, starting_capital=capital, kill_switch_path=kill_path)

    with Journal(s.journal_dir) as journal:
        runner = Runner(s, market_map, engine=None, risk=risk,
                        journal=journal, settler=settler)
        runner.engine = LiveEngine(gateway, s, risk)

        asset_ids = [tid for m in markets for tid in m.token_ids]
        console.print(
            f"live on {len(markets)} markets, ${capital:,.2f} deployed. "
            f"Kill switch: create {kill_path} to stop. Journal: {journal.path}"
        )
        try:
            asyncio.run(_run_feed(runner, asset_ids, s, minutes))
        finally:
            runner.finish()
            gateway.cancel_all()
            _print_summary(runner.summary())


# --------------------------------------------------------------------------
@app.command()
def report(
    path: Optional[Path] = typer.Option(None, help="Journal file or directory"),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    """Summarise journals: opportunity frequency, edge distribution, capture rate."""
    s = _load_settings(config)
    target = path or s.journal_dir
    if Path(target).is_dir():
        summary = summarise_dir(target)
    else:
        summary = summarise(read_journal(target))
    _print_report(summary)


def _print_report(summary: dict[str, Any]) -> None:
    table = Table(title="journal summary")
    table.add_column("metric")
    table.add_column("value", overflow="fold")
    for k, v in summary.items():
        if isinstance(v, dict):
            v = json.dumps(v, indent=None)
        table.add_row(k, str(v))
    console.print(table)

    detected = summary.get("opportunities_detected", 0)
    pnl = summary.get("total_realised_pnl", 0.0)
    if detected == 0:
        console.print(
            "\n[yellow]No opportunities detected.[/] That is a result, not a bug: it "
            "means no gap in these markets cleared fees. Do not fund live trading."
        )
    elif pnl <= 0:
        console.print(
            "\n[yellow]Detected opportunities did not convert to profit.[/] "
            "Check one_legged_rate and fill_rate — if fills are rare, the edge is "
            "being taken by someone faster. Do not fund live trading."
        )


def _print_summary(summary: dict[str, Any]) -> None:
    table = Table(title="run summary")
    table.add_column("metric")
    table.add_column("value", overflow="fold")
    for key, value in summary.items():
        if isinstance(value, dict):
            for k2, v2 in value.items():
                table.add_row(f"{key}.{k2}", json.dumps(v2) if isinstance(v2, dict) else str(v2))
        else:
            table.add_row(key, str(value))
    console.print(table)


if __name__ == "__main__":  # pragma: no cover
    app()
