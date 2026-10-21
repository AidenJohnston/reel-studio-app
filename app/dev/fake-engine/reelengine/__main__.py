"""Stand-in for the real `reelengine` so the app can be built and tested before the engine lands.

Dev and tests only; never shipped. It speaks the same JSON-lines protocol (docs/architecture.md section 4) and
really runs ffmpeg, so the app sees real files, real progress and real cancellation. It does NOT
transcribe: the transcript is placeholder words spread over the take.

Extra test hooks (env):
  FAKE_ENGINE_SLOW=<seconds>   sleep this long inside transcribe, in small steps (cancel tests)
  FAKE_ENGINE_FAIL=<command>   that command fails with a friendly error
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

FFMPEG = os.environ.get("REELENGINE_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("REELENGINE_FFPROBE", "ffprobe")
ROOT = Path(os.environ.get("REELENGINE_ROOT", "."))

VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts"}
AUDIO = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}
IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"}


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(stage: str, pct: float, message: str) -> None:
    emit({"event": "progress", "stage": stage, "pct": round(pct, 1), "message": message})


class Fail(Exception):
    def __init__(self, code: str, user: str, dev: str = ""):
        super().__init__(dev or code)
        self.code, self.user, self.dev = code, user, dev


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def probe(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        raise Fail("NOT_FOUND", "I could not find that file. It may have been moved.", path)
    ext = p.suffix.lower()
    if ext in IMAGE:
        return {"path": str(p), "kind": "image", "duration": 0, "hasAudio": False}
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(p)],
            capture_output=True, check=True,
        ).stdout
        info = json.loads(out.decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        return {"path": str(p), "kind": "unknown", "duration": 0, "hasAudio": False, "error": str(e)}
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    dur = float(info.get("format", {}).get("duration") or 0)
    res = {"path": str(p), "duration": dur, "hasAudio": a is not None}
    if v:
        num, _, den = (v.get("avg_frame_rate") or "30/1").partition("/")
        fps = float(num) / float(den or 1) if float(den or 1) else 30.0
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(sd["rotation"])
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        res.update({"width": w, "height": h, "fps": round(fps, 3), "rotation": rot})
        res["kind"] = "talking_head" if a is not None and dur >= 15 else "broll_video"
    elif a:
        res["kind"] = "music"
    else:
        res["kind"] = "unknown"
    return res


def unique(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, ext = dest.stem, dest.suffix
    i = 2
    while (dest.parent / f"{stem} ({i}){ext}").exists():
        i += 1
    return dest.parent / f"{stem} ({i}){ext}"


BINS = {"talking_head": "Raw takes", "broll_video": "B-roll", "music": "Music", "image": "Images"}


def cmd_classify(args: list[str]) -> dict:
    root = Path(take(args, "--root") or ROOT)
    files = [a for a in args if not a.startswith("--")]
    out = []
    for i, f in enumerate(files):
        progress("classify", 100 * i / max(1, len(files)), "Sorting your files")
        ext = Path(f).suffix.lower()
        if ext not in VIDEO | AUDIO | IMAGE:
            out.append({"file": f, "kind": "unknown", "dest": None,
                        "reason": "This is not a video, song or picture, so I left it where it was."})
            continue
        info = probe(f)
        kind = info.get("kind", "unknown")
        if kind not in BINS:
            out.append({"file": f, "kind": kind, "dest": None, "reason": "I could not open this file."})
            continue
        dest = unique(root / "Library" / BINS[kind] / Path(f).name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
        out.append({"file": f, "kind": kind, "dest": str(dest)})
    return {"files": out}


def take(args: list[str], flag: str) -> str | None:
    if flag in args:
        i = args.index(flag)
        val = args[i + 1]
        del args[i:i + 2]
        return val
    return None


def load(proj: Path) -> dict:
    return json.loads((proj / "project.json").read_text("utf-8"))


def save(proj: Path, data: dict) -> None:
    data["updatedAt"] = now()
    tmp = proj / "project.json.tmp"
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    os.replace(tmp, proj / "project.json")


def cmd_init(args: list[str]) -> dict:
    proj = Path(take(args, "--project"))
    title = take(args, "--title") or "My video"
    take(args, "--slug")
    files = [a for a in args if not a.startswith("--")]
    if not files:
        raise Fail("NO_FILES", "Drop a video to get started.")
    (proj / "media").mkdir(parents=True, exist_ok=True)
    (proj / "work").mkdir(exist_ok=True)
    (proj / "versions").mkdir(exist_ok=True)
    sources = []
    for i, f in enumerate(files, 1):
        info = probe(f)
        if info.get("kind") not in ("talking_head", "broll_video"):
            raise Fail("NOT_VIDEO", "That file is not a video I can open. Try an .mp4 or .mov file.", f)
        if not info.get("hasAudio"):
            raise Fail("NO_AUDIO", "This video has no sound. Try a different file.", f)
        progress("init", 100 * (i - 1) / len(files), "Copying your video")
        dest = proj / "media" / f"take{i:02d}{Path(f).suffix.lower()}"
        shutil.copy2(f, dest)
        sources.append({"id": f"s{i}", "path": f"media/{dest.name}", "duration": info["duration"],
                        "fps": info.get("fps", 30), "width": info.get("width"), "height": info.get("height"),
                        "rotation": info.get("rotation", 0)})
    slug = proj.name
    data = {
        "schemaVersion": 1, "id": str(uuid.uuid4()), "title": title, "slug": slug,
        "createdAt": now(), "updatedAt": now(), "version": 0,
        "format": {"width": 1080, "height": 1920, "fps": 30},
        "sources": sources,
        "transcript": {"file": "work/transcript.json", "language": "en"},
        "cut": {"keep": [], "gapCap": 0.25, "minSaving": 0.08},
        "captions": {"enabled": True, "style": {"preset": "bold-lower"}, "corrections": []},
        "music": {"enabled": False, "track": None, "startAt": 0.0, "level": "under-voice", "automation": [], "fadeOut": 1.5},
        "broll": [], "zooms": [],
        "cover": {"atSourceTime": min(2.0, sources[0]["duration"] / 2), "source": "s1", "text": None},
        "post": {"caption": "", "hashtags": [], "keywords": []},
        "notes": [],
    }
    save(proj, data)
    return {"project": str(proj), "sources": sources}


PLACEHOLDER = ("this is placeholder text from the test engine the real engine will write what you "
               "actually said here so you can see your words and the parts I cut out").split()


def cmd_transcribe(args: list[str]) -> dict:
    proj = Path(take(args, "--project"))
    data = load(proj)
    slow = float(os.environ.get("FAKE_ENGINE_SLOW", "0") or 0)
    steps = 20
    for i in range(steps):
        progress("transcribe", 100 * i / steps, "Listening to your video")
        time.sleep(slow / steps if slow else 0.03)
    words = []
    n = 0
    for src in data["sources"]:
        t = 0.3
        while t < min(src["duration"], 60.0) - 0.5:
            w = PLACEHOLDER[n % len(PLACEHOLDER)]
            words.append({"id": f"w{n}", "source": src["id"], "s": round(t, 3), "e": round(t + 0.28, 3), "w": w})
            n += 1
            t += 0.38 if n % 9 else 1.4  # a pause every 9 words
    (proj / "work").mkdir(exist_ok=True)
    (proj / "work" / "transcript.json").write_text(json.dumps({"words": words}, ensure_ascii=False), "utf-8")
    progress("transcribe", 100, "Listening to your video")
    return {"words": len(words)}


def cmd_analyze(args: list[str]) -> dict:
    proj = Path(take(args, "--project"))
    progress("analyze", 50, "Picking your best takes")
    (proj / "work" / "analysis.json").write_text(json.dumps({"pauses": [], "retakes": []}), "utf-8")
    return {"pauses": 0, "retakes": 0}


def cmd_autocut(args: list[str]) -> dict:
    proj = Path(take(args, "--project"))
    data = load(proj)
    words = json.loads((proj / "work" / "transcript.json").read_text("utf-8"))["words"]
    keep, start = [], None
    for i, w in enumerate(words):
        drop = i % 23 in (5, 6)  # pretend these were a false start
        if not drop and start is None:
            start = w["id"]
        if drop and start is not None:
            keep.append({"from": start, "to": words[i - 1]["id"]})
            start = None
    if start is not None and words:
        keep.append({"from": start, "to": words[-1]["id"]})
    data["cut"]["keep"] = keep
    save(proj, data)
    progress("autocut", 100, "Picking your best takes")
    return {"ranges": len(keep)}


def run_ffmpeg(cmd: list[str], total: float, stage: str, message: str, lo: float, hi: float) -> None:
    proc = subprocess.Popen(cmd + ["-progress", "pipe:1", "-nostats"], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    assert proc.stdout
    for line in proc.stdout:
        m = re.match(r"out_time_us=(\d+)", line.strip())
        if m and total > 0:
            pct = min(1.0, int(m.group(1)) / 1e6 / total)
            progress(stage, lo + (hi - lo) * pct, message)
    _, err = proc.communicate()
    if proc.returncode != 0:
        raise Fail("RENDER_FAILED", "I could not finish your video. Please try again.", err[-2000:])


def cmd_render(args: list[str]) -> dict:
    draft = "--draft" in args
    proj = Path(take(args, "--project"))
    data = load(proj)
    if os.environ.get("FAKE_ENGINE_FAIL") == "render":
        raise Fail("RENDER_FAILED", "I could not finish your video. Please try again.")
    # docs/versions.md: drafts overwrite versions/preview/; only a final makes versions/vN/.
    n = int(data.get("version", 0)) + 1
    vdir = proj / "versions" / ("preview" if draft else f"v{n}")
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / ".rendering").write_text("", "utf-8")
    src = data["sources"][0]
    dur = min(float(src["duration"]), 20.0)
    w, h = (540, 960) if draft else (1080, 1920)
    name = "draft.mp4" if draft else "export.mp4"
    tmp = vdir / f"{name}.partial.mp4"
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    run_ffmpeg([FFMPEG, "-y", "-v", "error", "-i", str(proj / src["path"]), "-t", f"{dur:.3f}", "-vf", vf,
                "-c:v", "libx264", "-preset", "ultrafast" if draft else "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(tmp)],
               dur, "render", "Putting it all together", 0, 90)
    os.replace(tmp, vdir / name)
    progress("cover", 92, "Making your cover")
    at = float((data.get("cover") or {}).get("atSourceTime") or 1.0)
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{min(at, dur - 0.1):.3f}", "-i", str(proj / src["path"]),
                    "-frames:v", "1", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
                    str(vdir / "cover.png")], check=False, capture_output=True)
    (vdir / "verify.json").write_text(json.dumps({"ok": True, "duration": dur}), "utf-8")
    (vdir / "project.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    (vdir / ".rendering").unlink()
    if not draft:
        data["version"] = n
        save(proj, data)
    progress("render", 100, "Done")
    return {"version": n, "path": str(vdir / name), "file": str(vdir / name), "draft": draft, "preview": draft,
            "versionDir": str(vdir)}


def cmd_cover_candidates(args: list[str]) -> dict:
    """The real engine scores faces; this one takes the frame at each moment and gives fixed signals that
    vary from frame to frame, so every reason the app can say shows up."""
    proj = Path(take(args, "--project"))
    data = load(proj)
    src = data["sources"][0]
    out_dir = proj / "work" / "cover-candidates"
    out_dir.mkdir(parents=True, exist_ok=True)
    signals = [(1.0, 1.0, 0.8, False), (0.7, 1.0, 1.0, True), (1.0, 0.6, 0.5, True), (0.6, 0.8, 1.0, False),
               (0.8, 0.7, 0.6, False), (1.0, 0.9, 1.0, True)]
    rows = []
    for i, t in enumerate(float(x) for x in (take(args, "--at") or "").split(",") if x.strip()):
        t = min(t, max(0.0, float(src["duration"]) - 0.1))
        f = out_dir / f"cover_{t:08.3f}.jpg"
        subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(proj / src["path"]), "-frames:v", "1",
                        "-vf", "scale=360:640:force_original_aspect_ratio=increase,crop=360:640", str(f)],
                       check=False, capture_output=True)
        eyes, sharp, still, between = signals[i % len(signals)]
        rows.append({"moment": t, "atSourceTime": round(t, 3), "score": round(0.9 - i * 0.05, 4), "eyesOpen": eyes,
                     "sharp": sharp, "still": still, "betweenWords": between, "file": str(f)})
    return {"source": src.get("id", "s1"), "candidates": rows}


def cmd_probe(args: list[str]) -> dict:
    files = [a for a in args if not a.startswith("--")]
    return probe(files[0])


def cmd_download_model(args: list[str]) -> dict:
    name = take(args, "--name") or "small.en"
    dest = Path(os.environ.get("REELENGINE_MODELS", "models")) / name
    for i in range(11):
        progress("download", i * 10, f"Downloading the listening model ({i * 48} of 480 MB)")
        time.sleep(0.05)
    dest.mkdir(parents=True, exist_ok=True)
    for f in ("model.bin", "config.json", "vocabulary.txt", ".fake"):
        (dest / f).write_text("fake", "utf-8")
    return {"model": name, "path": str(dest), "downloaded": True}


def cmd_attach(args: list[str]) -> dict:
    """A small stand-in for the real `attach` (engine/reelengine/attach.py): JPG/PNG pictures only,
    copied with a sidecar and a 320 px still, so the app's note attachments can be driven end to end."""
    proj = Path(take(args, "--project"))
    name = take(args, "--name")
    src = Path([a for a in args if not a.startswith("--")][0])
    name = name or src.name
    ext = Path(name).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg"):
        raise Fail("ATTACH_TYPE", "That file type isn't supported. Use a picture (JPG, PNG, GIF, HEIC) or a short video (MP4, MOV).")
    stem = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", Path(name).stem.lower())).strip("-")[:40] or "file"
    stem = f"attach-{uuid.uuid4().hex[:8]}-{stem}"
    out_ext = ".jpg" if ext == ".jpeg" else ext
    assets, thumbs = proj / "work" / "assets", proj / "work" / "thumbs"
    assets.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)
    out = assets / f"{stem}{out_ext}"
    shutil.copyfile(src, out)
    thumb = thumbs / f"{stem}.jpg"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(out), "-vf", "scale=320:320:force_original_aspect_ratio=decrease",
                    "-frames:v", "1", str(thumb)], check=True, stdin=subprocess.DEVNULL)
    rec = {"asset": f"work/assets/{out.name}", "name": name, "kind": "image", "bytes": out.stat().st_size,
           "width": 0, "height": 0, "thumb": f"work/thumbs/{thumb.name}", "createdAt": now()}
    (assets / f"{out.name}.attach.json").write_text(json.dumps(rec), "utf-8")
    return rec


