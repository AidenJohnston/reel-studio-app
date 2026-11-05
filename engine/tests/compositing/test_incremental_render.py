"""Same project in, same video out, whatever order the edits came in.

The app renders every note in one project folder, so a render reuses files earlier renders left
there: the cut voice, music mixes, b-roll layer files, covers. Each of those is found again by a key
built from what its author thought shaped the file. A key that leaves something out makes a render
depend on the edit history: a fresh project renders correctly, and the same project reached
through some earlier note renders something else.

This replays a short editing session the way the app does it (a draft for the AI, then the export,
note after note) in one folder, renders each state again in a fresh copy with no caches, and
requires the same bytes. It runs the engine's command line in a new process per render, as the app
does (app/src/main/engine.ts), so nothing carries over in memory between renders.
"""
from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from . import fixtures as fx

ENGINE_DIR = Path(__file__).resolve().parents[2]
W, H = 360, 640          # small and short: the session runs 22 renders
FACE = [W * 0.3, H * 0.3, W * 0.4, H * 0.3]         # synth_video's skin-toned box
# What a render reports back that the AI or the app reads. Paths, timings and the version number
# legitimately differ between a long-lived folder and a fresh one.
REPORTED = ("duration", "segments", "size", "layers", "zooms", "captions", "warnings", "broll")


def _engine(args: list, env: dict) -> dict:
    cmd = [sys.executable, "-s", "-E", "-B", "-X", "utf8", "-u", "-m", "reelengine", *map(str, args)]
    p = subprocess.run(cmd, cwd=ENGINE_DIR, env=env, capture_output=True, stdin=subprocess.DEVNULL, timeout=600)
    done = None
    for line in p.stdout.decode("utf-8", "replace").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("event") == "done":
            done = ev.get("result")
    if p.returncode != 0 or done is None:
        pytest.fail(f"engine {' '.join(map(str, args[:2]))} failed (exit {p.returncode}):\n"
                    f"{p.stdout.decode('utf-8', 'replace')[-1500:]}\n{p.stderr.decode('utf-8', 'replace')[-1500:]}")
    return done


def _env(root: Path, cache: Path, machine: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("REELENGINE_")}
    env.update({
        # the conftest's read roots for pytest's temp folders, passed on to the child
        "REELENGINE_EXTRA_READ_DIRS": os.environ.get("REELENGINE_EXTRA_READ_DIRS", ""),
        "REELENGINE_FFMPEG": fx.FFMPEG, "REELENGINE_FFPROBE": fx.FFPROBE, "REELENGINE_ROOT": str(root),
        "REELENGINE_CACHE_DIR": str(cache), "REELENGINE_CACHE": str(machine),
        # A hardware encoder need not give the same bytes twice for the same frames. The caches under
        # test sit before the encoder and don't depend on which one runs, so drafts use libx264 here.
        "REELENGINE_DRAFT_ENCODER": "libx264", "REELENGINE_HWACCEL": "0"})
    return env


def _new_project(pdir: Path, video: Path) -> None:
    """What a project holds before any render: the take, its transcript and face track."""
    fx.make_project(pdir, video, keep=((0.5, 3.0), (4.0, 6.5)))
    samples = [{"t": t / 2, "box": FACE, "core": [FACE[0] + 20, FACE[1] + 45, FACE[2] - 40, FACE[3] - 60]}
               for t in range(0, 17)]
    (pdir / "work" / "face-s1.json").write_text(json.dumps(
        {"width": W, "height": H, "detector": "test", "samples": samples}), encoding="utf-8")


def _write_state(pdir: Path, state: dict) -> None:
    """Write a note's project, keeping the version number, which only render writes (as in the app)."""
    pf = pdir / "project.json"
    proj = copy.deepcopy(state)
    if pf.exists():
        proj["version"] = json.loads(pf.read_text(encoding="utf-8")).get("version", 0)
    pf.write_text(json.dumps(proj, indent=1), encoding="utf-8")


