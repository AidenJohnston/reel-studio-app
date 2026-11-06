"""Stand-in for the real `reelengine` so the app can be built and tested before the engine lands.

Dev and tests only; never shipped. It speaks the same JSON-lines protocol (docs/architecture.md section 4) and
really runs ffmpeg, so the app sees real files, real progress and real cancellation. It does NOT
transcribe: the transcript is placeholder words spread over the take.

Extra test hooks (env):
  FAKE_ENGINE_SLOW=<seconds>   sleep this long inside transcribe, in small steps (cancel tests)
  FAKE_ENGINE_FAIL=<command>   that command fails with a friendly error
  FAKE_ENGINE_DOWNLOAD_STEP=<seconds>  pause per 10% of download-model (default 0.05)
  FAKE_ENGINE_OFFLINE=1        download-model stops at 30% with the real engine's "no internet" error
  FAKE_ENGINE_SPEECH_CHECK=<seconds>   how long speech-check takes (default 1)
  FAKE_ENGINE_SLOW_RENDER=<seconds>   a full-quality render waits this long first, in small steps (Stop tests)
  FAKE_ENGINE_SLOW_COPY=<seconds>   init waits this long after copying a file, before project.json is written: a Stop
                                    then leaves a partial copy, as a real copy of a large video does (Stop tests)
  FAKE_ENGINE_MOMENTS_GAP=<seconds>  `moments` waits this long before each still, the window and the draft (default 0.3)
  FAKE_ENGINE_MOMENTS_GATE=<folder>  instead, `moments` draws its n-th thing (three stills, the window, the draft) only
                                     once <folder>/go-<n> exists, so a test decides when each arrives
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
    res = {"path": str(p), "duration": dur, "hasAudio": a is not None, "sizeBytes": p.stat().st_size,
           "vcodec": v.get("codec_name") if v else None, "acodec": a.get("codec_name") if a else None,
           "pixFmt": v.get("pix_fmt") if v else None}
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


def load(proj: Path, file: str | None = None) -> dict:
    return json.loads((proj / (file or "project.json")).read_text("utf-8"))


def save(proj: Path, data: dict, file: str | None = None) -> None:
    data["updatedAt"] = now()
    target = proj / (file or "project.json")
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    os.replace(tmp, target)


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
        slow = float(os.environ.get("FAKE_ENGINE_SLOW_COPY", "0") or 0)
        for _ in range(int(slow * 10)):
            time.sleep(0.1)
        sources.append({"id": f"s{i}", "path": f"media/{dest.name}", "originalName": Path(f).name, "duration": info["duration"],
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


def write_captions(proj: Path, vdir: Path, data: dict) -> None:
    """captions.json beside the render, as the real engine writes it, with simpler lines: the kept words three to a line
    (one speech run), the one-word fixes applied (a word fixed to nothing keeps its place as ""), then the
    subtitle editor's split and join applied as the engine does (captions.edit_lines)."""
    cap = data.get("captions") or {}
    transcript = proj / "work" / "transcript.json"
    # a project rendered before it was transcribed (tests that render straight after init) has no lines
    if cap.get("enabled") is False or not transcript.exists():
        # no captions: an empty report, as the real engine writes, never an older render's lines
        (vdir / "captions.json").write_text(json.dumps({"cues": []}), "utf-8")
        return
    words = json.loads(transcript.read_text("utf-8"))["words"]
    index = {w["id"]: i for i, w in enumerate(words)}
    fixes = {c["at"]: c["to"] for c in cap.get("corrections") or [] if c.get("at")}
    tokens = [{"w": fixes.get(w["id"], w["w"]), "ids": [w["id"]]}
              for r in (data.get("cut") or {}).get("keep") or [] for w in words[index[r["from"]]:index[r["to"]] + 1]]
    split = set(cap.get("split") or [])
    joins = {(j["from"], j["to"]) for j in cap.get("join") or []}

    def shown(line):
        return [t["ids"][0] for t in line if t["w"]]

    joined: list = []
    for line in (tokens[i:i + 3] for i in range(0, len(tokens), 3)):
        if joined and shown(joined[-1]) and shown(line) and (shown(joined[-1])[-1], shown(line)[0]) in joins:
            joined[-1] += line
        else:
            joined.append(line)
    lines: list = []
    for line in joined:
        lines.append([line[0]])
        for t in line[1:]:
            if t["ids"][0] in split:
                lines.append([])
            lines[-1].append(t)
    cues = [{"run": 0, "ids": [t["ids"][0] for t in line], "tokens": line} for line in lines if shown(line)]
    (vdir / "captions.json").write_text(json.dumps({"cues": cues}), "utf-8")


