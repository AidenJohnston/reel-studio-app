import io
import json
import multiprocessing
import sys
from pathlib import Path

import pytest

from reelengine import cli, proto, reference_import
from reelengine.proto import EngineError
from reelengine.reference_import import import_reference

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "reference-import"


def _frames(r):
    return r["start"]["value"], r["duration"]["value"], r["start"]["rate"]


def _code(path):
    with pytest.raises(EngineError) as err:
        import_reference(path)
    return err.value.code


def test_premiere_export_keeps_cut_transition_title_and_audio_levels():
    record = import_reference(FIXTURES / "talking-head.xml")
    assert record["source"]["adapter"] == "fcp_xml"
    assert record["mediaRefs"] == ["file:///media/talking-head.mov"]
    (timeline,) = record["timelines"]
    assert [t["kind"] for t in timeline["tracks"]] == ["Video", "Video", "Video", "Audio"]
    assert [(m["name"], _frames(m["range"])[0]) for m in timeline["markers"]] == [("hook", 12)]

    first, dissolve, second = timeline["tracks"][0]["items"]
    assert _frames(first["sourceRange"]) == (25, 50, 25)
    assert _frames(first["trackRange"])[:2] == (0, 50)
    assert _frames(second["sourceRange"]) == (100, 50, 25)
    assert _frames(second["trackRange"])[:2] == (50, 50)
    assert dissolve["type"] == "transition" and dissolve["name"] == "Cross Dissolve"
    assert dissolve["inOffset"]["value"] == dissolve["outOffset"]["value"] == 10

    (title,) = timeline["tracks"][1]["items"]
    assert _frames(title["trackRange"])[:2] == (10, 30)
    assert title["media"] == {"kind": "generator", "generator": "Text", "name": "Text"}

    (audio,) = timeline["tracks"][3]["items"]
    assert [e["name"] for e in audio["effects"]] == ["Audio Levels"]

    raw = {path: entry for entry in record["rawMetadata"] for path in entry["paths"]}
    assert raw["timelines[0].tracks[3].items[0].effects[0]"]["metadata"]["fcp_xml"]["parameter"]["value"] == "0.5"
    assert raw["timelines[0].tracks[1].items[0].media"]["metadata"]["fcp_xml"]["parameter"]["value"] == "Stop scrolling"
    (file_entry,) = [e for e in record["rawMetadata"] if e["id"] == "file-1"]
    assert len(file_entry["paths"]) == 3

    assert {(l["path"], l["reason"]) for l in record["losses"]} == {
        ("timelines[0].tracks[2].items[0]", "the adapter returned this nested sequence with nothing in it"),
        ("source", "disabled in the editor but imported as enabled"),
    }


def test_fcpxml_bundle_lists_what_the_adapter_drops():
    record = import_reference(FIXTURES / "cut.fcpxmld")
    assert record["source"]["adapter"] == "fcpx_xml" and record["source"]["version"] == "1.10"
    (timeline,) = record["timelines"]
    first, second = timeline["tracks"][0]["items"]
    assert _frames(first["sourceRange"]) == (50, 100, 25)
    assert _frames(second["trackRange"])[:2] == (100, 100)
    assert [(m["name"], _frames(m["range"])[0]) for m in first["markers"]] == [("hook", 75)]
    assert first["media"]["kind"] == "missing"

    losses = record["losses"]
    assert {"title", "transition", "adjust-volume", "media-rep", "note"} <= {l.get("element") for l in losses}
    assert {'enabled="0"', "audioStart/audioDuration"} <= {l.get("attribute") for l in losses}
    assert [l["projects"] for l in losses if "projects" in l] == [["First try"]]
    assert {"path": "timelines[0].tracks[0].items[0].media",
            "reason": "the adapter found no media for this clip"} in losses


def test_fcpxml_timing_is_exact_at_29_97_and_lanes_sort_by_number():
    record = import_reference(FIXTURES / "ntsc-lanes.fcpxml")
    (timeline,) = record["timelines"]
    assert timeline["globalStart"]["value"] == 108000 and timeline["dropFrame"] is True
    assert [t["name"] for t in timeline["tracks"]] == ["0", "1", "2", "10"]

    spine = timeline["tracks"][0]["items"]
    assert [i["name"] for i in spine] == ["intro", "point", "outro"]
    assert {i["trackRange"]["start"]["rate"] for i in spine} == {30000 / 1001}
    assert [_frames(i["trackRange"])[:2] for i in spine] == [(0, 30), (30, 45), (75, 30)]
    assert [_frames(i["sourceRange"])[0] for i in spine] == [120, 200, 300]
    assert [_frames(m["range"])[0] for m in spine[0]["markers"]] == [130]

    assert record["rawMetadata"] == []

    (wide,) = timeline["tracks"][2]["items"]
    assert _frames(wide["trackRange"])[:2] == (15, 20)
    assert [l["path"] for l in record["losses"] if "deeper than one connection" in l["reason"]] == [
        "timelines[0].tracks[1].items[0]"]


