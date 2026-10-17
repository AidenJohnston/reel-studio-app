"""Checks one exported reel for the end-to-end run (dev tool, not shipped).

    python check_export.py --project <project dir> --export <Library/Exports/x.mp4> --out <dir>

1. `python -m reelengine verify` on the exported file.
2. Frames at a spread of times (plus the middle of the first b-roll layers) -> PNGs + one contact
   sheet, so a person (or an agent) can look at captions, b-roll placement and the face.
3. Music presence: the export's level where the cut voice (work/render/voice.wav) is silent, i.e.
   the music-only moments between words, vs. the level while talking. Also the first 3 s.
Prints one JSON object.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

FFMPEG = os.environ.get("REELENGINE_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("REELENGINE_FFPROBE", "ffprobe")
SR = 16000
WIN = 0.05  # seconds


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, **kw)


def duration(f: Path) -> float:
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(f)])
    return float(json.loads(r.stdout)["format"]["duration"])


def pcm(f: Path) -> np.ndarray:
    r = run([FFMPEG, "-v", "error", "-i", str(f), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"])
    return np.frombuffer(r.stdout, dtype=np.float32)


def db_windows(x: np.ndarray) -> np.ndarray:
    n = int(SR * WIN)
    k = len(x) // n
    if k == 0:
        return np.array([-120.0])
    w = x[: k * n].reshape(k, n)
    rms = np.sqrt(np.mean(w.astype(np.float64) ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-6))


def verify(project: Path, export: Path) -> dict:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = run([sys.executable, "-m", "reelengine", "verify", "--project", str(project), str(export)], env=env)
    result = None
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("event") in ("done", "error"):
            result = ev
    return {"exit": r.returncode, "event": result}


def layer_times(project: Path) -> list[float]:
    f = project / "work" / "layers" / "layers.json"
    try:
        items = json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return []
    items = items.get("items", items.get("layers", [])) if isinstance(items, dict) else items
    out = []
    for it in items if isinstance(items, list) else []:
        t0, t1 = it.get("t0"), it.get("t1")
        if isinstance(t0, (int, float)) and isinstance(t1, (int, float)):
            out.append(round((t0 + t1) / 2, 2))
    return sorted(set(out))


def frames(export: Path, times: list[float], out: Path) -> list[str]:
    paths = []
    for t in times:
        p = out / f"frame_{t:07.2f}.png"
        run([FFMPEG, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(export), "-frames:v", "1", str(p)])
        if p.exists():
            paths.append(str(p))
    return paths


def sheet(paths: list[str], out: Path, cols: int = 4) -> str:
    tw, th = 405, 720
    rows = (len(paths) + cols - 1) // cols
    img = Image.new("RGB", (cols * tw, rows * (th + 30)), "white")
    d = ImageDraw.Draw(img)
    for i, p in enumerate(paths):
        im = Image.open(p).convert("RGB").resize((tw, th))
        x, y = (i % cols) * tw, (i // cols) * (th + 30)
        img.paste(im, (x, y + 30))
        d.text((x + 8, y + 8), "cover" if p.endswith("cover.png") else Path(p).stem.replace("frame_", "t="), fill="black")
    f = out / "sheet.png"
    img.save(f)
    return str(f)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--export", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)

    res: dict = {"export": str(a.export)}
    res["verify"] = verify(a.project, a.export)
    dur = duration(a.export)
    res["duration"] = dur

    spread = [1.0] + [round(dur * f, 2) for f in (0.25, 0.5, 0.75)] + [round(dur - 1.0, 2)]
    lt = layer_times(a.project)[:3]
    res["layerTimes"] = lt
    times = sorted(set(t for t in spread + lt if 0 <= t < dur))
    fp = frames(a.export, times, a.out)
    res["frames"] = fp
    cover = a.export.with_name(a.export.stem + " cover.png")   # written by Export next to the video
    if cover.exists():
        fp.append(str(cover))
        res["cover"] = str(cover)
    res["sheet"] = sheet(fp, a.out) if fp else None

    voice_wav = a.project / "work" / "render" / "voice.wav"
    mix = pcm(a.export)
    m = db_windows(mix)
    music: dict = {"mixMedianDb": round(float(np.median(m)), 1), "first3sDb": round(float(np.median(m[: int(3 / WIN)])), 1)}
    if voice_wav.exists():
        v = db_windows(pcm(voice_wav))
        n = min(len(v), len(m))
        v, mm = v[:n], m[:n]
        quiet = v < -50
        talk = v > (np.median(v) - 6)
        music["voiceSilentWindows"] = int(quiet.sum())
        if quiet.sum():
            music["musicOnlyMedianDb"] = round(float(np.median(mm[quiet])), 1)
        if talk.sum():
            music["talkingMedianDb"] = round(float(np.median(mm[talk])), 1)
        if quiet.sum() and talk.sum():
            music["voiceOverMusicDb"] = round(music["talkingMedianDb"] - music["musicOnlyMedianDb"], 1)
        music["present"] = bool(quiet.sum() and music["musicOnlyMedianDb"] > -55)
    mixjson = a.project / "work" / "audio" / "mix.json"
    if mixjson.exists():
        try:
            mj = json.loads(mixjson.read_text("utf-8"))
            music["mixReport"] = {k: mj[k] for k in list(mj)[:12] if not isinstance(mj[k], (list, dict))}
        except ValueError:
            pass
    res["music"] = music
    print(json.dumps(res))


if __name__ == "__main__":
    main()
