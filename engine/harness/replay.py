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

from . import checks, media
from .engines import Engine, Refusal, sha256_file

STEPS = ("draft", "still", "window")


def _link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


# What the engine writes (renders, b-roll layers, cover search, transcription audio): never part of
# a take's inputs, so a cold copy leaves them out.
GENERATED = ("versions", "work/render", "work/layers", "work/cover-candidates", "work/audio",
             "work/captions.json")


def project_inputs(project: Path) -> list:
    """Every file of a take's project a render may read, as paths relative to it."""
    out = []
    for f in sorted(project.rglob("*")):
        rel = f.relative_to(project).as_posix()
        if f.is_file() and not any(rel == g or rel.startswith(g + "/") for g in GENERATED):
            out.append(rel)
    return out


def copy_project(src: Path, dst: Path) -> None:
    """A cold copy: the take's inputs only. Media is hard-linked (no extra disk; the engine only
    reads it); everything else is copied, so nothing the engine rewrites can reach the corpus."""
    shutil.rmtree(dst, ignore_errors=True)
    for rel in project_inputs(src):
        if rel.startswith("media/"):
            _link_or_copy(src / rel, dst / rel)
        else:
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / rel, dst / rel)
    (dst / "versions").mkdir(parents=True, exist_ok=True)


def write_state(proj_dir: Path, state: dict) -> None:
    tmp = proj_dir / "project.json.harness.tmp"
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(tmp, proj_dir / "project.json")


def grid(fps: float) -> float:
    """Keep the millisecond grid for integer rates; fractional rates use individual frames."""
    return 1.0 / math.gcd(int(fps), 1000) if float(fps).is_integer() else 1.0 / fps


def moment_time(segments: list, words: dict, word_id: str) -> float:
    """Output second where `word_id` starts, from the reference render's segment list."""
    w = words[word_id]
    for s in segments:
        if s["source"] == w["source"] and s["src_start"] - 1e-6 <= w["s"] < s["src_end"]:
            return s["out_start"] + (w["s"] - s["src_start"])
    raise ValueError(f"moment word {word_id} is not in the cut")


def plan_previews(t: float, duration: float, fps: float) -> dict:
    """The 2 s window around a moment and two stills in it, on the frame grid."""
    stride = round(grid(float(fps)) * fps)

    def frame(seconds: float) -> int:
        return math.floor(max(0.0, seconds) * fps / stride + 1e-9) * stride

    a = frame(t - 1.0)
    b = frame(min(duration, a / fps + 2.0))
    a = frame(max(0.0, b / fps - 2.0))
    stills = sorted({frame(min(t, duration - 0.05)), frame(min(t + 0.5, duration - 0.05))})
    return {"window": [a / fps, b / fps], "stills": [k / fps for k in stills]}


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

    def input_hashes(self) -> dict:
        """sha256 of every project input except project.json (each state replaces it)."""
        return {rel: sha256_file(self.project / rel) for rel in project_inputs(self.project) if rel != "project.json"}


def library_hashes(root: Path) -> dict:
    lib = root / "Library"
    return {f.relative_to(lib).as_posix(): sha256_file(f) for f in sorted(lib.rglob("*")) if f.is_file()} if lib.exists() else {}