@pytest.mark.parametrize("name,body", [
    ("event-only.fcpxml", '<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/25s"/>'
                          '<asset id="r2" src="file:///a.mov" start="0s" duration="4s"/></resources>'
                          '<event name="Clips"><asset-clip ref="r2" offset="0s" duration="4s" name="a"/></event></fcpxml>'),
    ("clip-only.xml", '<xmeml version="5"><clip id="c"><name>a</name><duration>50</duration>'
                      '<rate><timebase>25</timebase></rate></clip></xmeml>'),
], ids=["fcpxml-event-only", "premiere-clip-only"])
def test_export_without_a_timeline_is_refused(tmp_path, name, body):
    source = tmp_path / name
    source.write_text(body, encoding="utf-8")
    assert _code(source) == "NO_TIMELINE"


def _compound_clips(levels, fanout, cycle=False):
    resources = ['<format id="r1" frameDuration="1/25s"/>',
                 '<asset id="r2" src="file:///a.mov" start="0s" duration="10s"/>',
                 '<media id="m0" name="m0"><sequence format="r1"><spine>'
                 + ('<ref-clip ref="m0" offset="0s" duration="1s"/>' if cycle
                    else '<asset-clip ref="r2" offset="0s" duration="1s" name="leaf"/>')
                 + '</spine></sequence></media>']
    for k in range(1, levels):
        refs = "".join(f'<ref-clip ref="m{k - 1}" offset="{i}s" duration="1s"/>' for i in range(fanout))
        resources.append(f'<media id="m{k}" name="m{k}"><sequence format="r1"><spine>{refs}</spine></sequence></media>')
    top = "".join(f'<ref-clip ref="m{levels - 1}" offset="{i}s" duration="1s"/>' for i in range(fanout))
    return (f'<fcpxml version="1.10"><resources>{"".join(resources)}</resources><library><event name="e">'
            f'<project name="p"><sequence format="r1"><spine>{top}</spine></sequence></project></event></library></fcpxml>')


def _premiere_file_references(refs, file_children=0, file_text=""):
    definition = (f'<file id="f"><name>a.mov</name><pathurl>file:///a.mov</pathurl><comment>{file_text}</comment>'
                  + "<x/>" * file_children + "</file>")
    reference = '<file id="f"/>'
    clips = "".join(f'<clipitem id="c{i}"><name>a</name><in>0</in><out>1</out><start>{i}</start><end>{i + 1}</end>'
                    f'{definition if i == 0 else reference}</clipitem>' for i in range(refs))
    return (f'<xmeml version="5"><sequence><name>s</name><rate><timebase>25</timebase></rate>'
            f'<media><video><track>{clips}</track></video></media></sequence></xmeml>')


@pytest.mark.parametrize("name,body,code", [
    ("nested.fcpxml", _compound_clips(levels=9, fanout=10), "INPUT_TOO_LARGE"),
    ("cycle.fcpxml", _compound_clips(levels=1, fanout=1, cycle=True), "BAD_XML"),
    ("file-refs.xml", _premiere_file_references(refs=500, file_children=5000), "INPUT_TOO_LARGE"),
], ids=["nested-compound-clips", "compound-clip-cycle", "premiere-file-references"])
def test_references_that_expand_without_bound_are_refused(tmp_path, name, body, code):
    source = tmp_path / name
    source.write_text(body, encoding="utf-8")
    assert source.stat().st_size < 100 * 1024
    assert _code(source) == code


