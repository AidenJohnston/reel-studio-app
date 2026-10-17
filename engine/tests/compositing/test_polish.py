"""Polish-pass regressions: exact frame counts, side-card placement, the CLI asset/music commands,
version scratch previews."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import render


def _frames(p: Path) -> int:
    out = subprocess.run([fx.FFPROBE, "-v", "error", "-count_frames", "-select_streams", "v",
                          "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(p)],
                         capture_output=True, text=True).stdout
    return int(out.strip())


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    return fx.synth_video(tmp_path_factory.mktemp("media") / "take.mp4", dur=12.0)


@pytest.mark.parametrize("keep", [((1.0, 5.0), (6.0, 11.0)), ((0.1, 11.9),)])
def test_render_has_every_planned_frame(tmp_path, video, keep):
    """The fps filter used to drop the last frame of every render (one frame short)."""
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=keep)
    res = render.run(pdir, draft=True, root=tmp_path, verify=False)
    assert _frames(Path(res["file"])) == round(res["duration"] * 30)


def _zones(left_w, right_w, H=1920):
    return [{"zone": "left", "x": 30, "y": 300, "w": left_w, "h": 1000},
            {"zone": "right", "x": 1050 - right_w, "y": 300, "w": right_w, "h": 1000},
            {"zone": "above-face", "x": 30, "y": 100, "w": 1020, "h": 400}]


def test_side_card_fit_honours_side_and_auto():
    from reelengine import broll
    z = _zones(380, 300)
    assert broll.side_card_fit(z, "left", 1.0, 1080, 1920)["side"] == "left"
    assert broll.side_card_fit(z, "right", 1.0, 1080, 1920)["side"] == "right"
    auto = broll.side_card_fit(z, "auto", 1.0, 1080, 1920)
    assert auto["ok"] and auto["side"] == "left"          # the roomier side


def test_side_card_fit_close_up_falls_back_with_a_reason():
    from reelengine import broll
    fit = broll.side_card_fit(_zones(220, 200), "right", 1.0, 1080, 1920)
    assert not fit["ok"] and "right" in fit["why"] and "split" in fit["why"]
    # a wide screenshot can't read in a 380 px strip either
    assert not broll.side_card_fit(_zones(380, 380), "auto", 16 / 9, 1080, 1920)["ok"]


def test_side_card_text_needs_a_readable_width():
    from reelengine import broll
    z = _zones(330, 330)
    assert broll.side_card_fit(z, "auto", 1.0, 1080, 1920)["ok"]                 # a logo reads at ~300 px
    assert not broll.side_card_fit(z, "auto", 1.0, 1080, 1920, iconic=False)["ok"]   # a text card doesn't
    up = broll.upper_side_zone(z, "right", 1080)
    assert up["zone"] == "above-face-right" and up["x"] + up["w"] == 1050 and up["w"] == round(1020 * 0.7)


def test_cue_position_moves_inside_split_spans():
    from reelengine import captions
    spans = [(10.0, 12.0, 0.31)]
    assert captions.cue_position({"s": 10.2, "e": 11.0}, 0.70, spans) == 0.31
    assert captions.cue_position({"s": 11.8, "e": 13.0}, 0.70, spans) == 0.70   # mostly outside
    assert captions.cue_position({"s": 1.0, "e": 2.0}, 0.70, None) == 0.70


# --- one CLI entry point for A2's asset + music commands ---------------------------------------

def _cli(*args, cwd=None):
    import sys
    proc = subprocess.run([sys.executable, "-m", "reelengine", *map(str, args)], capture_output=True,
                          text=True, encoding="utf-8", cwd=cwd)
    lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]   # stdout is JSON only
    return proc.returncode, lines[-1], lines


def test_cli_analyze_music(tmp_path):
    song = fx.synth_tone_song(tmp_path / "Library" / "Music" / "tone song.wav", dur=20.0)
    code, last, _ = _cli("analyze-music", "Library/Music/tone song.wav", "--root", tmp_path, "--no-beats")
    assert code == 0 and last["event"] == "done"
    r = last["result"]
    assert r["duration"] == pytest.approx(20.0, abs=0.2) and "suggestedStartAt" in r and "beats" not in r
    code, last, _ = _cli("analyze-music", "Library/Music/nope.mp3", "--root", tmp_path)
    assert code == 1 and last["code"] == "MUSIC_MISSING" and last["userMessage"]


def test_cli_fetch_image_into_project(tmp_path):
    import functools
    import http.server
    import threading
    from PIL import Image
    site = tmp_path / "site"
    site.mkdir()
    Image.new("RGB", (64, 48), (200, 30, 30)).save(site / "pic.webp")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(site)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        pdir = tmp_path / "proj ü"
        url = f"http://127.0.0.1:{srv.server_port}/pic.webp"
        code, last, _ = _cli("fetch-image", "--project", pdir, "--url", url, "--name", "red")
        assert code == 0, last
        assert last["result"]["asset"] == "work/assets/red.png"
        assert Path(last["result"]["path"]).is_absolute() and Path(last["result"]["path"]).exists()
    finally:
        srv.shutdown()


def test_cli_download_media_bad_link_is_plain_english(tmp_path):
    code, last, _ = _cli("download-media", "--url", "not a link", "--root", tmp_path)
    assert code == 1 and last["event"] == "error" and last["code"] == "BAD_LINK" and last["userMessage"]


def test_cli_search_images_needs_words():
    code, last, _ = _cli("search-images", "--query", "  ")
    assert code == 1 and last["userMessage"]


# --- versions: only finals are versions; previews share one scratch folder ----------------------

def test_previews_never_make_version_folders(tmp_path, video):
    pdir = tmp_path / "p"
    fx.make_project(pdir, video, keep=((1.0, 5.0), (6.0, 11.0)))
    vroot = pdir / "versions"

    def folders():
        return sorted(p.name for p in vroot.iterdir() if p.is_dir()) if vroot.exists() else []

    r1 = render.run(pdir, draft=True, root=tmp_path, verify=False)
    assert r1["preview"] and Path(r1["file"]).parent.name == "preview" and r1["version"] == 1
    r2 = render.run(pdir, draft=False, window="1:3", root=tmp_path, verify=False)   # a window is a preview
    render.run(pdir, draft=False, window="2:4", root=tmp_path, verify=False)
    assert r2["preview"] and folders() == ["preview"]
    assert [p.name for p in (vroot / "preview").glob("window_*.mp4")] == ["window_2.0-4.0.mp4"]
    assert json.loads((pdir / "project.json").read_text(encoding="utf-8"))["version"] == 0

    f1 = render.run(pdir, draft=False, root=tmp_path, verify=False)
    assert not f1["preview"] and f1["version"] == 1 and (vroot / "v1" / "export.mp4").exists()
    # change the edit, preview twice: still one version, the preview is overwritten
    proj = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    proj["cut"]["gapCap"] = 0.12
    (pdir / "project.json").write_text(json.dumps(proj), encoding="utf-8")
    d = render.run(pdir, draft=True, root=tmp_path, verify=False)
    render.run(pdir, draft=True, root=tmp_path, verify=False)
    assert d["version"] == 2 and folders() == ["preview", "v1"]
    f2 = render.run(pdir, draft=False, root=tmp_path, verify=False)
    assert f2["version"] == 2 and folders() == ["preview", "v1", "v2"]
    # the same edit again reuses v2
    assert render.run(pdir, draft=False, root=tmp_path, verify=False)["version"] == 2
