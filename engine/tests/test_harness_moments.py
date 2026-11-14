"""Required moments outputs, using reference manifests without rendering media."""
import copy
import json
from types import SimpleNamespace

import pytest

from harness import checks, media, replay


@pytest.mark.parametrize("changed,duration,missing,expected", [
    (True, 6.0, "draft", {"draft": "fail", "window": "pass"}),
    (True, 6.0, "window", {"draft": "pass", "window": "fail"}),
    (True, 6.0, "both", {"draft": "fail", "window": "fail"}),
    (True, 6.0, "all", {"draft": "fail", "window": "fail"}),
    (True, 1.0, "draft", {"draft": "fail", "window": "none"}),
    (True, 2.0, "window", {"draft": "pass", "window": "none"}),
    (True, 2.000001, "window", {"draft": "pass", "window": "none"}),
    (True, 2.000002, "window", {"draft": "pass", "window": "fail"}),
    (False, 6.0, "both", {"draft": "none", "window": "none"}),
])
def test_missing_moments_videos_fail_only_when_required(monkeypatch, tmp_path, changed, duration, missing, expected):
    pins = {"engineCommit": "reference", "ffmpeg": {"sha256": "ff"}}
    refs = []
    for k in range(2):
        folder = tmp_path / f"ref{k}"
        folder.mkdir()
        (folder / "export.mp4").write_text("new picture" if k and changed else "base picture", encoding="utf-8")
        (folder / "captions.json").write_text('{"cues": []}', encoding="utf-8")
        (folder / "segments.json").write_text("[]", encoding="utf-8")
        (folder / "done.json").write_text(json.dumps({"result": {"duration": duration}}), encoding="utf-8")
        replay.write_reference_manifest(folder, folder.name, pins)
        refs.append({"dir": folder, "key": folder.name, "moment": 0.5, "fps": 30.0,
                     "format": {"width": 1080, "height": 1920}})
    monkeypatch.setattr(media, "video_packets_md5", lambda ffmpeg, path: path.read_text(encoding="utf-8"))
    passed = {"status": "pass", "failures": [], "metrics": {}}
    monkeypatch.setattr(checks, "check_still", lambda *args, **kwargs: passed)
    monkeypatch.setattr(checks, "check_preview_video", lambda *args, **kwargs: passed)
    monkeypatch.setattr(checks, "check_final", lambda *args: passed)
    long = duration > 2.0 + 1e-6
    plans, files = [], []
    for k in range(2):
        draws = k == 0 or changed
        has_still = draws and (k == 0 or missing != "all")
        outputs = {"still0": {"sha256": "still", "file": "still.png"}} if has_still else {}
        if draws and (k == 0 or missing not in ("draft", "both", "all")):
            outputs["draft"] = {"sha256": "draft", "file": "draft.mp4"}
        if draws and long and (k == 0 or missing not in ("window", "both", "all")):
            outputs["window"] = {"sha256": "window", "file": "window.mp4"}
        plans.append({"stills": [0.5] if has_still else [], "intervals": [[0.0, duration]] if has_still else [],
                      "window": [0.0, 2.0] if "window" in outputs else None})
        files.append(outputs)
    run = {"flow": "moments", "plans": plans, "files": files,
           "finalFile": {"final": {"sha256": "final", "file": "final.mp4"}}}
    result = replay.check_take(SimpleNamespace(session=[{}, {}]), refs, [run, copy.deepcopy(run)],
                               "ffmpeg", "ffprobe", {"preview": {}, "final": {}}, pins,
                               {"previewScale": 0.5, "stillWidth": 540})
    note = result["steps"][1]
    assert note["coverage"]["status"] == ("fail" if missing == "all" else "pass")
    for name, status in expected.items():
        assert note[name]["status"] == status
        if status == "fail":
            assert f"no {name}" in note[name]["failures"][0]