@pytest.mark.parametrize("suffix", [".fcpxml", ".xml"], ids=["fcpxml", "premiere"])
def test_reference_chain_over_depth_cap_reports_input_too_large(tmp_path, suffix):
    depth = reference_import.MAX_EXPANDED_DEPTH + 1
    if suffix == ".fcpxml":
        body = _compound_clips(levels=depth, fanout=1)
    else:
        # The sequence is at depth 1; the last referenced file is at depth cap + 1.
        definitions = "".join(
            f'<file id="f{i}"><file id="f{i + 1}"/></file>'
            for i in range(1, depth - 1)
        ) + f'<file id="f{depth - 1}"/>'
        body = (f'<xmeml version="5"><sequence><file id="f1"/></sequence>'
                f'{definitions}</xmeml>')
    source = tmp_path / f"deep{suffix}"
    source.write_text(body, encoding="utf-8")
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(["import-reference", str(source)])
    finally:
        proto.set_stream(None)
    error = json.loads(buf.getvalue().splitlines()[-1])
    assert code != 0
    assert error["event"] == "error"
    assert error["code"] == "INPUT_TOO_LARGE"


def _event_clip_note(uses, note):
    spine = "".join(f'<asset-clip ref="r2" offset="{i}s" duration="1s" name="a"/>' for i in range(uses))
    return ('<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/25s"/>'
            '<asset id="r2" src="file:///a.mov" start="0s" duration="100s"/></resources>'
            f'<event name="e"><asset-clip ref="r2" offset="0s" duration="1s" name="a"><note>{note}</note></asset-clip>'
            f'<project name="p"><sequence format="r1"><spine>{spine}</spine></sequence></project></event></fcpxml>')


@pytest.mark.parametrize("name,body", [
    ("file-text.xml", _premiere_file_references(refs=20, file_text="x" * 5000)),
    ("note.fcpxml", _event_clip_note(uses=20, note="x" * 5000)),
], ids=["premiere-file-text", "fcpxml-event-clip-note"])
def test_text_copied_once_per_reference_counts_against_the_budget(monkeypatch, tmp_path, name, body):
    monkeypatch.setattr(reference_import, "MAX_EXPANDED_BYTES", 50_000)
    source = tmp_path / name
    source.write_text(body, encoding="utf-8")
    assert source.stat().st_size < 10_000
    assert _code(source) == "INPUT_TOO_LARGE"


@pytest.mark.parametrize("limit,value", [("ADAPTER_SECONDS", 0), ("ADAPTER_MEMORY_BYTES", 1)],
                         ids=["time", "memory"])
def test_adapter_past_its_limit_is_stopped(monkeypatch, limit, value):
    monkeypatch.setattr(reference_import, limit, value)
    assert _code(FIXTURES / "talking-head.xml") == "INPUT_TOO_LARGE"
    assert multiprocessing.active_children() == []


_MIXED_RATES = """<fcpxml version="1.10"><resources>
<format id="p25" frameDuration="1/25s"/><format id="p2997" frameDuration="1001/30000s"/>
<asset id="a25" src="file:///talk.mov" start="0s" duration="100s" format="p25"/>
<asset id="a2997" src="file:///phone.mov" start="0s" duration="100s" format="p2997"/>
</resources><project name="mixed"><sequence format="p25"><spine>
<asset-clip name="talk" ref="a25" offset="0s" start="0s" duration="40s"/>
<asset-clip name="phone" ref="a2997" offset="40s" start="0s" duration="15015/30000s"/>
<asset-clip name="talk again" ref="a25" offset="41s" start="50s" duration="2s"/>
</spine></sequence></project></fcpxml>"""


def test_mixed_frame_rates_keep_timeline_order(tmp_path):
    source = tmp_path / "mixed.fcpxml"
    source.write_text(_MIXED_RATES, encoding="utf-8")
    (timeline,) = import_reference(source)["timelines"]
    (track,) = timeline["tracks"]
    assert [(i["name"], i["trackRange"]["start"]["value"]) for i in track["items"]] == [
        ("talk", 0), ("phone", 1000), ("talk again", 1025)]
    assert _frames(track["items"][1]["sourceRange"])[1:] == (15, 30000 / 1001)


_TWO_PROJECTS = ('<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/25s"/>'
                 '<asset id="r2" src="file:///a.mov" start="0s" duration="10s"/></resources>'
                 '<project name="Cut A"><sequence format="r1"><spine><asset-clip ref="r2" offset="0s" duration="1s" name="a"/>'
                 '</spine></sequence></project><project name="Cut B"><sequence format="r1"><spine>'
                 '<asset-clip ref="r2" offset="0s" duration="1s" name="b"/></spine></sequence></project></fcpxml>')


def test_projects_the_adapter_skips_are_reported(tmp_path):
    source = tmp_path / "two.fcpxml"
    source.write_text(_TWO_PROJECTS, encoding="utf-8")
    record = import_reference(source)
    assert [t["name"] for t in record["timelines"]] == ["Cut A"]
    assert [l["projects"] for l in record["losses"] if "projects" in l] == [["Cut B"]]


