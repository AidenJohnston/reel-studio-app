import io
import json
from pathlib import Path

import pytest

from reelengine import cli, proto
from reelengine.proto import EngineError
from reelengine.reference_import import import_reference

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "reference-import"


def _frames(r):
    return r["start"]["value"], r["duration"]["value"], r["start"]["rate"]


def test_premiere_export_keeps_cut_transition_title_and_audio_levels():
    record = import_reference(FIXTURES / "talking-head.xml")
    assert record["source"]["adapter"] == "fcp_xml"
    assert record["mediaRefs"] == ["file:///media/talking-head.mov"]
    (timeline,) = record["timelines"]
    assert [t["kind"] for t in timeline["tracks"]] == ["Video", "Video", "Audio"]
    assert [(m["name"], _frames(m["range"])[0]) for m in timeline["markers"]] == [("hook", 12)]

    first, dissolve, second = timeline["tracks"][0]["items"]
    assert _frames(first["sourceRange"]) == (25, 50, 25)
    assert _frames(first["trackRange"])[:2] == (0, 50)
    assert _frames(second["trackRange"])[:2] == (50, 50)
    assert dissolve["type"] == "transition" and dissolve["name"] == "Cross Dissolve"
    assert dissolve["inOffset"]["value"] == dissolve["outOffset"]["value"] == 10

    gap, title = timeline["tracks"][1]["items"]
    assert gap["type"] == "gap" and _frames(title["trackRange"])[:2] == (10, 30)
    assert title["media"] == {"kind": "generator", "generator": "Text", "name": "Text"}

    (audio,) = timeline["tracks"][2]["items"]
    assert [e["name"] for e in audio["effects"]] == ["Audio Levels"]
    levels = next(l for l in record["losses"] if l["path"] == "timelines[0].tracks[2].items[0].effects[0]")
    assert levels["metadata"]["fcp_xml"]["parameter"]["value"] == "0.5"
    title_text = next(l for l in record["losses"] if l["path"] == "timelines[0].tracks[1].items[1].media")
    assert title_text["metadata"]["fcp_xml"]["parameter"]["value"] == "Stop scrolling"


def test_fcpxml_bundle_lists_what_the_adapter_drops():
    record = import_reference(FIXTURES / "cut.fcpxmld")
    assert record["source"]["adapter"] == "fcpx_xml" and record["source"]["version"] == "1.10"
    (timeline,) = record["timelines"]
    first, second = timeline["tracks"][0]["items"]
    assert _frames(first["sourceRange"]) == (50, 100, 25)
    assert _frames(second["trackRange"])[:2] == (100, 100)
    assert [(m["name"], _frames(m["range"])[0]) for m in first["markers"]] == [("hook", 75)]

    dropped = {l["element"] for l in record["losses"] if l["path"] == "source"}
    assert {"title", "transition", "adjust-volume", "media-rep"} <= dropped
    assert first["media"]["kind"] == "missing"
    assert {"path": "timelines[0].tracks[0].items[0].media",
            "reason": "the adapter found no media for this clip"} in record["losses"]


_FCP7_BODY = ('<xmeml version="5"><sequence><name>&x;</name><rate><timebase>25</timebase></rate>'
              '<media><video><track/></video></media></sequence></xmeml>')


@pytest.mark.parametrize("doctype,encoding", [
    ('<!DOCTYPE xmeml [<!ENTITY x "expanded">]>', "utf-8"),
    ('<!DOCTYPE xmeml [<!ENTITY x SYSTEM "file:///etc/passwd">]>', "utf-8"),
    ('<!DOCTYPE xmeml [<!ENTITY x "expanded">]>', "utf-16"),
])
def test_entity_declarations_are_refused_before_the_adapter_parses(tmp_path, doctype, encoding):
    source = tmp_path / "evil.xml"
    source.write_bytes(f'<?xml version="1.0" encoding="{encoding}"?>{doctype}{_FCP7_BODY}'.encode(encoding))
    with pytest.raises(EngineError) as err:
        import_reference(source)
    assert err.value.code == "UNSAFE_XML"


def test_bundle_rejects_symlink_escape(tmp_path):
    bundle = tmp_path / "edit.fcpxmld"
    bundle.mkdir()
    outside = tmp_path / "outside.fcpxml"
    outside.write_bytes((FIXTURES / "cut.fcpxmld" / "Info.fcpxml").read_bytes())
    (bundle / "Info.fcpxml").symlink_to(outside)
    with pytest.raises(EngineError) as err:
        import_reference(bundle)
    assert err.value.code == "UNSAFE_INPUT"


def test_oversized_input_is_rejected(tmp_path):
    source = tmp_path / "large.xml"
    source.write_bytes(b"x" * (64 * 1024 * 1024 + 1))
    with pytest.raises(EngineError) as err:
        import_reference(source)
    assert err.value.code == "INPUT_TOO_LARGE"


def test_cli_writes_the_record(tmp_path):
    out = tmp_path / "record.json"
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(["import-reference", str(FIXTURES / "talking-head.xml"), "--output", str(out)])
    finally:
        proto.set_stream(None)
    done = json.loads(buf.getvalue().splitlines()[-1])
    assert code == 0 and done["event"] == "done"
    assert json.loads(out.read_text(encoding="utf-8")) == done["result"]
