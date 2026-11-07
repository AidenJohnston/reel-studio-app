import io
import json
import multiprocessing
import sys
import time
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
    ("clip-ids.xml", _premiere_file_references(refs=20), "INPUT_TOO_LARGE"),
], ids=["nested-compound-clips", "compound-clip-cycle", "premiere-file-references", "premiere-clip-ids"])
def test_references_that_expand_without_bound_are_refused(monkeypatch, tmp_path, name, body, code):
    if name == "clip-ids.xml":
        monkeypatch.setattr(reference_import, "MAX_EXPANDED_CLIPS", 10)
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


def _sleeping_child(conn, *args):
    # A module-level target survives spawn; a patched _build in the parent would not.
    time.sleep(6)


@pytest.mark.parametrize("limit,value", [("ADAPTER_SECONDS", 0.5), ("ADAPTER_MEMORY_BYTES", 1)],
                         ids=["time", "memory"])
def test_adapter_past_its_limit_is_stopped(monkeypatch, limit, value):
    monkeypatch.setattr(reference_import, limit, value)
    monkeypatch.setattr(reference_import, "_child", _sleeping_child)
    started = time.monotonic()
    assert _code(FIXTURES / "talking-head.xml") == "INPUT_TOO_LARGE"
    assert time.monotonic() - started < 3
    assert multiprocessing.active_children() == []


def test_fcpxml_expansion_checks_are_time_limited(monkeypatch, tmp_path):
    source = tmp_path / "filler.fcpxml"
    source.write_text(_event_clip_note(uses=5000, note="").replace(
        "</spine>", "<x/>" * 100_000 + "</spine>"), encoding="utf-8")
    monkeypatch.setattr(reference_import, "ADAPTER_SECONDS", 0.1)
    started = time.monotonic()
    assert _code(source) == "INPUT_TOO_LARGE"
    assert time.monotonic() - started < 3
    assert multiprocessing.active_children() == []


@pytest.mark.parametrize("kind", ["fcpxml", "premiere"])
def test_timeline_duration_keeps_a_trailing_gap(tmp_path, kind):
    if kind == "fcpxml":
        body = (FIXTURES / "ntsc-lanes.fcpxml").read_text().replace(
            'duration="105105/30000s"', 'duration="150150/30000s"').replace(
            "</spine>\n    </sequence>",
            '<gap offset="105105/30000s" duration="45045/30000s"/>'
            '</spine>\n    </sequence>')
        expected = {"value": 150, "rate": 30000 / 1001}
        suffix = ".fcpxml"
    else:
        body = (FIXTURES / "talking-head.xml").read_text().replace(
            "<duration>100</duration>", "<duration>150</duration>", 1)
        expected = {"value": 150, "rate": 25}
        suffix = ".xml"
    source = tmp_path / f"trailing{suffix}"
    source.write_text(body, encoding="utf-8")
    (timeline,) = import_reference(source)["timelines"]
    assert timeline["duration"] == expected
    last_end = max(item["trackRange"]["start"]["value"] + item["trackRange"]["duration"]["value"]
                   for track in timeline["tracks"] for item in track["items"] if "trackRange" in item)
    assert last_end < timeline["duration"]["value"]


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


def _two_sequences(tmp_path):
    """talking-head.xml with a second top-level sequence beside the first."""
    text = (FIXTURES / "talking-head.xml").read_text(encoding="utf-8")
    start, end = text.index('  <sequence id="seq-1">'), text.index("</xmeml>")
    second = text[start:end].replace('id="seq-1"', 'id="seq-2"').replace("<name>Talking head cut</name>", "<name>Second cut</name>", 1)
    source = tmp_path / "two-sequences.xml"
    source.write_text(text[:end] + second + text[end:], encoding="utf-8")
    return source


def _two_projects(tmp_path):
    source = tmp_path / "two.fcpxml"
    source.write_text(_TWO_PROJECTS, encoding="utf-8")
    return source


@pytest.mark.parametrize("make,count", [
    (lambda _: FIXTURES / "talking-head.xml", 1),
    (lambda _: FIXTURES / "ntsc-lanes.fcpxml", 1),
    (lambda _: FIXTURES / "cut.fcpxmld", 1),
    (_two_sequences, 2),
    (_two_projects, 1),   # the adapter reads only the first top-level project
], ids=["premiere", "fcpxml", "fcpxmld", "two-sequences", "two-projects"])
def test_scan_counts_the_timelines_an_import_returns(tmp_path, make, count):
    source = make(tmp_path)
    assert reference_import.count_timelines(source) == count
    assert len(import_reference(source)["timelines"]) == count


