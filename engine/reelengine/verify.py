"""`verify <mp4>`: every mechanical check on a finished video at once (ported from verify_export.py).

These are the defects that have actually shipped before: HDR tags on SDR pixels (colours look
wrong), 10-bit output, a file 4x too quiet, video shorter than audio (lip sync drift), black frames.
WARN never fails: a checker that cries wolf gets ignored. One decode covers loudness and black
frames together.

What no probe can tell you: whether the cards appeared or the pacing works. Look at frames.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from . import tools
from .proto import EngineError, progress

TARGET_LUFS = -14.0
TOLERANCE = 1.5
HDR_TRANSFERS = {"arib-std-b67", "smpte2084", "bt2020-10", "bt2020-12"}
HDR_SPACES = {"bt2020nc", "bt2020c", "bt2020_ncl", "bt2020_cl"}
DEEP_PIX = {"yuv420p10le", "yuv422p10le", "yuv444p10le", "p010le", "yuv420p12le"}
# Instagram's Reels UI covers the bottom ~19% (caption, audio row) and a right-side action column.
IG_BOTTOM_FRAC = 0.19
IG_RIGHT_FRAC = 0.13
IG_TOP_FRAC = 0.07


def ig_right_limit(width: float) -> float:
    """x past which a caption sits under the right-side action column, the like, comment and share icons.
    captions.render_ass fits a centred line inside it, so the layout and this check share one edge."""
    return width * (1 - IG_RIGHT_FRAC)


def _fps(stream) -> float:
    raw = stream.get("r_frame_rate") or "0/1"
    try:
        n, d = raw.split("/")
        return float(n) / float(d) if float(d) else 0.0
    except (ValueError, ZeroDivisionError):
        return 0.0


def _num(text: str, pattern: str):
    hits = re.findall(pattern, text, flags=re.M)
    if not hits:
        return None
    v = hits[-1].strip()
    if v.lstrip("-").startswith("inf"):
        return float("-inf") if v.startswith("-") else float("inf")
    try:
        return float(v)
    except ValueError:
        return None


def analyse_av(path: Path, has_audio: bool, has_video: bool, dur: float) -> dict:
    """One decode: ebur128 loudness + blackdetect."""
    cmd = [tools.ffmpeg(), "-hide_banner", "-nostats", "-nostdin", "-i", str(path)]
    fc, maps = [], []
    if has_video:
        fc.append("[0:v]blackdetect=d=0.25:pic_th=0.98:pix_th=0.10[vo]")
        maps += ["-map", "[vo]"]
    if has_audio:
        fc.append("[0:a]ebur128=peak=true[ao]")
        maps += ["-map", "[ao]"]
    if not fc:
        return {}
    cmd += ["-filter_complex", ";".join(fc), *maps, "-f", "null", "-"]
    proc = tools.text_run(cmd, max(300, dur * 10), "verify decode", check=False)
    log = proc.stderr or ""
    out = {"black": []}
    if proc.returncode != 0:
        # a decode that failed saw nothing: "no black frames" would be a PASS on no evidence
        out["decodeFailed"] = (log.strip().splitlines() or ["ffmpeg exited " + str(proc.returncode)])[-1][:300]
    for m in re.finditer(r"black_start:\s*([0-9.]+)\s+black_end:\s*([0-9.]+)\s+black_duration:\s*([0-9.]+)", log):
        out["black"].append([float(m.group(1)), float(m.group(2))])
    if has_audio and "Summary:" in log:
        summary = log[log.rindex("Summary:"):]
        out["lufs"] = _num(summary, r"^\s*I:\s*(-?[\d.]+|-?inf)\s*LUFS")
        out["lra"] = _num(summary, r"^\s*LRA:\s*(-?[\d.]+|-?inf)\s*LU")
        out["peak"] = _num(summary, r"^\s*Peak:\s*(-?[\d.]+|-?inf)\s*dBFS")
    return out


def caption_report(captions: list, fmt: tuple) -> tuple:
    """(status, detail): is every caption inside the frame and clear of the platform UI?"""
    W, H = fmt
    off, ui = [], []
    for c in captions:
        x, y, w, h = c["box"]
        if x < 0 or y < 0 or x + w > W or y + h > H:
            off.append(c["text"])
        elif y + h > H * (1 - IG_BOTTOM_FRAC) or y < H * IG_TOP_FRAC or x + w > ig_right_limit(W):
            ui.append(c["text"])
    if off:
        return "FAIL", f"{len(off)} caption(s) run off the frame, e.g. {off[0]!r}"
    if ui:
        return "WARN", f"{len(ui)} caption(s) may sit under the app's buttons, e.g. {ui[0]!r}"
    return "PASS", f"{len(captions)} captions inside the safe area"


def check(path: Path, expect_duration: Optional[float] = None, expect_w: int = 1080,
          expect_h: int = 1920, expect_fps: float = 30.0, captions: Optional[list] = None,
          fmt: Optional[tuple] = None, draft: bool = False) -> dict:
    path = Path(path)
    if not path.exists():
        raise EngineError("NOT_FOUND", f"no such file {path}", "I couldn't find that video file.")
    proc = tools.text_run([tools.ffprobe(), "-v", "error", "-print_format", "json", "-show_format",
                           "-show_streams", str(path)], 120, "ffprobe", check=False)
    if proc.returncode != 0:
        raise EngineError("UNREADABLE", f"ffprobe failed: {proc.stderr[-400:]}",
                          "This video file is damaged. Try making it again.")
    d = json.loads(proc.stdout or "{}")
    fmt_ = d.get("format", {})
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)
    checks = []

    def add(status, name, detail):
        checks.append({"status": status, "name": name, "detail": detail})

    if v is None:
        add("FAIL", "video track", "no video stream")
        vdur = float(fmt_.get("duration") or 0)
    else:
        space = (v.get("color_space") or "unset").lower()
        transfer = (v.get("color_transfer") or "unset").lower()
        prim = (v.get("color_primaries") or "unset").lower()
        tags = f"space={space} transfer={transfer} primaries={prim}"
        if transfer in HDR_TRANSFERS or space in HDR_SPACES or prim == "bt2020":
            add("FAIL", "colour", f"{tags}: HDR tag on an SDR video (colours will look wrong)")
        elif space == transfer == prim == "bt709":
            add("PASS", "colour", tags)
        else:
            add("WARN", "colour", f"{tags}: not tagged bt709, players will guess")
        rot = 0
        for sd in v.get("side_data_list") or []:
            if "rotation" in sd:
                try:
                    rot = int(round(float(sd["rotation"])))
                except (TypeError, ValueError):
                    pass
        add("FAIL" if rot % 360 else "PASS", "orientation",
            f"tagged to rotate {rot} degrees: players will turn it sideways" if rot % 360 else "upright")
        pix = (v.get("pix_fmt") or "?").lower()
        add("FAIL" if pix in DEEP_PIX else "PASS", "bit depth", pix)
        w, h = v.get("width"), v.get("height")
        add("PASS" if (w, h) == (expect_w, expect_h) else "FAIL", "size",
            f"{w}x{h} (expected {expect_w}x{expect_h})")
        fps = _fps(v)
        add("PASS" if abs(fps - expect_fps) < 0.01 else "FAIL", "frame rate", f"{fps:g} (expected {expect_fps:g})")
        vdur = float(v.get("duration") or fmt_.get("duration") or 0.0)
        nb = v.get("nb_frames")
        if nb:
            expect_n = round(vdur * fps)
            add("PASS" if abs(int(nb) - expect_n) <= 1 else "FAIL", "frame count",
                f"{nb} frames for {vdur:.3f}s at {fps:g} fps")
    one_frame = 1.0 / (expect_fps or 30.0)
    if expect_duration is not None:
        drift = abs(vdur - expect_duration)
        add("PASS" if drift <= one_frame + 0.02 else "FAIL", "duration",
            f"{vdur:.3f}s vs planned {expect_duration:.3f}s (drift {drift:.3f}s)")
    else:
        add("INFO", "duration", f"{vdur:.3f}s")
    if a is None:
        add("FAIL", "sound track", "no audio stream")
    else:
        adur = float(a.get("duration") or 0.0)
        if adur and vdur:
            skew = abs(vdur - adur)
            add("PASS" if skew <= one_frame + 0.025 else "FAIL", "sound/picture sync",
                f"video {vdur:.3f}s vs audio {adur:.3f}s (skew {skew:.3f}s)")
        else:
            add("WARN", "sound/picture sync", "a stream duration is missing")
    av = analyse_av(path, a is not None, v is not None, vdur)
    if av.get("decodeFailed"):
        add("FAIL", "full decode", f"ffmpeg could not decode the whole file: {av['decodeFailed']}")
    if a is not None:
        lufs = av.get("lufs")
        if lufs is None or lufs == float("-inf"):
            add("FAIL", "loudness", "no loudness reading (silent?)")
        else:
            delta = lufs - TARGET_LUFS
            st = "PASS" if abs(delta) <= TOLERANCE else "FAIL"
            add(st, "loudness", f"{lufs:.1f} LUFS ({delta:+.1f} vs {TARGET_LUFS:.0f}), "
                                f"true peak {av.get('peak')} dBFS, LRA {av.get('lra')}")
    if v is not None and av.get("decodeFailed"):
        add("FAIL", "black frames", "not checked: the decode failed")
    elif v is not None:
        black = [b for b in av.get("black", []) if b[1] - b[0] >= 0.25]
        inner = [b for b in black if b[1] < vdur - 0.5]
        if inner:
            add("FAIL" if any(b[1] - b[0] >= 0.5 for b in inner) else "WARN", "black frames",
                "black at " + ", ".join(f"{b[0]:.2f}-{b[1]:.2f}s" for b in inner[:5]))
        else:
            add("PASS", "black frames", "none" if not black else "only at the very end")
    if captions is not None and fmt:
        st, det = caption_report(captions, fmt)
        add(st, "caption placement", det)
    fails = [c["name"] for c in checks if c["status"] == "FAIL"]
    warns = [c["name"] for c in checks if c["status"] == "WARN"]
    return {"file": str(path), "ok": not fails, "fails": fails, "warns": warns, "checks": checks,
            "duration": round(vdur, 3), "lufs": av.get("lufs"), "draft": draft}


def run(path: Path, expect_duration: Optional[float] = None, project_dir: Optional[Path] = None) -> dict:
    """CLI entry. Expected size/fps/duration come from the sibling render manifest when present."""
    path = Path(path)
    progress("verify", 5, "Checking your video", force=True)
    exp_w, exp_h, exp_fps, caps, fmt, draft = 1080, 1920, 30.0, None, None, False
    man = None
    for cand in (path.parent / "render.json", path.parent / "render_draft.json"):
        if cand.exists():
            try:
                m = json.loads(cand.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if Path(m.get("file", "")).name == path.name:
                man = m
                break
    if man:
        exp_w, exp_h = man["size"]
        draft = bool(man.get("draft"))
        if expect_duration is None:
            expect_duration = man.get("duration")
    snap = path.parent / "project.json"
    if snap.exists():
        try:
            p = json.loads(snap.read_text(encoding="utf-8"))
            exp_fps = float(p["format"]["fps"])
            if not man:
                exp_w, exp_h = int(p["format"]["width"]), int(p["format"]["height"])
            fmt = (int(p["format"]["width"]), int(p["format"]["height"]))
        except (ValueError, KeyError):
            pass
    if project_dir is not None:
        cj = Path(project_dir) / "work" / "captions.json"
        if cj.exists() and fmt:
            caps = json.loads(cj.read_text(encoding="utf-8")).get("cues")
    rep = check(path, expect_duration, exp_w, exp_h, exp_fps, caps, fmt, draft)
    progress("verify", 100, "Checked", force=True)
    return rep
