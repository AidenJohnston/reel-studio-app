import json
from pathlib import Path

import pytest

from reelengine.proto import EngineError
from reelengine.reference_import import import_reference, safe_input


def test_timebase_and_clip_range_are_normalized(monkeypatch, tmp_path):
    class Rate:
        rate = 29.97
        drop_frame = True

    class Range:
        start_time = 1001
        duration = 2002

    class Clip:
        name = "talking head"
        source_range = Range()
        media_reference = None
        metadata = {"vendor_field": "keep in loss report"}
        duration = 2002
        effects = []
        markers = []

    class Track:
        name = "V1"
        kind = "Video"
        children = [Clip()]
        metadata = {}

    class Timeline:
        name = "cut"
        tracks = [Track()]
        global_start_time = type("Time", (), {"rate": 29.97, "value": 0})()
        metadata = {}
        markers = []
        duration = 2002

    monkeypatch.setattr("reelengine.reference_import._read_otio", lambda path, adapter: Timeline())
    source = tmp_path / "cut.xml"
    source.write_text("<xmeml/>")
    record = import_reference(source)
    clip = record["tracks"][0]["clips"][0]
    assert clip["sourceRange"]["start"]["value"] == 1001
    assert clip["sourceRange"]["duration"]["value"] == 2002
    assert clip["sourceRange"]["rate"] == pytest.approx(29.97)
    assert clip["sourceRange"]["dropFrame"] is True
    assert "vendor_field" in record["losses"][0]["fields"]


def test_bundle_rejects_symlink_escape(tmp_path):
    bundle = tmp_path / "edit.fcpxmld"
    bundle.mkdir()
    outside = tmp_path / "outside.xml"
    outside.write_text("<fcpxml/>")
    (bundle / "Info.fcpxml").symlink_to(outside)
    with pytest.raises(EngineError, match="symlink"):
        safe_input(bundle)


def test_xml_entities_are_rejected(tmp_path):
    source = tmp_path / "evil.xml"
    source.write_text('<!DOCTYPE x [<!ENTITY boom "boom">]><xmeml>&boom;</xmeml>')
    with pytest.raises(EngineError, match="entity"):
        safe_input(source)


def test_oversized_input_is_rejected(tmp_path):
    source = tmp_path / "large.xml"
    source.write_bytes(b"x" * (64 * 1024 * 1024 + 1))
    with pytest.raises(EngineError, match="large|size"):
        safe_input(source)