def test_timeline_only_in_a_later_event_says_so(tmp_path):
    source = tmp_path / "later.fcpxml"
    source.write_text('<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/25s"/>'
                      '<asset id="r2" src="file:///a.mov" start="0s" duration="10s"/></resources><library>'
                      '<event name="Clips"><asset-clip ref="r2" offset="0s" duration="1s" name="a"/></event>'
                      '<event name="Edits"><project name="Cut"><sequence format="r1"><spine>'
                      '<asset-clip ref="r2" offset="0s" duration="1s" name="a"/></spine></sequence></project></event>'
                      '</library></fcpxml>', encoding="utf-8")
    assert _code(source) == "TIMELINE_SKIPPED"


def test_lane_that_is_not_a_number_is_bad_xml(tmp_path):
    source = tmp_path / "lane.fcpxml"
    source.write_text(_TWO_PROJECTS.replace('name="a"/>', 'name="a"/><asset-clip ref="r2" lane="x" offset="0s" duration="1s" name="c"/>', 1),
                      encoding="utf-8")
    assert _code(source) == "BAD_XML"


_FCP7_BODY = ('<xmeml version="5"><sequence><name>&x;</name><rate><timebase>25</timebase></rate>'
              '<media><video><track/></video></media></sequence></xmeml>')


@pytest.mark.parametrize("doctype,encoding", [
    ('<!DOCTYPE xmeml [<!ENTITY x "expanded">]>', "utf-8"),
    ('<!DOCTYPE xmeml [<!ENTITY x SYSTEM "file:///etc/passwd">]>', "utf-8"),
    ('<!DOCTYPE xmeml [<!ENTITY x "expanded">]>', "utf-16"),
], ids=["internal", "external", "internal-utf16"])
def test_entity_declarations_are_refused_before_the_adapter_parses(tmp_path, doctype, encoding):
    source = tmp_path / "evil.xml"
    source.write_bytes(f'<?xml version="1.0" encoding="{encoding}"?>{doctype}{_FCP7_BODY}'.encode(encoding))
    assert _code(source) == "UNSAFE_XML"


def _bundle(tmp_path, extra_files=0):
    bundle = tmp_path / "edit.fcpxmld"
    bundle.mkdir()
    (bundle / "Info.fcpxml").write_bytes((FIXTURES / "cut.fcpxmld" / "Info.fcpxml").read_bytes())
    for i in range(extra_files):
        (bundle / f"extra-{i}.bin").write_bytes(b"x")
    return bundle


@pytest.mark.parametrize("cap,value,make", [
    ("MAX_FILE_BYTES", 1000, lambda tmp: FIXTURES / "talking-head.xml"),
    ("MAX_BUNDLE_FILES", 2, lambda tmp: _bundle(tmp, extra_files=2)),
    ("MAX_BUNDLE_BYTES", 1000, lambda tmp: _bundle(tmp)),
    ("MAX_XML_DEPTH", 5, lambda tmp: FIXTURES / "talking-head.xml"),
])
def test_inputs_over_a_cap_are_refused(monkeypatch, tmp_path, cap, value, make):
    monkeypatch.setattr(reference_import, cap, value)
    assert _code(make(tmp_path)) == "INPUT_TOO_LARGE"


@pytest.mark.parametrize("link", ["file", "folder"])
def test_bundle_with_a_link_is_refused(tmp_path, link):
    bundle = _bundle(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("x")
    if link == "file":
        (bundle / "notes.txt").symlink_to(outside / "secret.txt")
    else:
        (bundle / "Media").symlink_to(outside, target_is_directory=True)
    assert _code(bundle) == "UNSAFE_INPUT"


def test_bundle_root_junction_is_refused_on_windows(tmp_path):
    if not sys.platform.startswith("win"):
        pytest.skip("junctions are Windows-only")
    target = _bundle(tmp_path)
    link = tmp_path / "linked.fcpxmld"
    import subprocess
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                            capture_output=True, text=True)
    if result.returncode:
        pytest.skip(f"mklink /J unavailable: {result.stderr.strip()}")
    assert _code(link) == "BAD_INPUT"


def test_missing_reference_extra_is_reported(monkeypatch):
    monkeypatch.setitem(sys.modules, "opentimelineio", None)
    assert _code(FIXTURES / "talking-head.xml") == "ADAPTER_MISSING"


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