def cmd_render(args: list[str]) -> dict:
    draft = "--draft" in args
    proj = Path(take(args, "--project"))
    file, out = take(args, "--project-file"), take(args, "--out")
    data = load(proj, file)
    if os.environ.get("FAKE_ENGINE_FAIL") == "render":
        raise Fail("RENDER_FAILED", "I could not finish your video. Please try again.")
    slow = 0.0 if draft else float(os.environ.get("FAKE_ENGINE_SLOW_RENDER", "0") or 0)
    for i in range(int(slow * 10)):
        progress("render", i / slow, "Putting it all together")
        time.sleep(0.1)
    # docs/versions.md: a draft goes to --out (default versions/preview/); only a final makes
    # versions/vN/, starting afresh when an earlier attempt that was never saved left one there
    n = int(data.get("version", 0)) + 1
    vdir = (proj / out if out else proj / "versions" / "preview") if draft else proj / "versions" / f"v{n}"
    if not draft:
        shutil.rmtree(vdir, ignore_errors=True)
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
    # The render's timeline, as the real engine writes it (docs/versions.md). This stand-in plays the
    # source straight through, so it is one segment.
    timeline = {"duration": dur, "segmentsDetail": [{"source": src["id"], "src_start": 0.0, "src_end": dur, "out_start": 0.0}]}
    (vdir / ("render_draft.json" if draft else "render.json")).write_text(json.dumps(timeline), "utf-8")
    (vdir / "project.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    (vdir / ".rendering").unlink()
    write_captions(proj, vdir, data)
    if not draft:
        data["version"] = n
        save(proj, data, file)
    progress("render", 100, "Done")
    return {"version": n, "path": str(vdir / name), "file": str(vdir / name), "draft": draft, "preview": draft,
            "versionDir": str(vdir)}


def cmd_moments(args: list[str]) -> dict:
    """The real `moments` (reelengine/moments.py) works out which seconds an edit changed. This one takes any run as a
    change at fixed moments: three stills cut from the take, the 2 s around the first, then the draft, each announced
    with `ready` as its file is written, in the folder a note's drafts use (--out). They are drawn in grey, so a
    screenshot tells them from the reel."""
    proj = Path(take(args, "--project"))
    file, out = take(args, "--project-file"), take(args, "--out")
    if "--mark" in args:
        return {"base": str(Path(file).parent / "moments-base.json") if file else str(proj / "work" / "moments" / "base.json")}
    data = load(proj, file)
    src = data["sources"][0]
    dur = min(float(src["duration"]), 20.0)
    gap = float(os.environ.get("FAKE_ENGINE_MOMENTS_GAP", "0.3") or 0)
    gate = os.environ.get("FAKE_ENGINE_MOMENTS_GATE")

    def wait(n: int) -> None:
        if not gate:
            time.sleep(gap)
            return
        while not (Path(gate) / f"go-{n}").exists():
            time.sleep(0.05)

    vdir = proj / out if out else proj / "versions" / "preview"
    stills_dir = vdir / "moments"
    stills_dir.mkdir(parents=True, exist_ok=True)
    progress("moments", 1, "Looking at what changed")
    vf = "scale=540:960:force_original_aspect_ratio=increase,crop=540:960,setsar=1,hue=s=0"
    times = [t for t in (0.8, 2.4, 4.0) if t < dur]
    stills = []
    for n, t in enumerate(times):
        wait(n)
        png = stills_dir / f"still_{round(t * 30):06d}.png"
        subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(proj / src["path"]), "-frames:v", "1",
                        "-vf", vf, str(png)], check=True, capture_output=True)
        stills.append({"t": t, "file": str(png)})
        emit({"event": "progress", "stage": "moments", "pct": 100 * (n + 1) / (len(times) + 2), "message": "Here's your change",
              "ready": {"kind": "still", "t": t, "file": str(png)}})
    wait(len(times))
    a, b = max(0.0, times[0] - 1.0), min(dur, max(0.0, times[0] - 1.0) + 2.0)
    win = vdir / f"window_{a:.1f}-{b:.1f}.mp4"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", str(proj / src["path"]),
                    "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", str(win)],
                   check=True, capture_output=True)
    emit({"event": "progress", "stage": "moments", "pct": 100 * (len(times) + 1) / (len(times) + 2), "message": "Here's your change",
          "ready": {"kind": "window", "from": a, "to": b, "file": str(win)}})
    wait(len(times) + 1)
    draft = cmd_render(["--project", str(proj), "--draft", *(["--project-file", file] if file else []), *(["--out", out] if out else [])])
    return {"intervals": [[0.0, dur]], "stills": stills, "window": {"from": a, "to": b, "file": str(win)}, "draft": draft}