def reference_key(state: dict, inputs: dict, library: dict, pins: dict) -> str:
    """Everything the reference final of one state depends on: engine, FFmpeg, the state, every
    project input (media, transcript, face track, assets) and the Library (songs, b-roll)."""
    blob = json.dumps({"commit": pins["engineCommit"], "ffmpeg": pins["ffmpeg"]["sha256"],
                       "state": state, "inputs": inputs, "library": library}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


REF_FILES = ("export.mp4", "captions.json", "segments.json", "done.json")
REF_MANIFEST = "manifest.json"


def write_reference_manifest(d: Path, key: str, pins: dict) -> None:
    """Written last, once every file is in place: what the reference was made from and the sha256
    of each file it holds."""
    (d / REF_MANIFEST).write_text(json.dumps({
        "key": key, "engineCommit": pins["engineCommit"], "ffmpegSha256": pins["ffmpeg"]["sha256"],
        "files": {n: sha256_file(d / n) for n in REF_FILES}}, indent=1), encoding="utf-8")


def reference_ready(d: Path, key: str, pins: dict, require: bool = False) -> bool:
    """True when `d` holds a finished reference for `key`; False when there is none yet (or one from
    before manifests existed, which setup rebuilds). Refuses a reference whose files or origin differ
    from its manifest: a replaced or edited reference would decide every check. `require`: the
    reference must exist (checking time: setup made it, so a missing manifest means tampering)."""
    mf = d / REF_MANIFEST
    if not mf.exists():
        if require:
            raise Refusal(f"reference {d} lost its manifest after setup. Delete it and run setup again.")
        return False
    m = json.loads(mf.read_text(encoding="utf-8"))
    bad = []
    if m.get("key") != key or d.name != key:
        bad.append(f"made for key {m.get('key')}")
    if m.get("engineCommit") != pins["engineCommit"] or m.get("ffmpegSha256") != pins["ffmpeg"]["sha256"]:
        bad.append(f"made by engine {m.get('engineCommit')} / ffmpeg {m.get('ffmpegSha256')}")
    files = m.get("files") or {}
    for n in REF_FILES:
        if not (d / n).is_file():
            bad.append(f"{n} missing")
        elif files.get(n) != sha256_file(d / n):
            bad.append(f"{n} changed")
    if bad:
        raise Refusal(f"reference {d} does not match its manifest ({'; '.join(bad)}). Delete it and run setup again.")
    return True


def build_references(take: Take, ref_engine: Engine, refs_root: Path, scratch: Path, pins: dict,
                     root: Path) -> list:
    """The reference final of every state (cached by reference_key), and the preview plan each
    state's moment gives. -> [{"dir", "window", "stills", "moment"}] in session order."""
    words = take.words()
    inputs, library = take.input_hashes(), library_hashes(root)
    out = []
    for step in take.session:
        state = take.state(step)
        key = reference_key(state, inputs, library, pins)
        d = refs_root / key
        if not reference_ready(d, key, pins):
            proj = scratch / f"ref-{take.id}"
            copy_project(take.project, proj)
            write_state(proj, state)
            call = ref_engine.run("render", ["--project", proj])
            tmp = d.with_name(d.name + ".part")
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir(parents=True)
            shutil.copy2(call.result["file"], tmp / "export.mp4")
            cap_file = proj / "work" / "captions.json"
            if cap_file.exists():
                shutil.copy2(cap_file, tmp / "captions.json")
            elif (state.get("captions") or {}).get("enabled", True):
                raise RuntimeError(f"reference render of {take.id} {step['state']} wrote no captions.json")
            else:                       # captions off: no band, the whole frame is checked loosely
                (tmp / "captions.json").write_text('{"cues": []}', encoding="utf-8")
            manifest = json.loads((Path(call.result["versionDir"]) / "render.json").read_text(encoding="utf-8"))
            (tmp / "segments.json").write_text(json.dumps(manifest["segmentsDetail"]), encoding="utf-8")
            (tmp / "done.json").write_text(json.dumps({"seconds": round(call.seconds, 2), "result": call.result}, indent=1),
                                           encoding="utf-8")
            write_reference_manifest(tmp, key, pins)
            shutil.rmtree(d, ignore_errors=True)
            os.replace(tmp, d)
            shutil.rmtree(proj, ignore_errors=True)
        segs = json.loads((d / "segments.json").read_text(encoding="utf-8"))
        done = json.loads((d / "done.json").read_text(encoding="utf-8"))
        fps = float(state["format"]["fps"])
        t = moment_time(segs, words, step["moment"]["word"])
        out.append({"dir": d, "key": key, "format": state["format"], "moment": round(t, 3), "fps": fps,
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
        window = cand.run("render", ["--project", proj, "--window", f"{a:.6f}:{b:.6f}"])
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

def _merge(results: list) -> dict:
    """One verdict for an output the runs made in several distinct versions: the first failing
    version, else the first one, with how many distinct versions were checked."""
    pick = next((r for r in results if r["status"] == "fail"), results[0])
    return dict(pick, distinctChecked=len(results))


def preview_size(fmt: dict, scale: float) -> tuple:
    """The size a draft or window must have: the output format scaled the way render.py makes
    previews (even dimensions)."""
    return int(round(fmt["width"] * scale / 2)) * 2, int(round(fmt["height"] * scale / 2)) * 2


def still_size(preview: tuple, width: int) -> tuple:
    """frames.py scales the draft with `scale=<width>:-2`: FFmpeg's scale_eval.c sets the height to
    av_rescale(width, h, w * 2) * 2, which rounds to the nearest even number, ties away from zero."""
    num, den = width * preview[1], preview[0] * 2
    return width, (2 * num + den) // (2 * den) * 2


def pair_stills(times: list, names: list) -> list:
    """[(time or None, name or None)]: each requested still time with the still made for it. A
    still nobody asked for, or a time with no still, comes back half empty and fails."""
    order = sorted(names, key=lambda n: int(n[len("still"):]))
    n = max(len(times), len(order))
    return [(times[j] if j < len(times) else None, order[j] if j < len(order) else None) for j in range(n)]


def _missing(what: str) -> dict:
    return {"status": "fail", "failures": [what], "metrics": {}, "distinctChecked": 0}


def check_take(take: Take, refs: list, runs: list, ffmpeg: str, ffprobe: str, th: dict, pins: dict,
               sizes: dict) -> dict:
    """Check every distinct output of every run (outputs are compared by hash, so a deterministic
    engine is checked once per output and a run that rendered something different is not trusted
    on the strength of another run's check)."""
    def distinct(get) -> list:
        seen, out = set(), []
        for run in runs:
            rec = get(run)
            if rec["sha256"] not in seen:
                seen.add(rec["sha256"])
                out.append(Path(rec["file"]))
        return out

    steps = []
    for k, (step, ref) in enumerate(zip(take.session, refs)):
        reference_ready(ref["dir"], ref["key"], pins, require=True)     # unchanged since setup, or refuse
        export = ref["dir"] / "export.mp4"
        caps = json.loads((ref["dir"] / "captions.json").read_text(encoding="utf-8"))["cues"]
        a, b = ref["window"]
        pv = th["preview"]
        want = preview_size(ref["format"], sizes["previewScale"])
        still_want = still_size(want, sizes["stillWidth"])
        names = sorted({n for run in runs for n in run["files"][k] if n.startswith("still")})
        stills = []
        for j, (t, name) in enumerate(pair_stills(ref["stills"], names)):
            if t is None:
                stills.append(_missing(f"{name}: a still nobody asked for"))
            elif name is None or any(name not in run["files"][k] for run in runs):
                stills.append(_missing(f"no still for {t}s in every run"))
            else:
                stills.append(_merge([checks.check_still(ffmpeg, ffprobe, export, f, t, caps, pv, still_want)
                                      for f in distinct(lambda r, name=name: r["files"][k][name])]))
        steps.append({
            "draft": _merge([checks.check_preview_video(ffmpeg, ffprobe, export, f, caps, pv, ref["fps"], want)
                             for f in distinct(lambda r: r["files"][k]["draft"])]),
            "window": _merge([checks.check_preview_video(ffmpeg, ffprobe, export, f, caps, pv, ref["fps"], want,
                                                         start=a, end=b)
                              for f in distinct(lambda r: r["files"][k]["window"])]),
            "still": stills})
    last = refs[-1]["dir"]
    caps = json.loads((last / "captions.json").read_text(encoding="utf-8"))["cues"]
    final = _merge([checks.check_final(ffmpeg, ffprobe, last / "export.mp4", f, caps, th["final"])
                    for f in distinct(lambda r: r["finalFile"]["final"])])
    return {"steps": steps, "final": final}


def prune_duplicates(runs: list) -> None:
    """After checking: keep one file per distinct output, delete later runs' identical copies."""
    seen = set()
    for run in runs:
        recs = [rec for f in run["files"] for rec in f.values()] + list(run["finalFile"].values())
        for rec in recs:
            if rec["sha256"] in seen:
                Path(rec["file"]).unlink(missing_ok=True)
            seen.add(rec["sha256"])


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