def test_scan_gives_each_unreadable_export_its_reason_and_reads_the_rest(tmp_path):
    later = tmp_path / "later.fcpxml"
    later.write_text('<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/25s"/></resources><library>'
                     '<event name="Clips"/><event name="Edits"><project name="Cut"><sequence format="r1"><spine/>'
                     '</sequence></project></event></library></fcpxml>', encoding="utf-8")
    notes = tmp_path / "notes.xml"
    notes.write_text("<notes>not an edit</notes>", encoding="utf-8")
    good = FIXTURES / "talking-head.xml"
    assert reference_import.scan([later, notes, good])["files"] == [
        {"path": str(later), "error": {"code": "TIMELINE_SKIPPED", "message": reference_import._USER["TIMELINE_SKIPPED"]}},
        {"path": str(notes), "error": {"code": "NO_TIMELINE", "message": reference_import._USER["NO_TIMELINE"]}},
        {"path": str(good), "timelines": 1},
    ]


def test_cli_scan_reports_every_file():
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(["reference-scan", str(FIXTURES / "talking-head.xml"), str(FIXTURES / "cut.fcpxmld")])
    finally:
        proto.set_stream(None)
    done = json.loads(buf.getvalue().splitlines()[-1])
    assert code == 0 and done["event"] == "done"
    assert [f["timelines"] for f in done["result"]["files"]] == [1, 1]


# CapCut, DaVinci Resolve's EDL and FCPXML. The samples are built from each format's published or documented layout
# (reference_capcut.py, reference_edl.py); none is a real export, so a real CapCut or Resolve file may differ.

def _us(r):
    return r["start"]["value"], r["duration"]["value"], r["start"]["rate"]


def test_capcut_draft_reads_its_lanes_in_time_order_with_media_text_and_transitions():
    record = import_reference(FIXTURES / "capcut-draft" / "draft_content.json")
    assert record["source"]["adapter"] == "capcut"
    assert record["source"]["writer"] == "CapCut" and record["source"]["version"] == "110.0.0"
    (timeline,) = record["timelines"]
    assert timeline["name"] == "capcut-draft"
    assert timeline["duration"] == {"value": 12_000_000, "rate": 1_000_000}
    assert [(t["name"], t["kind"]) for t in timeline["tracks"]] == [
        ("0", "Video"), ("1", "Video"), ("A1", "Audio"), ("T1", "Video"), ("T2", "Video")]

    main = timeline["tracks"][0]["items"]
    # segments listed out of order are placed by their start; the Mix on the second sits between it and the third
    assert [i["type"] for i in main] == ["clip", "clip", "transition", "clip", "clip"]
    assert [_us(i["trackRange"])[:2] for i in main if i["type"] == "clip"] == [
        (0, 3_000_000), (3_000_000, 3_000_000), (6_000_000, 3_000_000), (9_000_000, 3_000_000)]
    assert _us(main[0]["sourceRange"])[0] == 10_000_000
    assert main[0]["media"] == {"kind": "file", "url": "file:///Users/me/Movies/clips/talk.mp4", "name": "talk.mp4"}
    assert main[2]["name"] == "Mix" and main[2]["inOffset"]["value"] == main[2]["outOffset"]["value"] == 250_000

    (picture,) = timeline["tracks"][1]["items"]
    assert picture["media"]["url"] == "file:///C:/Users/me/Pictures/chart.png"
    (song,) = timeline["tracks"][2]["items"]
    assert song["media"]["url"] == "file:///Users/me/Music/song.mp3"
    (title,) = timeline["tracks"][3]["items"]
    assert title["media"] == {"kind": "generator", "generator": "Text", "name": "Three tips"}
    assert _us(title["trackRange"])[:2] == (500_000, 2_000_000)
    # CapCut's own captions are not a title the person put on screen
    (caption,) = timeline["tracks"][4]["items"]
    assert caption["media"]["generator"] == "Captions"

    assert record["mediaRefs"] == ["file:///C:/Users/me/Pictures/chart.png", "file:///Users/me/Movies/clips/talk.mp4",
                                   "file:///Users/me/Music/song.mp3"]
    assert {"path": "tracks[5]", "reason": "CapCut effects are not read"} in record["losses"]
    assert reference_import.count_timelines(FIXTURES / "capcut-draft" / "draft_content.json") == 1


def test_capcut_project_folder_reads_its_draft_and_skips_an_encrypted_one(tmp_path):
    folder = tmp_path / "Bread reel"
    folder.mkdir()
    draft = (FIXTURES / "capcut-draft" / "draft_content.json").read_bytes()
    (folder / "draft_info.json").write_bytes(draft)
    # JianYing 6+ encrypts draft_content.json and leaves draft_info.json plain beside it
    (folder / "draft_content.json").write_bytes(b"\x8f\x12encrypted-bytes\x00")
    record = import_reference(folder)
    assert record["source"]["path"].endswith("draft_info.json")
    assert record["timelines"][0]["name"] == "Bread reel"
    assert len(record["timelines"][0]["tracks"][0]["items"]) == 5


