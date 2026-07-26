"""Market-data websocket client.

Connects to the public CLOB market channel, keeps subscriptions alive, and hands
every frame to a callback. Reconnects are expected and routine, so the important
behaviour is what happens *after* one: books are invalidated until a fresh snapshot
arrives, because a delta stream resumed mid-flight cannot be trusted.

Documented constraints this implements:
  * ~5 concurrent websocket connections per IP, so asset ids are sharded
  * client sends the literal string `PING` every 10s; server replies `PONG`
  * a subscription message must be sent immediately on connect or the server
    closes the socket
"""

from __future__ import annotations

import asyncio
import contextlib
import glob
import json
import random
import time
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any

import websockets

from .config import WS_MARKET

MessageHandler = Callable[[dict[str, Any]], None | Awaitable[None]]

PING_INTERVAL_S = 10.0
BACKOFF_START_S = 1.0
BACKOFF_MAX_S = 30.0


class FrameRecorder:
    """Appends raw frames to JSONL so a live session can be replayed offline.

    This is how the bot gets tested against reality despite the API being
    unreachable from a sandbox: record on a networked machine, replay anywhere.

    Answering the gap-lifetime question needs days of data, not minutes, so with
    `rotate_seconds` set the output is split into numbered parts. One enormous file
    is awkward to move off a VPS and loses everything if it is truncated; parts can
    be copied and analysed as they complete.
    """

    def __init__(self, path: str | Path, rotate_seconds: float | None = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.rotate_seconds = rotate_seconds
        self.count = 0
        self.part = 0
        self.paths: list[Path] = []
        self._opened_at = time.time()
        self._in_part = 0
        self._fh = None  # type: ignore[assignment]
        self._open_next()

    def _current_path(self) -> Path:
        if self.rotate_seconds is None:
            return self.path
        # foo-frames.jsonl -> foo-frames.001.jsonl
        return self.path.with_name(
            f"{self.path.stem}.{self.part:03d}{self.path.suffix}"
        )

    def _open_next(self) -> None:
        if self._fh is not None:
            with contextlib.suppress(Exception):
                self._fh.flush()
                self._fh.close()
        self.part += 1
        target = self._current_path()
        self._fh = target.open("a", encoding="utf-8")
        self._opened_at = time.time()
        self._in_part = 0
        self.paths.append(target)

    def write(self, frame: dict[str, Any]) -> None:
        now = time.time()
        # Only roll a part that actually has something in it, so a quiet feed or a
        # zero-length window never leaves a trail of empty files.
        if (
            self.rotate_seconds is not None
            and self._in_part > 0
            and now - self._opened_at >= self.rotate_seconds
        ):
            self._open_next()
        # received_at lets replay reconstruct real inter-frame timing.
        rec = {"received_at": now, "frame": frame}
        self._fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
        self.count += 1
        self._in_part += 1

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._fh.flush()
            self._fh.close()

    def __enter__(self) -> "FrameRecorder":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def shard(asset_ids: Sequence[str], per_connection: int) -> list[list[str]]:
    """Split asset ids across connections, respecting the per-IP connection cap."""
    if per_connection <= 0:
        raise ValueError("per_connection must be positive")
    ids = list(asset_ids)
    return [ids[i : i + per_connection] for i in range(0, len(ids), per_connection)]


class MarketFeed:
    """Maintains N websocket shards and fans frames out to a handler."""

    def __init__(
        self,
        asset_ids: Sequence[str],
        on_message: MessageHandler,
        *,
        url: str = WS_MARKET,
        assets_per_connection: int = 200,
        max_connections: int = 5,
        recorder: FrameRecorder | None = None,
        on_reconnect: Callable[[list[str]], None] | None = None,
    ) -> None:
        self.shards = shard(asset_ids, assets_per_connection)
        if len(self.shards) > max_connections:
            raise ValueError(
                f"{len(asset_ids)} assets need {len(self.shards)} connections but only "
                f"{max_connections} are allowed per IP; raise assets_per_connection or "
                f"track fewer markets"
            )
        self.on_message = on_message
        self.url = url
        self.recorder = recorder
        self.on_reconnect = on_reconnect
        self._stop = asyncio.Event()
        self.connected_shards = 0
        self.frames_received = 0
        self.reconnects = 0

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        if not self.shards:
            return
        tasks = [asyncio.create_task(self._shard_loop(s)) for s in self.shards]
        try:
            await asyncio.gather(*tasks)
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _shard_loop(self, asset_ids: list[str]) -> None:
        backoff = BACKOFF_START_S
        while not self._stop.is_set():
            try:
                await self._connect_once(asset_ids)
                backoff = BACKOFF_START_S  # a clean session resets the penalty
            except asyncio.CancelledError:
                raise
            except Exception:
                if self._stop.is_set():
                    return
                self.reconnects += 1
                # Jitter so shards do not reconnect in lockstep and get rate limited.
                delay = min(backoff, BACKOFF_MAX_S) * (0.5 + random.random())
                await asyncio.sleep(delay)
                backoff = min(backoff * 2, BACKOFF_MAX_S)

    async def _connect_once(self, asset_ids: list[str]) -> None:
        async with websockets.connect(self.url, ping_interval=None, close_timeout=5) as ws:
            # The server drops sockets that do not subscribe immediately.
            await ws.send(
                json.dumps(
                    {
                        "assets_ids": asset_ids,
                        "type": "market",
                        # Unlocks best_bid_ask / new_market / market_resolved events.
                        "custom_feature_enabled": True,
                    }
                )
            )
            self.connected_shards += 1
            # Anything we knew about these tokens is suspect until re-snapshotted.
            if self.on_reconnect is not None:
                self.on_reconnect(asset_ids)

            pinger = asyncio.create_task(self._ping_loop(ws))
            try:
                async for raw in ws:
                    await self._dispatch(raw)
                    if self._stop.is_set():
                        break
            finally:
                pinger.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pinger
                self.connected_shards -= 1

    async def _ping_loop(self, ws: Any) -> None:
        # Application-level keepalive: the server expects the literal string.
        while True:
            await asyncio.sleep(PING_INTERVAL_S)
            await ws.send("PING")

    async def _dispatch(self, raw: str | bytes) -> None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        text = raw.strip()
        if not text or text.upper() == "PONG":
            return
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return

        # The server batches events into arrays; single objects also occur.
        frames = payload if isinstance(payload, list) else [payload]
        for frame in frames:
            if not isinstance(frame, dict):
                continue
            self.frames_received += 1
            if self.recorder is not None:
                self.recorder.write(frame)
            result = self.on_message(frame)
            if asyncio.iscoroutine(result):
                await result


def recording_parts(path: str | Path) -> list[Path]:
    """Resolve a recording argument into an ordered list of JSONL files.

    Accepts a single file, a directory of parts, or a glob. Rotated recordings are
    numbered so lexical order is chronological order.
    """
    p = Path(path)
    if p.is_dir():
        return sorted(p.glob("*.jsonl"))
    if any(ch in str(path) for ch in "*?["):
        # stdlib glob, not Path.glob — the latter rejects absolute patterns.
        return sorted(Path(hit) for hit in glob.glob(str(path)))
    if p.exists():
        return [p]
    # A base name whose recording was rotated into parts.
    parts = sorted(p.parent.glob(f"{p.stem}.[0-9][0-9][0-9]{p.suffix}"))
    return parts


async def replay_frames(
    path: str | Path,
    on_message: MessageHandler,
    *,
    speed: float = 0.0,
    limit: int | None = None,
) -> int:
    """Feed a recorded JSONL session back through a handler.

    `speed` of 0 replays as fast as possible (for tests and bulk analysis); 1.0
    reproduces the original wall-clock spacing. Note that gap-lifetime analysis does
    not need speed 1.0 — lifetimes are computed from the server timestamps carried in
    the frames, so they are accurate at any replay speed.
    """
    count = 0
    prev_ts: float | None = None

    for part in recording_parts(path):
        with part.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                frame = rec.get("frame", rec)
                ts = rec.get("received_at")

                if speed > 0 and ts is not None and prev_ts is not None:
                    gap = (ts - prev_ts) / speed
                    if gap > 0:
                        await asyncio.sleep(min(gap, 5.0))
                if ts is not None:
                    prev_ts = ts

                if isinstance(frame, dict):
                    result = on_message(frame)
                    if asyncio.iscoroutine(result):
                        await result
                    count += 1
                    if limit is not None and count >= limit:
                        return count
    return count
