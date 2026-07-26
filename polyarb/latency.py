"""Latency measurement.

`assumed_latency_ms` is the most load-bearing guess in the whole system. The paper
engine uses it to decide whether an opportunity would still have been there on
arrival, so setting it too low is the single easiest way to produce encouraging
results that evaporate the moment real money is involved.

Nothing here estimates. It measures: real round trips to the exchange, kept as
samples, reported as a distribution. `doctor` compares the configured value against
the measured p50 and complains when the configuration is optimistic.

Percentiles matter more than the mean. A p50 of 120ms with a p99 of 900ms is a very
different bot from a flat 150ms, because the tail is exactly when a gap closes on you.
"""

from __future__ import annotations

import math
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LatencySamples:
    """A growing set of round-trip measurements in milliseconds."""

    name: str = "rtt"
    samples: list[float] = field(default_factory=list)

    def add(self, ms: float) -> None:
        if ms >= 0:
            self.samples.append(float(ms))

    def extend(self, values: Iterable[float]) -> None:
        for v in values:
            self.add(v)

    def __len__(self) -> int:
        return len(self.samples)

    def percentile(self, p: float) -> float:
        """Linear-interpolated percentile. `p` is a fraction in [0, 1]."""
        if not self.samples:
            return 0.0
        if not 0.0 <= p <= 1.0:
            raise ValueError(f"percentile must be in [0, 1], got {p}")
        ordered = sorted(self.samples)
        if len(ordered) == 1:
            return ordered[0]
        k = (len(ordered) - 1) * p
        lo, hi = math.floor(k), math.ceil(k)
        if lo == hi:
            return ordered[int(k)]
        return ordered[lo] * (hi - k) + ordered[hi] * (k - lo)

    @property
    def p50(self) -> float:
        return self.percentile(0.50)

    @property
    def p90(self) -> float:
        return self.percentile(0.90)

    @property
    def p99(self) -> float:
        return self.percentile(0.99)

    @property
    def mean(self) -> float:
        return sum(self.samples) / len(self.samples) if self.samples else 0.0

    def summary(self) -> dict[str, Any]:
        if not self.samples:
            return {"name": self.name, "count": 0}
        return {
            "name": self.name,
            "count": len(self.samples),
            "min_ms": round(min(self.samples), 1),
            "p50_ms": round(self.p50, 1),
            "p90_ms": round(self.p90, 1),
            "p99_ms": round(self.p99, 1),
            "max_ms": round(max(self.samples), 1),
            "mean_ms": round(self.mean, 1),
        }


class Stopwatch:
    """Times a block and files the result. Records on failure too — a slow error is
    still latency, and dropping those would bias the distribution optimistically."""

    def __init__(self, samples: LatencySamples) -> None:
        self.samples = samples
        self._start = 0.0
        self.elapsed_ms = 0.0

    def __enter__(self) -> "Stopwatch":
        self._start = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.elapsed_ms = (time.perf_counter() - self._start) * 1000.0
        self.samples.add(self.elapsed_ms)


async def probe_rest_rtt(
    url: str,
    *,
    count: int = 10,
    delay_s: float = 0.2,
    timeout_s: float = 10.0,
) -> LatencySamples:
    """Measure round-trip time to a REST endpoint.

    Used to get an honest latency figure without placing a single order, which is
    what makes it usable during paper trading and in `doctor`. This is a floor, not
    the whole story: a real order also pays signing and matching-engine time, so
    treat the measured p50 as a lower bound on what execution actually costs.
    """
    import httpx

    samples = LatencySamples(name="rest_rtt")
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        for i in range(count):
            if i:
                import asyncio

                await asyncio.sleep(delay_s)
            with Stopwatch(samples):
                try:
                    await client.get(url)
                except Exception:
                    # Timeouts and errors still consumed wall-clock time; the
                    # Stopwatch records it on the way out.
                    pass
    return samples


def compare_to_assumed(measured: LatencySamples, assumed_ms: float) -> tuple[bool, str]:
    """Check a configured `assumed_latency_ms` against reality.

    Returns (ok, message). Not-ok means the configuration is optimistic, which makes
    every paper result too good and is worth failing loudly over.
    """
    if not measured.samples:
        return True, "no samples collected"
    p50 = measured.p50
    if assumed_ms < p50:
        return False, (
            f"assumed_latency_ms={assumed_ms:.0f} is below the measured p50 of "
            f"{p50:.0f}ms (p90 {measured.p90:.0f}ms). Paper results will overstate "
            f"fills. Raise it to at least {math.ceil(p50 / 10) * 10:.0f}."
        )
    return True, (
        f"assumed {assumed_ms:.0f}ms vs measured p50 {p50:.0f}ms / p90 "
        f"{measured.p90:.0f}ms"
    )
