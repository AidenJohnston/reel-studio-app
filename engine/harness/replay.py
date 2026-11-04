"""Setup (corpus + reference finals) and the timed replay of each take's editing session.

One timed run of a take: a fresh copy of its project (no render cache, no versions, a fresh song
cache), then for each note: write the state as project.json, `render --draft` (what the AI's
render_draft runs), `frames --times` on that draft (look_at_frames), and `render --window a:b`
around the changed moment; after the last note, `render` (the final export). Each command is timed
from spawn to exit; the output is checked to be complete after the clock stops.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import statistics
from pathlib import Path

from . import checks, corpus, media
from .engines import Engine, sha256_file

STEPS = ("draft", "still", "window")


def _link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def copy_project(src: Path, dst: Path) -> None:
    """project.json, work/transcript.json and the media (hard-linked: no extra disk)."""
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst, copy_function=lambda a, b: _link_or_copy(Path(a), Path(b)))


def write_state(proj_dir: Path, state: dict) -> None:
    tmp = proj_dir / "project.json.harness.tmp"
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(tmp, proj_dir / "project.json")


def grid(fps: float) -> float:
    """The shortest multiple of the frame time that is a whole number of milliseconds, so times
    passed on the command line (3 decimals) land exactly on frame starts."""
    for k in range(1, 1001):
        step = k / fps
        if abs(step * 1000 - round(step * 1000)) < 1e-9:
            return round(step, 6)
    raise ValueError(f"no millisecond frame grid for {fps} fps")


def snap(t: float, step: float) -> float:
    return round(math.floor(t / step + 1e-9) * step, 3)


def moment_time(segments: list, words: dict, word_id: str) -> float:
    """Output second where `word_id` starts, from the reference render's segment list."""
    w = words[word_id]
    for s in segments:
        if s["source"] == w["source"] and s["src_start"] - 1e-6 <= w["s"] < s["src_end"]:
            return s["out_start"] + (w["s"] - s["src_start"])
    raise ValueError(f"moment word {word_id} is not in the cut")


def plan_previews(t: float, duration: float, fps: float) -> dict:
    """The 2 s window around a moment and two stills in it, on the frame grid."""
    g = grid(fps)
    a = snap(max(0.0, t - 1.0), g)
    b = snap(min(duration, a + 2.0), g)
    a = snap(max(0.0, b - 2.0), g)
    stills = sorted({snap(min(t, duration - 0.05), g), snap(min(t + 0.5, duration - 0.05), g)})
    return {"window": [a, b], "stills": stills}


# --- takes --------------------------------------------------------------------------------------

class Take:
    def __init__(self, tid: str, folder: Path):
        self.id = tid
        self.dir = folder
        self.project = folder / "project"
        self.session = json.loads((folder / "session.json").read_text(encoding="utf-8"))["steps"]

    def state(self, step: dict) -> dict:
        return json.loads((self.dir / step["state"]).read_text(encoding="utf-8"))

    def words(self) -> dict:
        tr = json.loads((self.project / "work" / "transcript.json").read_text(encoding="utf-8"))
        return {w["id"]: w for w in tr["words"]}

    def media_hashes(self) -> dict:
        return {f.name: sha256_file(f) for f in sorted((self.project / "media").iterdir()) if f.is_file()}


