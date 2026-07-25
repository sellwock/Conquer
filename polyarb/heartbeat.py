"""Order heartbeat.

The venue cancels every open order if it does not receive a heartbeat within 10
seconds, so it is sent every 5. This bot trades fill-or-kill only and leaves nothing
resting, which makes the heartbeat harmless rather than essential today — but it is
wired in now so that any future maker-side mode does not discover the requirement the
hard way, by having its whole book silently cancelled.
"""

from __future__ import annotations

import asyncio
import logging

from .execution.gateway import Gateway

log = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_S = 5.0


async def heartbeat_loop(
    gateway: Gateway,
    stop: asyncio.Event,
    interval: float = HEARTBEAT_INTERVAL_S,
) -> None:
    """Send a heartbeat until `stop` is set. Never raises into the caller."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
            return  # stop was set
        except asyncio.TimeoutError:
            pass
        try:
            gateway.heartbeat()
        except Exception as e:  # pragma: no cover - network path
            log.warning("heartbeat error: %s", e)