def cmd_doctor(_args: list[str]) -> dict:
    return {"engine": "fake", "ffmpeg": shutil.which(FFMPEG) or FFMPEG, "ok": True}


COMMANDS = {
    "probe": cmd_probe, "classify": cmd_classify, "init": cmd_init, "transcribe": cmd_transcribe,
    "analyze": cmd_analyze, "autocut": cmd_autocut, "render": cmd_render, "doctor": cmd_doctor,
    "download-model": cmd_download_model, "attach": cmd_attach, "cover-candidates": cmd_cover_candidates,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        emit({"event": "error", "code": "BAD_COMMAND", "message": " ".join(sys.argv[1:]),
              "userMessage": "Reel Studio asked for something I do not know how to do."})
        return 1
    cmd, args = sys.argv[1], sys.argv[2:]
    if os.environ.get("FAKE_ENGINE_FAIL") == cmd:
        emit({"event": "error", "code": "TEST_FAILURE", "message": "forced", "userMessage": "Test failure. Try again."})
        return 1
    try:
        result = COMMANDS[cmd](list(args))
    except Fail as e:
        emit({"event": "error", "code": e.code, "message": e.dev, "userMessage": e.user})
        return 1
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "code": "INTERNAL", "message": repr(e),
              "userMessage": "Something went wrong while working on your video. Please try again."})
        return 1
    emit({"event": "done", "result": result})
    return 0


if __name__ == "__main__":
    sys.exit(main())