def reference_key(take: Take, state: dict, pins: dict, song_sha: str) -> str:
    """Everything the reference final of one state depends on."""
    transcript = (take.project / "work" / "transcript.json").read_bytes()
    blob = json.dumps({"commit": pins["engineCommit"], "ffmpeg": pins["ffmpeg"]["sha256"],
                       "state": state, "transcript": hashlib.sha256(transcript).hexdigest(),
                       "media": take.media_hashes(), "song": song_sha}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


def build_references(take: Take, ref_engine: Engine, refs_root: Path, scratch: Path, pins: dict,
                     song_sha: str, ffprobe: str) -> list:
    """The reference final of every state (cached by reference_key), and the preview plan each
    state's moment gives. -> [{"dir", "window", "stills", "moment"}] in session order."""
    words = take.words()
    out = []
    for step in take.session:
        state = take.state(step)
        d = refs_root / reference_key(take, state, pins, song_sha)
        if not (d / "done.json").exists():
            proj = scratch / f"ref-{take.id}"
            copy_project(take.project, proj)
            write_state(proj, state)
            call = ref_engine.run("render", ["--project", proj])
            tmp = d.with_name(d.name + ".part")
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir(parents=True)
            shutil.copy2(call.result["file"], tmp / "export.mp4")
            shutil.copy2(proj / "work" / "captions.json", tmp / "captions.json")
            manifest = json.loads((Path(call.result["versionDir"]) / "render.json").read_text(encoding="utf-8"))
            (tmp / "segments.json").write_text(json.dumps(manifest["segmentsDetail"]), encoding="utf-8")
            (tmp / "done.json").write_text(json.dumps({"seconds": round(call.seconds, 2), "result": call.result}, indent=1),
                                           encoding="utf-8")
            shutil.rmtree(d, ignore_errors=True)
            os.replace(tmp, d)
            shutil.rmtree(proj, ignore_errors=True)
        segs = json.loads((d / "segments.json").read_text(encoding="utf-8"))
        done = json.loads((d / "done.json").read_text(encoding="utf-8"))
        fps = float(state["format"]["fps"])
        t = moment_time(segs, words, step["moment"]["word"])
        out.append({"dir": d, "moment": round(t, 3), "fps": fps,
                    **plan_previews(t, float(done["result"]["duration"]), fps)})
    return out


# --- one timed run ------------------------------------------------------------------------------

def _complete_video(ffprobe: str, path: Path, duration: float, fps: float) -> None:
    """After the clock stops: the file the engine reported must be a whole, playable video."""
    pts = media.video_pts(ffprobe, Path(path))
    if not pts or abs(pts[-1] + 1.0 / fps - duration) > 1.5 / fps:
        raise RuntimeError(f"{path} is incomplete: {len(pts)} frames, last at {pts[-1] if pts else None}s, "
                           f"engine said {duration}s")


def replay(take: Take, cand: Engine, refs: list, scratch: Path, keep_dir, ffprobe: str) -> dict:
    """One cold, timed replay of the take's session. Outputs are hard-linked into keep_dir (when
    given) for checking; otherwise only their hashes are kept."""
    proj = scratch / f"run-{take.id}"
    copy_project(take.project, proj)
    seconds = {k: [] for k in STEPS}
    files = []
    for k, (step, ref) in enumerate(zip(take.session, refs)):
        write_state(proj, take.state(step))
        fps = ref["fps"]
        draft = cand.run("render", ["--project", proj, "--draft"])
        _complete_video(ffprobe, draft.result["file"], draft.result["duration"], fps)
        still = cand.run("frames", ["--project", proj, "--times", ",".join(f"{t:.3f}" for t in ref["stills"])])
        for f in still.result["frames"]:
            media.read_image(Path(f["file"]))          # decodes = complete
        a, b = ref["window"]
        window = cand.run("render", ["--project", proj, "--window", f"{a:.3f}:{b:.3f}"])
        _complete_video(ffprobe, window.result["file"], window.result["duration"], fps)
        for name, call in (("draft", draft), ("still", still), ("window", window)):
            seconds[name].append(round(call.seconds, 3))
        kept = {"draft": Path(draft.result["file"]), "window": Path(window.result["file"]),
                **{f"still{j}": Path(f["file"]) for j, f in enumerate(still.result["frames"])}}
        files.append(_keep(kept, keep_dir / f"{k:02d}" if keep_dir else None))
    final = cand.run("render", ["--project", proj])
    _complete_video(ffprobe, final.result["file"], final.result["duration"], refs[-1]["fps"])
    final_file = _keep({"final": Path(final.result["file"])}, keep_dir)
    shutil.rmtree(proj, ignore_errors=True)
    return {"seconds": seconds, "final": round(final.seconds, 3), "files": files, "finalFile": final_file}


def _keep(paths: dict, dest) -> dict:
    out = {}
    for name, p in paths.items():
        rec = {"sha256": sha256_file(p)}
        if dest is not None:
            target = Path(dest) / (name + p.suffix)
            if target.exists():
                target.unlink()
            if p.suffix == ".png":
                # frames.py lets ffmpeg overwrite a still in place: a hard link would change with it
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, target)
            else:               # renders are replaced by rename (render.py), so a link stays put
                _link_or_copy(p, target)
            rec["file"] = str(target)
        out[name] = rec
    return out


# --- checks and summary -------------------------------------------------------------------------

def check_take(take: Take, refs: list, kept: dict, ffmpeg: str, ffprobe: str, th: dict) -> dict:
    out = []
    for k, (step, ref) in enumerate(zip(take.session, refs)):
        d = ref["dir"]
        export = d / "export.mp4"
        caps = json.loads((d / "captions.json").read_text(encoding="utf-8"))["cues"]
        a = ref["window"][0]
        files = kept["files"][k]
        row = {"draft": checks.check_preview_video(ffmpeg, ffprobe, export, Path(files["draft"]["file"]), caps,
                                                   th["preview"], ref["fps"]),
               "window": checks.check_preview_video(ffmpeg, ffprobe, export, Path(files["window"]["file"]), caps,
                                                    th["preview"], ref["fps"], start=a)}
        row["still"] = [checks.check_still(ffmpeg, ffprobe, export, Path(files[f"still{j}"]["file"]), t, caps,
                                           th["preview"])
                        for j, t in enumerate(ref["stills"])]
        out.append(row)
    last = refs[-1]["dir"]
    final = checks.check_final(ffmpeg, ffprobe, last / "export.mp4", Path(kept["finalFile"]["final"]["file"]),
                               json.loads((last / "captions.json").read_text(encoding="utf-8"))["cues"], th["final"])
    return {"steps": out, "final": final}


def stats(xs: list) -> dict:
    m = statistics.median(xs)
    return {"median": round(m, 3), "min": min(xs), "max": max(xs),
            "spreadPct": round(100.0 * (max(xs) - min(xs)) / m, 1) if m else 0.0, "n": len(xs)}


def session_wait(run: dict) -> float:
    """The goal number for one replay of one take. Per note: the time until the changed moment is
    on screen (today a still exists only after the draft, so draft + still) plus the time until the
    full draft is ready; then the final export. Windows are timed but left out: the app does not
    render them yet."""
    sec = run["seconds"]
    return sum(2 * d + s for d, s in zip(sec["draft"], sec["still"])) + run["final"]
