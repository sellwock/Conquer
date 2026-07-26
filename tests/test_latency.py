"""Latency sampling and the assumed-vs-measured check."""

import pytest

from polyarb.latency import LatencySamples, Stopwatch, compare_to_assumed


class TestPercentiles:
    def test_hand_computed(self):
        s = LatencySamples()
        s.extend([10, 20, 30, 40, 50])
        assert s.percentile(0.0) == 10
        assert s.percentile(1.0) == 50
        assert s.p50 == 30
        # (n-1)*0.9 = 3.6 -> between 40 and 50, 60% of the way
        assert s.p90 == pytest.approx(46.0)

    def test_single_sample(self):
        s = LatencySamples()
        s.add(42)
        assert s.p50 == 42 and s.p90 == 42 and s.p99 == 42

    def test_empty(self):
        s = LatencySamples()
        assert s.p50 == 0.0
        assert s.mean == 0.0
        assert s.summary() == {"name": "rtt", "count": 0}

    def test_unsorted_input(self):
        s = LatencySamples()
        s.extend([50, 10, 30, 20, 40])
        assert s.p50 == 30

    def test_rejects_negative_samples(self):
        s = LatencySamples()
        s.extend([10, -5, 20])
        assert len(s) == 2

    def test_invalid_percentile(self):
        s = LatencySamples()
        s.add(1)
        with pytest.raises(ValueError):
            s.percentile(1.5)

    def test_summary_shape(self):
        s = LatencySamples(name="rest_rtt")
        s.extend([100, 150, 200, 900])
        out = s.summary()
        assert out["name"] == "rest_rtt"
        assert out["count"] == 4
        assert out["min_ms"] == 100
        assert out["max_ms"] == 900
        assert out["mean_ms"] == pytest.approx(337.5)

    def test_tail_is_visible(self):
        # A fat tail must not hide behind a healthy median — the tail is exactly
        # when a gap closes on you.
        s = LatencySamples()
        s.extend([100] * 99 + [5000])
        assert s.p50 == 100
        assert s.p99 > 100


class TestStopwatch:
    def test_records_elapsed(self):
        s = LatencySamples()
        with Stopwatch(s) as sw:
            sum(range(10_000))
        assert len(s) == 1
        assert sw.elapsed_ms >= 0

    def test_records_even_when_the_block_raises(self):
        # A slow failure is still latency; dropping it would bias the distribution
        # optimistically.
        s = LatencySamples()
        with pytest.raises(RuntimeError):
            with Stopwatch(s):
                raise RuntimeError("boom")
        assert len(s) == 1


class TestCompareToAssumed:
    def test_optimistic_config_is_rejected(self):
        s = LatencySamples()
        s.extend([200, 220, 240])
        ok, msg = compare_to_assumed(s, assumed_ms=150)
        assert not ok
        assert "below the measured p50" in msg
        assert "overstate fills" in msg

    def test_conservative_config_passes(self):
        s = LatencySamples()
        s.extend([80, 90, 100])
        ok, msg = compare_to_assumed(s, assumed_ms=150)
        assert ok
        assert "measured p50" in msg

    def test_no_samples_is_not_a_failure(self):
        ok, msg = compare_to_assumed(LatencySamples(), assumed_ms=150)
        assert ok
        assert "no samples" in msg

    def test_suggested_value_clears_the_measured_p50(self):
        s = LatencySamples()
        s.extend([203, 207, 211])
        ok, msg = compare_to_assumed(s, assumed_ms=100)
        assert not ok
        # The suggestion is rounded up to the next 10ms, so it is never below p50.
        assert "210" in msg