def _session(pdir: Path) -> list:
    """(note, state) pairs. The first only seeds the folder; each later note changes what one or
    more caches are keyed on."""
    base = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    words = json.loads((pdir / "work" / "transcript.json").read_text(encoding="utf-8"))["words"]

    def wid(src_t: float) -> str:
        return min(words, key=lambda w: abs(w["s"] - src_t))["id"]

    def span(a: float, b: float) -> dict:
        return {"from": wid(a), "to": wid(b)}

    s = copy.deepcopy(base)
    s["format"] = {"width": W, "height": H, "fps": 30}
    s["sources"][0].update(width=W, height=H)
    s["music"] = {"enabled": True, "track": "Library/song.wav", "startAt": 1.0, "level": "under-voice",
                  "automation": [], "fadeOut": 1.0}
    states = [("start", copy.deepcopy(s))]

    def note(text: str, change) -> None:
        nonlocal s
        s = copy.deepcopy(s)
        change(s)
        states.append((text, copy.deepcopy(s)))

    # b-roll that the engine encodes into a video file under work/layers
    note("a clip, and the screenshot above me", lambda p: p["broll"].extend([
        {"id": "b1", "anchor": span(1.0, 2.0), "leadIn": 0.13, "treatment": "full-frame",
         "asset": "Library/clip.mp4", "params": {}},
        {"id": "b2", "anchor": span(4.5, 5.5), "leadIn": 0.13, "treatment": "split-top",
         "asset": "Library/screenshot.png", "params": {}}]))
    after_broll = copy.deepcopy(s)
    note("music quieter, end earlier", lambda p: (
        p["music"].update(level="quiet"), p["cut"]["keep"][1].update(to=wid(5.8))))
    note("bigger captions, zoom, cover text, flip me", lambda p: (
        p["captions"]["style"].update(size=60), p["zooms"].append({"anchor": span(2.0, 2.8), "scale": 1.3}),
        p["cover"].update(text="Cover"), p["sources"][0].update(mirror=True)))
    note("undo the last two", lambda p: (p.clear(), p.update(copy.deepcopy(after_broll))))
    return states


def _render(pdir: Path, kind: str, root: Path, env: dict, keep: Path) -> tuple:
    """Run `render` the way the AI's render_draft (`--draft`) or the export (no flag) does
    (ai/src/tools.ts, ai/src/editor.ts). Returns ({output: copy}, result); the copies are taken
    straight away because the next render may replace the files."""
    # --no-verify: verify only reads the finished file, so it can't be where a stale cache hides
    res = _engine(["render", "--project", pdir, "--root", root, "--no-verify",
                   *(["--draft"] if kind == "draft" else [])], env)
    keep.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, f in (("video", res["file"]), ("cover", res.get("cover"))):
        if f:
            files[f"{kind} {name}"] = Path(shutil.copy2(f, keep / f"{kind}-{name}{Path(f).suffix}"))
    return files, res


def _report(res: dict, pdir: Path) -> str:
    text = json.dumps({k: res.get(k) for k in REPORTED}, sort_keys=True)
    for p in {str(pdir), str(pdir.resolve()), pdir.as_posix(), pdir.resolve().as_posix()}:
        text = text.replace(json.dumps(p)[1:-1], "<project>")
    return text


def _framemd5(f: Path, stream: str) -> list:
    p = subprocess.run([fx.FFMPEG, "-v", "error", "-i", str(f), "-map", f"0:{stream}?", "-f", "framemd5", "-"],
                       capture_output=True, text=True, check=True)
    return [ln for ln in p.stdout.splitlines() if ln and not ln.startswith("#")]


def _where(a: Path, b: Path) -> str:
    """Where two different files first differ, in words a person can act on."""
    if a.suffix != ".mp4":
        return "different pixels"
    for stream, name in (("v", "video"), ("a", "audio")):
        fa, fb = _framemd5(a, stream), _framemd5(b, stream)
        if fa != fb:
            i = next((k for k, (x, y) in enumerate(zip(fa, fb)) if x != y), min(len(fa), len(fb)))
            return f"{name} differs from frame {i} ({len(fa)} frames vs {len(fb)})"
    return "same decoded frames, different container bytes"