def test_encrypted_or_foreign_capcut_draft_is_refused_in_words(tmp_path):
    locked = tmp_path / "locked" / "draft_content.json"
    locked.parent.mkdir()
    locked.write_bytes(b"\x8f\x12encrypted-bytes\x00")
    assert _code(locked) == "LOCKED_DRAFT"
    assert _code(locked.parent) == "LOCKED_DRAFT"
    other = tmp_path / "other" / "draft_content.json"
    other.parent.mkdir()
    other.write_text('{"name": "not a draft"}', encoding="utf-8")
    assert _code(other) == "BAD_DRAFT"
    broken = json.loads((FIXTURES / "capcut-draft" / "draft_content.json").read_text(encoding="utf-8"))
    del broken["tracks"][0]["segments"][0]["target_timerange"]
    bad = tmp_path / "bad" / "draft_content.json"
    bad.parent.mkdir()
    bad.write_text(json.dumps(broken), encoding="utf-8")
    assert _code(bad) == "BAD_DRAFT"
    assert _code(tmp_path / "other") == "BAD_DRAFT"
    empty = tmp_path / "empty"
    empty.mkdir()
    assert _code(empty) == "BAD_INPUT"


def test_resolve_edl_reads_cuts_a_dissolve_and_the_song_at_the_rate_its_frames_allow():
    record = import_reference(FIXTURES / "resolve-cut.edl")
    assert record["source"]["adapter"] == "cmx_3600"
    (timeline,) = record["timelines"]
    assert timeline["name"] == "Timeline 1"
    assert timeline["globalStart"] == {"value": 108000, "rate": 30} and timeline["dropFrame"] is False
    assert timeline["duration"]["value"] == 224
    video, audio = timeline["tracks"]
    assert (video["name"], video["kind"], audio["name"], audio["kind"]) == ("V", "Video", "A", "Audio")
    assert [i["type"] for i in video["items"]] == ["clip", "clip", "transition", "clip"]
    clips = [i for i in video["items"] if i["type"] == "clip"]
    assert [i["name"] for i in clips] == ["talk.mov", "talk.mov", "broll.mov"]
    assert [_frames(i["trackRange"])[:2] for i in clips] == [(0, 75), (75, 59), (134, 90)]
    assert [_frames(i["sourceRange"])[0] for i in clips] == [300, 900, 1800]
    assert video["items"][2]["outOffset"]["value"] == 15
    (song,) = audio["items"]
    assert song["name"] == "song.mp3" and song["media"]["url"] is None
    assert any("does not say its frame rate; read as 30 fps" in l["reason"] for l in record["losses"])
    assert reference_import.count_timelines(FIXTURES / "resolve-cut.edl") == 1


def test_drop_frame_edl_counts_frames_as_29_97(tmp_path):
    edl = tmp_path / "df.edl"
    edl.write_text("TITLE: DF\nFCM: DROP FRAME\n\n"
                   "001  AX  V  C  00:00:00;00 00:01:00;02 01:00:00;00 01:01:00;02\n", encoding="utf-8")
    (timeline,) = import_reference(edl)["timelines"]
    (clip,) = timeline["tracks"][0]["items"]
    assert clip["trackRange"]["duration"] == {"value": 1800, "rate": 30000 / 1001}
    assert timeline["dropFrame"] is True


@pytest.mark.parametrize("body,code", [
    ("TITLE: Empty\nFCM: NON-DROP FRAME\n", "NO_TIMELINE"),
    ("TITLE: Bad\n001  AX  V  C  00:00:00:00 00:00:01:00 01:00:00:00\n", "BAD_EDL"),
    ("001  AX  V  C  00:00:02:00 00:00:01:00 01:00:00:00 01:00:01:00\n", "BAD_EDL"),
], ids=["no-events", "short-event-line", "out-before-in"])
def test_unreadable_edl_is_refused(tmp_path, body, code):
    edl = tmp_path / "cut.edl"
    edl.write_text(body, encoding="utf-8")
    assert _code(edl) == code


def test_resolve_fcpxml_is_read_and_named_for_resolve():
    record = import_reference(FIXTURES / "resolve-timeline.fcpxml")
    assert record["source"]["adapter"] == "fcpx_xml" and record["source"]["writer"] == "DaVinci Resolve"
    (timeline,) = record["timelines"]
    spine = timeline["tracks"][0]["items"]
    assert [_frames(i["trackRange"])[1] for i in spine] == [75, 60, 105]
    assert [_frames(i["sourceRange"])[0] for i in spine] == [300, 900, 1200]
    assert timeline["globalStart"]["value"] == 108000
    assert import_reference(FIXTURES / "ntsc-lanes.fcpxml")["source"]["writer"] is None
