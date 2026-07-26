"""Recording rotation and multi-part replay.

Answering the gap-lifetime question needs days of capture, not minutes, so a
recording has to survive being long: split into parts that can be copied off a box
and replayed in order.
"""

import asyncio
import json


from polyarb.feed import FrameRecorder, recording_parts, replay_frames


def frame(i):
    return {"event_type": "book", "asset_id": f"tok{i}", "timestamp": str(1_700_000_000_000 + i)}


def collect(path, **kw):
    seen = []
    asyncio.run(replay_frames(path, seen.append, **kw))
    return seen


class TestRecorderWithoutRotation:
    def test_writes_a_single_file(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        with FrameRecorder(target) as rec:
            for i in range(3):
                rec.write(frame(i))
        assert target.exists()
        assert rec.count == 3
        assert rec.paths == [target]
        assert len(target.read_text().strip().splitlines()) == 3

    def test_frames_carry_a_receive_timestamp(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        with FrameRecorder(target) as rec:
            rec.write(frame(0))
        rec0 = json.loads(target.read_text().strip())
        assert "received_at" in rec0
        assert rec0["frame"]["asset_id"] == "tok0"


class TestRotation:
    def test_splits_into_numbered_parts(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        # Rotate on every write by making the window zero.
        rec = FrameRecorder(target, rotate_seconds=0)
        for i in range(3):
            rec.write(frame(i))
        rec.close()

        names = sorted(p.name for p in tmp_path.glob("*.jsonl"))
        assert names == ["run-frames.001.jsonl", "run-frames.002.jsonl", "run-frames.003.jsonl"]
        assert rec.count == 3

    def test_no_rotation_within_the_window(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        rec = FrameRecorder(target, rotate_seconds=3600)
        for i in range(5):
            rec.write(frame(i))
        rec.close()
        assert len(rec.paths) == 1
        assert rec.paths[0].name == "run-frames.001.jsonl"

    def test_parts_are_ordered_chronologically_by_name(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        rec = FrameRecorder(target, rotate_seconds=0)
        for i in range(12):
            rec.write(frame(i))
        rec.close()
        # Zero-padded so lexical order is chronological even past part 9.
        names = [p.name for p in sorted(tmp_path.glob("*.jsonl"))]
        assert names[0].endswith(".001.jsonl")
        assert names[-1].endswith(".012.jsonl")


class TestRecordingParts:
    def test_single_file(self, tmp_path):
        f = tmp_path / "a.jsonl"
        f.write_text("")
        assert recording_parts(f) == [f]

    def test_directory(self, tmp_path):
        for name in ("b.jsonl", "a.jsonl"):
            (tmp_path / name).write_text("")
        assert [p.name for p in recording_parts(tmp_path)] == ["a.jsonl", "b.jsonl"]

    def test_base_name_resolves_to_its_parts(self, tmp_path):
        # Asking for the un-rotated name should find the rotated parts.
        for i in (1, 2, 3):
            (tmp_path / f"run-frames.{i:03d}.jsonl").write_text("")
        found = recording_parts(tmp_path / "run-frames.jsonl")
        assert [p.name for p in found] == [
            "run-frames.001.jsonl", "run-frames.002.jsonl", "run-frames.003.jsonl"
        ]

    def test_missing_path_yields_nothing(self, tmp_path):
        assert recording_parts(tmp_path / "nope.jsonl") == []


class TestReplayAcrossParts:
    def test_all_frames_replay_in_order(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        rec = FrameRecorder(target, rotate_seconds=0)
        for i in range(6):
            rec.write(frame(i))
        rec.close()

        # By directory, by base name, and by glob — all equivalent.
        for source in (tmp_path, target, str(tmp_path / "*.jsonl")):
            seen = collect(source)
            assert [f["asset_id"] for f in seen] == [f"tok{i}" for i in range(6)]

    def test_limit_stops_across_parts(self, tmp_path):
        target = tmp_path / "run-frames.jsonl"
        rec = FrameRecorder(target, rotate_seconds=0)
        for i in range(10):
            rec.write(frame(i))
        rec.close()
        assert len(collect(tmp_path, limit=4)) == 4

    def test_blank_and_corrupt_lines_are_skipped(self, tmp_path):
        f = tmp_path / "a.jsonl"
        f.write_text(
            json.dumps({"received_at": 1.0, "frame": frame(0)}) + "\n"
            "\n"
            "{not json\n"
            + json.dumps({"received_at": 2.0, "frame": frame(1)}) + "\n"
        )
        seen = collect(f)
        assert [x["asset_id"] for x in seen] == ["tok0", "tok1"]

    def test_bare_frames_without_envelope_still_replay(self, tmp_path):
        f = tmp_path / "a.jsonl"
        f.write_text(json.dumps(frame(7)) + "\n")
        assert collect(f)[0]["asset_id"] == "tok7"

    def test_empty_recording(self, tmp_path):
        assert collect(tmp_path) == []


class TestSiblingMarketsLookup:
    """`replay`/`analyze` must find the market list beside any recording shape."""

    def test_plain_file(self, tmp_path):
        from polyarb.cli import _sibling_markets

        (tmp_path / "20260101-000000-markets.json").write_text("[]")
        found = _sibling_markets(tmp_path / "20260101-000000-frames.jsonl")
        assert found.name == "20260101-000000-markets.json"

    def test_rotated_part(self, tmp_path):
        from polyarb.cli import _sibling_markets

        (tmp_path / "20260101-000000-markets.json").write_text("[]")
        found = _sibling_markets(tmp_path / "20260101-000000-frames.003.jsonl")
        assert found.name == "20260101-000000-markets.json"

    def test_directory(self, tmp_path):
        from polyarb.cli import _sibling_markets

        (tmp_path / "20260101-000000-markets.json").write_text("[]")
        assert _sibling_markets(tmp_path).name == "20260101-000000-markets.json"

    def test_missing_returns_none(self, tmp_path):
        from polyarb.cli import _sibling_markets

        assert _sibling_markets(tmp_path / "whatever.jsonl") is None