def _take(path: Path, dur: float = 8.0) -> Path:
    """synth_video's talking head plus a red mark on the left, so a flipped frame differs from an
    unflipped one."""
    vf = (f"color=c=0x6a6560:s={W}x{H}:r=30:d={dur},"
          f"drawbox=x={W * 0.3:.0f}:y={H * 0.3:.0f}:w={W * 0.4:.0f}:h={H * 0.3:.0f}:color=0xd9a98c:t=fill,"
          f"drawbox=x=0:y=0:w={W // 4}:h={H // 5}:color=0xd02020:t=fill")
    af = f"sine=f=220:d={dur}:sample_rate=48000,volume='if(lt(mod(t,1.2),0.8),0.3,0.0)':eval=frame"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf, "-f", "lavfi", "-i", af,
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(path)], check=True)
    return path


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("incremental media")
    return {"video": _take(d / "talk.mp4"),
            "clip": fx.synth_clip(d / "clip.mp4", dur=3.0, w=640, h=360),
            "song": fx.synth_tone_song(d / "song.wav", dur=10.0), **fx.synth_images(d / "img")}


def test_every_state_renders_the_same_after_any_history(tmp_path, media):
    root = tmp_path / "root"
    lib = root / "Library"
    lib.mkdir(parents=True)
    shutil.copy2(media["clip"], lib / "clip.mp4")
    shutil.copy2(media["screenshot"], lib / "screenshot.png")
    shutil.copy2(media["song"], lib / "song.wav")
    machine = tmp_path / "machine-cache"

    warm = tmp_path / "warm"
    _new_project(warm, media["video"])
    warm_env = _env(root, tmp_path / "warm-cache", machine)
    session = _session(warm)
    # last, the user replaces the song file under the same name
    session.append(("same song file, new song", None))

    diffs = []
    for i, (text, state) in enumerate(session):
        if state is None:
            other = tmp_path / "other-song.wav"
            subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=330:d=10:sample_rate=48000",
                            "-ac", "2", str(other)], check=True)
            os.replace(other, lib / "song.wav")
            state = session[i - 1][1]
        _write_state(warm, state)
        if i == 0:
            for kind in ("draft", "export"):
                _render(warm, kind, root, warm_env, tmp_path / "out" / "0-warm")
            continue
        for kind in ("draft", "export"):       # the app's order: the AI's draft, then the export
            w_files, w_res = _render(warm, kind, root, warm_env, tmp_path / "out" / f"{i}-warm")
            # each fresh render gets its own folder: an export after a draft in the same folder
            # would be the history this test compares against
            cold = tmp_path / f"cold-{i}-{kind}"
            _new_project(cold, media["video"])
            _write_state(cold, state)
            c_files, c_res = _render(cold, kind, root, _env(root, tmp_path / f"cache-{i}-{kind}", machine),
                                     tmp_path / "out" / f"{i}-cold")
            assert w_files.keys() == c_files.keys(), (text, w_files.keys(), c_files.keys())
            # equal outputs prove nothing if b-roll failed the same way in both folders
            for res in (w_res, c_res):
                assert res["layers"] >= len(state["broll"]), (text, kind, res["layers"], res["broll"])
                assert not [r for r in res["broll"] if r.get("skipped")], (text, kind, res["broll"])
            for name in w_files:
                if w_files[name].read_bytes() != c_files[name].read_bytes():
                    diffs.append(f"after '{text}': {name}: {_where(w_files[name], c_files[name])}")
            if _report(w_res, warm) != _report(c_res, cold):
                diffs.append(f"after '{text}': {kind} report: {_report(w_res, warm)} vs {_report(c_res, cold)}")

    assert not diffs, "a render reused something that no longer matched the project:\n" + "\n".join(diffs)