def cmd_cover_candidates(args: list[str]) -> dict:
    """The real engine scores faces; this one takes the frame at each moment and gives it fixed reasons
    that vary from frame to frame, so every way the app can word a reason shows up."""
    proj = Path(take(args, "--project"))
    data = load(proj)
    src = data["sources"][0]
    out_dir = proj / "work" / ("cover-picker" if "--picker" in args else "cover-candidates")
    out_dir.mkdir(parents=True, exist_ok=True)
    reasons = [["eyesOpen", "sharp"], ["sharp", "betweenWords"], ["eyesOpen", "betweenWords"], ["still"], [],
               ["eyesOpen", "betweenWords", "still"]]
    rows = []
    for i, t in enumerate(float(x) for x in (take(args, "--at") or "").split(",") if x.strip()):
        t = min(t, max(0.0, float(src["duration"]) - 0.1))
        f = out_dir / f"cover_{t:08.3f}.jpg"
        subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(proj / src["path"]), "-frames:v", "1",
                        "-vf", "scale=360:640:force_original_aspect_ratio=increase,crop=360:640", str(f)],
                       check=False, capture_output=True)
        rows.append({"moment": t, "atSourceTime": round(t, 3), "score": round(0.9 - i * 0.05, 4),
                     "reasons": reasons[i % len(reasons)], "file": str(f)})
    return {"source": src.get("id", "s1"), "candidates": rows}


def cmd_probe(args: list[str]) -> dict:
    files = [a for a in args if not a.startswith("--")]
    return probe(files[0])


def cmd_export_probe(args: list[str]) -> dict:
    info = cmd_probe(args)
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=bit_rate", "-of", "csv=p=0", args[0]],
                         capture_output=True, text=True).stdout.strip()
    # The real engine reads the edit list from the file; assume one, so Instagram and Threads remux.
    return {**info, "hasVideo": info.get("width") is not None, "vduration": info["duration"], "audioBitrate": int(out) if out.isdigit() else None, "editList": True}


