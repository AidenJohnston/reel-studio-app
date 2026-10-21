import json
import os
from pathlib import Path
from types import SimpleNamespace

from conftest import mkwords
from reelengine import cli, project, render


def test_explicit_render_keeps_all_writes_out_of_live_project(tmp_path, monkeypatch):
    live = tmp_path / "live"
    stage = live / ".staging" / "note"
    out = stage / "version"
    (live / "media").mkdir(parents=True)
    (live / "media" / "take.mp4").write_bytes(b"source")
    p = project.new_project("test")
    p["sources"] = [{"id": "s1", "path": "media/take.mp4", "duration": 1.0,
                     "fps": 30, "width": 90, "height": 160, "rotation": 0}]
    p["cut"]["keep"] = [{"from": "w0", "to": "w1"}]
    p["captions"]["enabled"] = False
    project.save(live, p)
    project.write_json(live / "work" / "transcript.json",
                       {"words": mkwords([(0, .3, "hello"), (.3, .7, "world")])})
    before = {f.relative_to(live): f.read_bytes() for f in live.rglob("*") if f.is_file()}
    project.save(stage, p)
    staged_asset = stage / "work" / "assets" / "new.png"
    staged_asset.parent.mkdir(parents=True)
    staged_asset.write_bytes(b"image")
    p["broll"] = [{"id": "b1", "asset": "work/assets/new.png",
                   "anchor": {"from": "w0", "to": "w1"}, "treatment": "full-frame"}]
    project.save(stage, p)

    def audio(ctx, segments, sources, work, warnings):
        assert os.environ["REELENGINE_CACHE_DIR"] == str(stage / "work" / "cache")
        assert sources["s1"] == live / "media" / "take.mp4"
        path = work / "voice.wav"
        path.write_bytes(b"sound")
        return path

    def layers(ctx):
        from reelengine.compose_util import resolve_asset
        assert resolve_asset(ctx, "work/assets/new.png") == staged_asset
        (ctx.work / "layers").mkdir(parents=True)
        project.write_json(ctx.work / "layers" / "layers.json", {"items": []})
        return []

    def cover(ctx, target):
        target.write_bytes(b"cover")
        project.write_json(ctx.work / "cover.json", {"chosen": 0})
        return target

    def encode(cmd, *args, **kwargs):
        Path(cmd[-1]).write_bytes(b"video")
        return ""

    monkeypatch.setattr(render, "build_audio", audio)
    monkeypatch.setattr(render, "build_video_cmd", lambda *a, **k: [str(a[-2])])
    monkeypatch.setattr(render.tools, "ffmpeg_progress", encode)
    monkeypatch.setattr(render, "_opt_module", lambda name: SimpleNamespace(build_layers=layers) if name == "broll"
                        else SimpleNamespace(render=cover) if name == "cover" else None)
    from reelengine import verify
    monkeypatch.setattr(verify, "check", lambda *a, **k: {"ok": True, "fails": [], "warns": []})
    result = {}
    monkeypatch.setattr(cli.proto, "capture_stdout", lambda: None)
    monkeypatch.setattr(cli.proto, "done", lambda value: result.update(value))
    assert cli.main(["render", "--project", str(live), "--project-file", str(stage / "project.json"),
                     "--out", str(out)]) == 0
    assert result["file"] == str(out / "export.mp4")
    assert {f.relative_to(live): f.read_bytes() for f in live.rglob("*")
            if f.is_file() and stage not in f.parents} == before
    assert {"export.mp4", "cover.png", "verify.json", "render.json", "project.json", "assets.json"} <= {
        f.name for f in out.iterdir()}
    assert json.loads((stage / "project.json").read_text())["version"] == 1
    assert json.loads((out / "project.json").read_text())["version"] == 1
    cover_args = cli.build_parser().parse_args(["cover", "--project", str(live),
                                                "--project-file", str(stage / "project.json"), "--out", str(out)])
    assert cover_args.fn(cover_args)["file"] == str(out / "cover.png")
    assert {f.relative_to(live): f.read_bytes() for f in live.rglob("*")
            if f.is_file() and stage not in f.parents} == before
    assert not (live / "versions").exists()
