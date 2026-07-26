"""The `measure` command's glue.

The capture leg needs a network, so what is tested here is everything around it: the
disk accounting that stops a two-day run filling a disk unnoticed, and the
record -> analyse hand-off that `measure` exists to remove from the operator's hands.
"""

import asyncio
import json
from pathlib import Path

import pytest

from polyarb.analysis import analyse_frames
from polyarb.cli import _bytes_on_disk, _human, _report_progress
from polyarb.config import Settings
from polyarb.feed import FrameRecorder, replay_frames
from polyarb.models import Market

FIXTURES = Path(__file__).parent / "fixtures"


class TestHumanBytes:
    def test_units(self):
        assert _human(512) == "512.0B"
        assert _human(2048) == "2.0KB"
        assert _human(5 * 1024**2) == "5.0MB"
        assert _human(3 * 1024**3) == "3.0GB"

    def test_very_large_values_do_not_overflow_the_units(self):
        assert _human(9 * 1024**5).endswith("TB")


class TestDiskAccounting:
    def test_sums_across_parts(self, tmp_path):
        paths = []
        for i in (1, 2):
            p = tmp_path / f"part{i}.jsonl"
            p.write_text("x" * 100)
            paths.append(p)
        assert _bytes_on_disk(paths) == 200

    def test_missing_files_are_skipped_not_fatal(self, tmp_path):
        # A rotated part could be moved or deleted mid-run; reporting must survive it.
        good = tmp_path / "a.jsonl"
        good.write_text("x" * 50)
        assert _bytes_on_disk([good, tmp_path / "gone.jsonl"]) == 50

    def test_empty(self):
        assert _bytes_on_disk([]) == 0


class TestProgressReport:
    def test_projects_footprint_without_dividing_by_zero(self, tmp_path, capsys):
        rec = FrameRecorder(tmp_path / "run-frames.jsonl")
        rec.write({"event_type": "book", "asset_id": "t"})
        rec.close()

        # Half an hour in, projecting to a 48-hour run.
        _report_progress(rec, elapsed_s=1800.0, total_s=48 * 3600)
        out = capsys.readouterr().out
        assert "0.50h" in out
        assert "projected" in out

        # Zero elapsed must not blow up on the first tick.
        _report_progress(rec, elapsed_s=0.0, total_s=3600)


class TestRecordToAnalyseHandoff:
    """`measure` chains capture straight into analysis. The join is what it exists
    to remove from the operator, so the join is what gets tested."""

    def load_markets(self):
        rows = json.loads((FIXTURES / "sample-markets.json").read_text())
        return {r["condition_id"]: Market(**r) for r in rows}

    def write_recording(self, tmp_path, rotate_seconds=None):
        """Re-record the fixture frames through FrameRecorder, as a capture would."""
        frames_path = tmp_path / "20260101-000000-frames.jsonl"
        rec = FrameRecorder(frames_path, rotate_seconds=rotate_seconds)
        with (FIXTURES / "sample-frames.jsonl").open() as fh:
            for line in fh:
                if line.strip():
                    rec.write(json.loads(line)["frame"])
        rec.close()
        return frames_path, rec

    def analyse(self, frames_path):
        tracker, on_frame = analyse_frames(self.load_markets(), Settings())
        asyncio.run(replay_frames(frames_path, on_frame))
        tracker.finish()
        return tracker

    def test_single_file_capture_analyses(self, tmp_path):
        frames_path, _ = self.write_recording(tmp_path)
        tracker = self.analyse(frames_path)
        assert len(tracker.gaps) == 1
        assert tracker.gaps[0].slug == "treaty-signed"

    def test_rotated_capture_analyses_identically(self, tmp_path):
        # The whole point of rotation is that it changes nothing downstream.
        frames_path, rec = self.write_recording(tmp_path, rotate_seconds=0)
        assert len(rec.paths) > 1
        tracker = self.analyse(frames_path)
        assert len(tracker.gaps) == 1
        assert tracker.gaps[0].lifetime_ms == pytest.approx(400, abs=1)

    def test_verdict_is_produced_from_a_capture(self, tmp_path):
        frames_path, _ = self.write_recording(tmp_path)
        summary = self.analyse(frames_path).summary(latency_ms=150)
        assert summary["gaps_detected"] == 1
        assert summary["capturable"]["count"] == 1
        assert "verdict" in summary

    def test_empty_capture_yields_no_gaps_rather_than_an_error(self, tmp_path):
        frames_path = tmp_path / "20260101-000000-frames.jsonl"
        FrameRecorder(frames_path).close()
        summary = self.analyse(frames_path).summary(latency_ms=150)
        assert summary["gaps_detected"] == 0
        assert "do not deploy capital" in summary["verdict"].lower()