def cmd_export_media(args: list[str]) -> dict:
    dest = take(args, "--dest")
    bitrate = take(args, "--bitrate")
    brightness = take(args, "--brightness")
    look = ["-vf", f"eq=brightness={brightness}"] if brightness else []
    video = [*look, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", bitrate, "-pix_fmt", "yuv420p"] if bitrate else ["-c:v", "copy"]
    # FAKE_ENGINE_SLOW_EXPORT=<seconds>: a platform file takes that long, so Stop can land while it is written.
    slow = float(os.environ.get("FAKE_ENGINE_SLOW_EXPORT", "0") or 0)
    for i in range(20 if slow else 0):
        progress("export", 5 * i, "Saving platform files")
        time.sleep(slow / 20)
    run_ffmpeg([FFMPEG, "-y", "-v", "error", "-i", args[0], *video, "-c:a", "aac", "-b:a", "128k", "-use_editlist", "0", dest],
               float(probe(args[0])["duration"]), "export", "Saving platform files", 0, 100)
    return {"video": dest, "sizeBytes": Path(dest).stat().st_size}


def cmd_export_cover(args: list[str]) -> dict:
    dest = take(args, "--dest")
    at = take(args, "--at")
    brightness = take(args, "--brightness")
    look = ["-vf", f"eq=brightness={brightness}"] if brightness else []
    subprocess.run([FFMPEG, "-y", "-v", "error", *(["-ss", at] if at else []), "-i", args[0], "-frames:v", "1", *look, "-q:v", "2", dest],
                   check=True, capture_output=True)
    return {"cover": dest}


def cmd_download_model(args: list[str]) -> dict:
    name = take(args, "--name") or "small.en"
    dest = Path(os.environ.get("REELENGINE_MODELS", "models")) / name
    for i in range(11):
        if i == 3 and os.environ.get("FAKE_ENGINE_OFFLINE") == "1":
            raise Fail("OFFLINE", "The download stopped. Check your internet connection and try again; it will "
                                  "pick up where it left off.", "fake offline")
        progress("download", i * 10, f"Downloading the listening model ({i * 48} of 480 MB)")
        time.sleep(float(os.environ.get("FAKE_ENGINE_DOWNLOAD_STEP", "0.05")))
    dest.mkdir(parents=True, exist_ok=True)
    for f in ("model.bin", "config.json", "vocabulary.txt", ".fake"):
        (dest / f).write_text("fake", "utf-8")
    return {"model": name, "path": str(dest), "downloaded": True}


def cmd_speech_check(_args: list[str]) -> dict:
    steps = 10
    for i in range(steps):
        progress("speech-check", i * 100 / steps, "Getting the listening model ready for this computer")
        time.sleep(float(os.environ.get("FAKE_ENGINE_SPEECH_CHECK", "1")) / steps)
    return {"threads": 4, "default": 8, "device": "cpu",
            "runs": [{"threads": 8, "seconds": 2.5, "sameWords": True}, {"threads": 4, "seconds": 1.4, "sameWords": True}]}


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


def _fcpx_secs(v: str | None) -> float:
    """FCPXML time: "1001/30000s", "12s" or "0s"."""
    v = (v or "0s").rstrip("s")
    if "/" in v:
        a, b = v.split("/")
        return float(a) / float(b)
    return float(v or 0)


def _item(kind: str, name: str, start: float, dur: float, media: dict) -> dict:
    return {"type": kind, "name": name, "media": media,
            "trackRange": {"start": {"value": start * 100, "rate": 100}, "duration": {"value": dur * 100, "rate": 100}}}


def _fcpx_projects(root) -> list:
    """The projects the real engine reads (reference_import._Fcpx.projects): the first event's in a library, the
    first top-level event's, or the first top-level project."""
    if root.find("library") is not None:
        event = root.find("library/event")
        return [] if event is None else event.findall("project")
    if root.find("event") is not None:
        return root.find("event").findall("project")
    return root.findall("project")[:1]


def cmd_import_reference(args: list[str]) -> dict:
    """The real command's record shape (reelengine/reference_import.py) for simple exports, without OpenTimelineIO:
    Final Cut's spine and connected clips, Premiere's tracks of clip, generator and transition items."""
    import xml.etree.ElementTree as ET
    path = Path(args[0])
    try:
        root = ET.parse(path / "Info.fcpxml" if path.is_dir() else path).getroot()
    except (OSError, ET.ParseError) as e:
        raise Fail("BAD_XML", "This file isn't a readable edit export. Export it again from your editor and try once more.", repr(e))
    timelines = []
    if root.tag == "fcpxml":
        adapter = "fcpx_xml"
        assets = {a.get("id"): a for a in root.iter("asset")}
        for project in _fcpx_projects(root):
            lanes: dict[str, list] = {}
            spine = project.find("./sequence/spine")
            for clip in list(spine if spine is not None else []):
                at, dur = _fcpx_secs(clip.get("offset")), _fcpx_secs(clip.get("duration"))
                if clip.tag == "transition":
                    lanes.setdefault("0", []).append({"type": "transition", "name": clip.get("name")})
                    continue
                src = assets.get(clip.get("ref"), clip).find("media-rep")
                media = ({"kind": "generator", "generator": "Text", "name": clip.get("name")} if clip.tag == "title"
                         else {"kind": "file", "url": src.get("src") if src is not None else None, "name": clip.get("name")})
                lanes.setdefault("0", []).append(_item("clip", clip.get("name"), at, dur, media))
                start = _fcpx_secs(clip.get("start"))
                for child in clip:
                    if child.get("lane") is None:
                        continue
                    cat = at + _fcpx_secs(child.get("offset")) - start
                    csrc = assets.get(child.get("ref"), child).find("media-rep")
                    cmedia = ({"kind": "generator", "generator": "Text", "name": child.get("name")} if child.tag == "title"
                              else {"kind": "file", "url": csrc.get("src") if csrc is not None else None, "name": child.get("name")})
                    lanes.setdefault(child.get("lane"), []).append(_item("clip", child.get("name"), cat, _fcpx_secs(child.get("duration")), cmedia))
            tracks = [{"name": k, "kind": "Audio" if int(k) < 0 else "Video", "items": v} for k, v in sorted(lanes.items(), key=lambda kv: int(kv[0]))]
            timelines.append({"name": project.get("name"), "tracks": tracks})
    elif root.tag == "xmeml":
        adapter = "fcp_xml"
        for seq in root.iter("sequence"):
            if seq.find("media") is None:
                continue
            rate = float(seq.findtext("./rate/timebase") or 25)
            urls = {f.get("id"): f.findtext("pathurl") for f in seq.iter("file") if f.findtext("pathurl")}
            tracks = []
            for kind in ("video", "audio"):
                for track in seq.findall(f"./media/{kind}/track"):
                    items = []
                    cursor = 0.0
                    for it in track:
                        if it.tag == "transitionitem":
                            items.append({"type": "transition", "name": it.findtext("./effect/name")})
                        elif it.tag in ("clipitem", "generatoritem"):
                            a, b = float(it.findtext("start") or 0), float(it.findtext("end") or 0)
                            length = float(it.findtext("out") or 0) - float(it.findtext("in") or 0)
                            a = cursor if a < 0 else a
                            b = a + length if b < 0 else b
                            cursor = b
                            f = it.find("file")
                            media = ({"kind": "generator", "generator": it.findtext("./effect/name"), "name": it.findtext("name")}
                                     if it.tag == "generatoritem" else {"kind": "file", "url": urls.get(f.get("id")) if f is not None else None, "name": it.findtext("name")})
                            items.append(_item("clip", it.findtext("name"), a / rate, max(0.0, b - a) / rate, media))
                    tracks.append({"name": str(len(tracks)), "kind": kind.capitalize(), "items": items})
            timelines.append({"name": seq.findtext("name"), "tracks": tracks})
            break
    else:
        raise Fail("BAD_INPUT", "Choose a Final Cut Pro (.fcpxml or .fcpxmld) or Premiere (.xml) export.")
    if not timelines:
        raise Fail("NO_TIMELINE", "This export has no timeline in it. In your editor, export the project or sequence itself, not just its clips, and try again.")
    return {"source": {"path": str(path), "adapter": adapter}, "mediaRefs": [], "timelines": timelines, "losses": [], "rawMetadata": []}


def cmd_reference_scan(args: list[str]) -> dict:
    """The real command's shape (reference_import.scan): each export's timeline count, or why it can't be read."""
    import xml.etree.ElementTree as ET
    files = []
    for arg in args:
        path = Path(arg)
        try:
            root = ET.parse(path / "Info.fcpxml" if path.is_dir() else path).getroot()
        except (OSError, ET.ParseError):
            files.append({"path": arg, "error": {"code": "BAD_XML", "message": "This file isn't a readable edit export. "
                                                 "Export it again from your editor and try once more."}})
            continue
        if root.tag == "fcpxml":
            n = len(_fcpx_projects(root))
        else:
            # the real engine keeps the first sequence seen with each id (reference_import.count_timelines)
            ids = [seq.get("id") for seq in root.findall("sequence") + root.findall(".//children/sequence")]
            n = sum(1 for i, key in enumerate(ids) if key is None or key not in ids[:i])
        files.append({"path": arg, "timelines": n} if n else {"path": arg, "error": {"code": "NO_TIMELINE", "message":
                      "This export has no timeline in it. In your editor, export the project or sequence itself, not just its clips, and try again."}})
    return {"files": files}


def cmd_score(args: list[str]) -> dict:
    """The real engine reads a version's reports (reelengine/score.py). This stand-in plays the source straight through
    and never normalizes its sound, so it says the file plays and the loudness is off target."""
    # take() consumes each flag, so each is read once
    project, version = take(args, "--project"), int(take(args, "--version"))
    vdir = Path(project) / "versions" / f"v{version}"
    if not (vdir / "project.json").exists():
        raise Fail("NOT_FOUND", "That version isn't saved any more.")
    cues = json.loads((vdir / "captions.json").read_text("utf-8")).get("cues", []) if (vdir / "captions.json").exists() else []
    checks = [{"id": "subtitleSafeZone", "ok": True, "count": 0, "subtitles": len(cues)},
              {"id": "loudness", "ok": False, "lufs": -19.6, "target": -14.0},
              {"id": "videoFile", "ok": True, "count": 0, "failed": []}]
    return {"version": version, "checks": checks, "passed": 2, "measured": 3}


def cmd_measure_reel(args: list[str]) -> dict:
    """The real engine listens and finds the cuts (reelengine/measure.py); the stand-in makes up steady numbers from
    the length, so two reels of different lengths read differently. Its poster is a real frame."""
    src = take(args, "--file")
    poster = take(args, "--poster")
    info = probe(src)
    duration = float(info.get("duration") or 0)
    if duration <= 0:
        raise Fail("NOT_VIDEO", "That file isn't a video Reel Studio can read.", src)
    count = max(1, round(duration / 2.2))
    out = {"version": 1, "duration": round(duration, 2), "width": info.get("width") or 0, "height": info.get("height") or 0,
           "hasAudio": bool(info.get("hasAudio")), "speechMissing": None,
           "speech": {"words": round(duration * 2.8), "wordsPerSecond": 2.8, "firstWordAt": 0.2, "talkingSeconds": round(duration - 0.4, 2),
                      "pausesPerMinute": 2.0, "hook": {"seconds": 2.1, "words": 6, "text": "Nobody tells you this about bread."}},
           "shots": {"count": count, "medianSeconds": round(duration / count, 2), "perMinute": round((count - 1) * 60 / duration, 1),
                     "cutsFirst5": min(count - 1, 2)}}
    if poster:
        Path(poster).parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", "0.5", "-i", src, "-frames:v", "1", "-vf", "scale=240:-2", poster],
                           capture_output=True)
        out["poster"] = poster if r.returncode == 0 and Path(poster).exists() else None
    return out


def cmd_proxy(_args: list[str]) -> dict:
    """The real engine makes preview copies of 4K/HDR takes; the fake one's takes are small."""
    return {"sources": {}}


def cmd_doctor(_args: list[str]) -> dict:
    return {"engine": "fake", "ffmpeg": shutil.which(FFMPEG) or FFMPEG, "ok": True}


COMMANDS = {
    "probe": cmd_probe, "classify": cmd_classify, "init": cmd_init, "transcribe": cmd_transcribe,
    "analyze": cmd_analyze, "autocut": cmd_autocut, "render": cmd_render, "doctor": cmd_doctor,
    "download-model": cmd_download_model, "speech-check": cmd_speech_check, "attach": cmd_attach, "proxy": cmd_proxy,
    "cover-candidates": cmd_cover_candidates, "export-cover": cmd_export_cover, "export-probe": cmd_export_probe,
    "export-media": cmd_export_media, "import-reference": cmd_import_reference,
    "reference-scan": cmd_reference_scan, "moments": cmd_moments, "score": cmd_score, "measure-reel": cmd_measure_reel,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        emit({"event": "error", "code": "BAD_COMMAND", "message": " ".join(sys.argv[1:]),
              "userMessage": "Reel Studio asked for something I do not know how to do."})
        return 1
    cmd, args = sys.argv[1], sys.argv[2:]
    take(args, "--owner")       # the real engine checks it (reelengine/owner.py); the stand-in has no lock
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
