"""`render [--draft] [--window a:b]`: project.json -> versions/vN/{export.mp4, cover.png, verify.json}
for a final render; drafts and window previews overwrite versions/preview/ (docs/versions.md).

Order of operations (docs/architecture.md section 5): cut video (+ zooms) -> overlay layers by z -> captions burned
last -> mux the audio. The audio is built FIRST, as its own file: the cut voice (sample-exact
atrim/concat of the same segments the picture uses), then A2's music mix (or plain loudness
normalisation to -14 LUFS when no music module is installed). The video pass maps that file.

Segment boundaries are on the source frame grid (cut.py), so each segment's picture and sound are
the same length and the concat cannot drift. Every ffmpeg input is bounded.

Inputs are opened in LANES: each lane is one ffmpeg input of a source whose segments run forward in
source time. A cut in source order is one lane per source. A reordered cut (hook recorded last,
placed first) gets an extra lane, opened with an input seek, so ffmpeg never has to buffer minutes
of decoded frames waiting for a later segment.
"""
from __future__ import annotations

import importlib
import json
import math
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from . import captions as capmod, cut as cutmod, project as projmod, safepath, tools
from .proto import EngineError, log, progress
from .render_ctx import Layer, RenderCtx, Segment, ZoomSpan

STAGE = "render"
TARGET_LUFS = -14.0
TRUE_PEAK = -1.5
LRA = 11
LIMIT = 0.97
DRAFT_SCALE = 0.5
SEEK_PREROLL = 3.0


BROLL_FAILED = "Some b-roll couldn't be added to this version. Try again, or pick a different picture."
ZOOMS_FAILED = "The zoom-ins couldn't be added to this version."


def _opt_module(name: str):
    """A2's modules are optional at render time: missing = that feature is skipped."""
    try:
        return importlib.import_module(f".{name}", __package__)
    except ImportError as exc:
        log(f"# {name} not available ({exc}); rendering without it")
        return None


# --- versions -----------------------------------------------------------------------------------

def asset_fingerprint(project_dir: Path, proj: dict, root: Optional[Path] = None) -> dict:
    """{path: [size, mtime_ns]} of every file the edit reads. project.json alone cannot tell that a
    song or picture was REPLACED under the same name."""
    refs = [s.get("path") for s in proj.get("sources") or []]
    refs.append(((proj.get("music") or {}).get("track")))
    for b in proj.get("broll") or []:
        refs.append(b.get("asset"))
        refs += [x for x in ((b.get("params") or {}).get("items") or []) if isinstance(x, str)]
    out = {}
    for r in refs:
        if not isinstance(r, str) or not r:
            continue
        try:
            st = safepath.safe_resolve(project_dir, r, root=root).stat()
            out[r] = [st.st_size, st.st_mtime_ns]
        except (EngineError, OSError):
            out[r] = None
    return out


def pick_version(project_dir: Path, proj: dict, root: Optional[Path] = None) -> int:
    """Re-use the current version folder when the edit AND the files it reads have not changed since
    it was rendered; otherwise start the next version, so an export the user may already have
    posted is never replaced by a different video under the same number."""
    cur = int(proj.get("version") or 0)
    if cur > 0:
        vdir = Path(project_dir) / "versions" / f"v{cur}"
        snap = vdir / "project.json"
        if snap.exists():
            try:
                same = projmod.edit_signature(projmod.read_json(snap)) == projmod.edit_signature(proj)
                fp = vdir / "assets.json"
                if same and fp.exists():
                    same = projmod.read_json(fp) == asset_fingerprint(project_dir, proj, root)
                if same:
                    return cur
            except (ValueError, OSError):
                pass
    return cur + 1


PREVIEW_DIR = "preview"


def preview_dir(project_dir: Path) -> Path:
    """versions/preview/: the ONE scratch folder every draft and window preview overwrites.
    Only a final render makes a user-visible version folder (docs/versions.md)."""
    return Path(project_dir) / "versions" / PREVIEW_DIR


def latest_render(project_dir: Path, proj: dict) -> Optional[Path]:
    """The video the project shows: its current version, or the preview while it has none. A folder
    above `version` is an unfinished attempt and a newer file there is not the edit (docs/versions.md)."""
    v = int(proj.get("version") or 0)
    f = Path(project_dir) / "versions" / f"v{v}" / "export.mp4" if v else preview_dir(project_dir) / "draft.mp4"
    return f if f.exists() else None


# --- geometry -----------------------------------------------------------------------------------

def face_center(project_dir: Path, sid: str, disp_w: int, disp_h: int) -> Optional[tuple]:
    """Median face centre (source display px) from analyze's face track, if there is one."""
    work = Path(project_dir) / "work"
    for cand in (work / f"face-{sid}.json", work / "face.json"):
        if not cand.exists():
            continue
        try:
            data = projmod.read_json(cand)
        except (ValueError, OSError):
            continue
        if isinstance(data.get("sources"), dict):
            data = data["sources"].get(sid) or {}
        med = data.get("median")
        if isinstance(med, dict):
            med = [med.get("x"), med.get("y"), med.get("w"), med.get("h")]
        if med and all(v is not None for v in med):
            sx = disp_w / float(data.get("width") or disp_w)
            sy = disp_h / float(data.get("height") or disp_h)
            return ((med[0] + med[2] / 2) * sx, (med[1] + med[3] / 2) * sy)
    return None


def source_faces(project_dir: Path, proj: dict) -> dict:
    faces = {}
    for s in proj["sources"]:
        w, h = int(s.get("width") or 0), int(s.get("height") or 0)
        if int(s.get("rotation") or 0) % 180 == 90:
            w, h = h, w
        c = face_center(project_dir, s["id"], w, h)
        if c:
            faces[s["id"]] = c
    return faces


def reframe_plan(src: dict, out_w: int, out_h: int, face: Optional[tuple]) -> dict:
    """Where to crop the source so it fills out_w x out_h, centred on the face when known.
    The crop rect is in STORED (unrotated) pixels; `rot` is the clockwise turn applied last."""
    rw, rh = int(src.get("width") or out_w), int(src.get("height") or out_h)
    rot = int(src.get("rotation") or 0) % 360
    w, h = (rh, rw) if rot in (90, 270) else (rw, rh)          # display size
    target = out_w / out_h
    if w / h > target + 1e-3:          # too wide: crop the sides
        cw, ch = int(round(h * target)) // 2 * 2, h // 2 * 2
        cx = face[0] if face else w / 2
        x = int(min(max(0, cx - cw / 2), w - cw))
        y = 0
    elif w / h < target - 1e-3:        # too tall: crop top/bottom, keep the face high
        cw, ch = w // 2 * 2, int(round(w / target)) // 2 * 2
        cy = face[1] if face else h * 0.45
        y = int(min(max(0, cy - ch * 0.42), h - ch))
        x = 0
    else:
        cw, ch, x, y = w // 2 * 2, h // 2 * 2, 0, 0
    if rot == 90:
        rx, ry, rcw, rch = y, rh - x - cw, ch, cw
    elif rot == 270:
        rx, ry, rcw, rch = rw - y - ch, x, ch, cw
    elif rot == 180:
        rx, ry, rcw, rch = rw - x - cw, rh - y - ch, cw, ch
    else:
        rx, ry, rcw, rch = x, y, cw, ch
    rx, ry = max(0, min(rx, rw - rcw)), max(0, min(ry, rh - rch))
    sw, sh = (out_h, out_w) if rot in (90, 270) else (out_w, out_h)
    return {"rw": rw, "rh": rh, "rot": rot, "rx": rx, "ry": ry, "rcw": rcw, "rch": rch, "sw": sw, "sh": sh}


def no_rotate_args(src: dict) -> list:
    """We turn the picture ourselves, so ffmpeg must neither auto-rotate it (a full-size transpose on
    every use of the input) nor copy the source's rotation tag into the output (players would turn
    it a second time)."""
    args = ["-noautorotate"]
    if int(src.get("rotation") or 0) % 360:
        args = ["-display_rotation", "0"] + args
    return args


def _turn(rot: int) -> list:
    return {90: ["transpose=clock"], 270: ["transpose=cclock"], 180: ["hflip,vflip"]}.get(rot, [])


def is_mirrored(src: Optional[dict]) -> bool:
    """`sources[].mirror`: the take came out mirrored (a front-camera selfie: wall text, shirts and
    signs read backwards), so the picture is flipped left to right. Absent or false = as shot."""
    return bool(src) and src.get("mirror") is True


def _mirror(src: Optional[dict]) -> list:
    """The flip, LAST in the face-picture chain: after crop, scale and the upright turn, the output
    is the mirror image of the same window (the crop is decided on the unflipped source, around the
    face, exactly as without the flip). Everything drawn later (b-roll, zooms, captions) is not
    flipped; readers of the face box in OUTPUT pixels mirror x (compose_util.map_box_rect)."""
    return ["hflip"] if is_mirrored(src) else []


def reframe_filter(src: dict, out_w: int, out_h: int, face: Optional[tuple], draft: bool) -> str:
    """Software path: crop (fewest pixels first), scale, then turn upright. Inputs are opened with
    -noautorotate: ffmpeg would otherwise insert a full-resolution transpose on EVERY use of the
    input (one per segment), so rotation is done here, last, on the already-small frame. A mirrored
    take is flipped after that (`_mirror`)."""
    pl = reframe_plan(src, out_w, out_h, face)
    chain = []
    if (pl["rcw"], pl["rch"]) != (pl["rw"], pl["rh"]):
        chain.append(f"crop={pl['rcw']}:{pl['rch']}:{pl['rx']}:{pl['ry']}")
    chain.append(f"scale={pl['sw']}:{pl['sh']}:flags={'fast_bilinear' if draft else 'lanczos'}")
    return ",".join(chain + _turn(pl["rot"]) + _mirror(src))


def gpu_reframe(src: dict, out_w: int, out_h: int, face: Optional[tuple]) -> tuple:
    """CUDA draft path: (lane pre-chain run once per decoded frame ON THE GPU, per-segment chain on
    the small downloaded frame). Downloading full-size frames costs more than decoding them."""
    pl = reframe_plan(src, out_w, out_h, face)
    k = pl["sw"] / float(pl["rcw"])
    fw = max(pl["sw"], int(round(pl["rw"] * k / 2)) * 2)
    fh = max(pl["sh"], int(round(pl["rh"] * k / 2)) * 2)
    pre = f"scale_cuda={fw}:{fh},hwdownload,format=nv12"
    cx = int(min(max(0, round(pl["rx"] * k)), fw - pl["sw"]))
    cy = int(min(max(0, round(pl["ry"] * k)), fh - pl["sh"]))
    seg = []
    if (fw, fh) != (pl["sw"], pl["sh"]):
        seg.append(f"crop={pl['sw']}:{pl['sh']}:{cx}:{cy}")
    return pre, ",".join(seg + _turn(pl["rot"]) + _mirror(src) + ["format=yuv420p"])


HDR_CHAIN = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
             "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")


# --- lanes --------------------------------------------------------------------------------------

def plan_lanes(segments: list) -> list:
    """[{source, seek, segs:[i,...]}]: each lane's segments run forward in source time."""
    lanes = []
    for i, seg in enumerate(segments):
        for lane in lanes:
            if lane["source"] == seg.source and seg.src_start >= lane["last"] - 1e-6:
                lane["segs"].append(i)
                lane["last"] = seg.src_end
                break
        else:
            lanes.append({"source": seg.source, "segs": [i], "last": seg.src_end,
                          "first": seg.src_start})
    for lane in lanes:
        lane["seek"] = max(0.0, math.floor((lane["first"] - SEEK_PREROLL) * 10) / 10.0)
    return lanes


def _f(t: float) -> str:
    return f"{t:.6f}".rstrip("0").rstrip(".") or "0"


# --- audio --------------------------------------------------------------------------------------

def voice_signature(segments: list, src_paths: dict) -> str:
    import hashlib

    def st(p) -> list:
        try:
            s = Path(p).stat()
            return [str(p), s.st_size, s.st_mtime_ns]
        except OSError:
            return [str(p), None, None]
    data = [1, [[s.source, round(s.src_start, 6), round(s.src_end, 6)] for s in segments],
            {k: st(v) for k, v in sorted(src_paths.items())}]
    return hashlib.sha1(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()


def render_voice(ctx: RenderCtx, segments: list, src_paths: dict, out: Path) -> Path:
    """The cut voice: atrim/concat of exactly the picture's segments, 48 kHz stereo wav.
    Kept (same file, same mtime) when the segments and sources are unchanged, so music.build_audio's
    mix cache, keyed on this file's mtime, hits on every render that did not change the cut."""
    sig = voice_signature(segments, src_paths)
    sig_file = out.with_suffix(".sig")
    try:
        if out.exists() and sig_file.read_text(encoding="utf-8").strip() == sig:
            return out
    except OSError:
        pass
    sig_file.unlink(missing_ok=True)
    lanes = plan_lanes(segments)
    cmd = [ctx.ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error"]
    seg_input = {}
    chains, labels = [], []
    for li, lane in enumerate(lanes):
        if lane["seek"] > 0:
            cmd += ["-ss", _f(lane["seek"])]
        cmd += ["-vn", "-i", str(src_paths[lane["source"]])]
        n = len(lane["segs"])
        if n > 1:
            chains.append(f"[{li}:a]asplit={n}" + "".join(f"[A{li}s{si}]" for si in lane["segs"]))
        for si in lane["segs"]:
            seg_input[si] = (f"A{li}s{si}" if n > 1 else f"{li}:a", lane["seek"])
    fade = 0.006
    for i, seg in enumerate(segments):
        pad, seek = seg_input[i]
        d = seg.src_end - seg.src_start
        f = min(fade, d / 4)
        chains.append(f"[{pad}]atrim=start={_f(seg.src_start - seek)}:end={_f(seg.src_end - seek)},"
                      f"asetpts=PTS-STARTPTS,aresample=48000,"
                      f"afade=t=in:d={_f(f)},afade=t=out:st={_f(max(0.0, d - f))}:d={_f(f)}[a{i}]")
        labels.append(f"[a{i}]")
    if len(segments) == 1:
        chains.append(f"{labels[0]}anull[aout]")
    else:
        chains.append("".join(labels) + f"concat=n={len(segments)}:v=0:a=1[aout]")
    graph_file = out.with_suffix(".graph.txt")
    with open(graph_file, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(";\n".join(chains))
    tmp = out.with_name(out.stem + ".part.wav")
    cmd += [*tools.filter_script_args(graph_file), "-map", "[aout]", "-ac", "2", "-ar", "48000",
            "-c:a", "pcm_s16le", "-f", "wav", str(tmp)]
    tools.text_run(cmd, max(300, ctx.duration * 6), "voice render")
    os.replace(tmp, out)
    sig_file.write_text(sig, encoding="utf-8")
    return out


def measure_loudnorm(ffmpeg: str, wav: Path, pre: str = "") -> Optional[dict]:
    af = (pre + "," if pre else "") + f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK}:LRA={LRA}:print_format=json"
    proc = tools.text_run([ffmpeg, "-hide_banner", "-nostats", "-nostdin", "-i", str(wav),
                           "-af", af, "-f", "null", "-"], 600, "loudness measure", check=False)
    log_ = proc.stderr or ""
    a, b = log_.rfind("{"), log_.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        got = json.loads(log_[a:b + 1])
        if float(got["input_i"]) <= -70:
            return None
        return got
    except (ValueError, KeyError):
        return None


def measure_lufs(ffmpeg: str, wav: Path) -> Optional[float]:
    proc = tools.text_run([ffmpeg, "-hide_banner", "-nostats", "-nostdin", "-i", str(wav),
                           "-af", "ebur128", "-f", "null", "-"], 600, "loudness measure", check=False)
    log_ = proc.stderr or ""
    if "Summary:" not in log_:
        return None
    import re as _re
    m = _re.findall(r"^\s*I:\s*(-?[\d.]+)\s*LUFS", log_[log_.rindex("Summary:"):], flags=_re.M)
    try:
        v = float(m[-1]) if m else None
    except ValueError:
        return None
    return v if v is not None and v > -70 else None


def normalize_voice(ctx: RenderCtx, voice: Path, out: Path) -> Path:
    """Voice only (no music module): measured gain to -14 LUFS, then a peak limiter at ~-1.9 dBFS.
    loudnorm resamples to 192 kHz and costs ~7 s a pass; this is two fast decodes."""
    gain = 0.0
    lufs = measure_lufs(ctx.ffmpeg, voice)
    if lufs is not None:
        gain = max(-20.0, min(30.0, TARGET_LUFS - lufs))
    for attempt in range(2):
        tmp = out.with_name(out.stem + ".part.wav")
        tools.text_run([ctx.ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(voice),
                        "-af", f"volume={gain:.2f}dB,alimiter=limit=0.80:level=0:attack=5:release=60",
                        "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(tmp)], 600, "loudness")
        os.replace(tmp, out)
        got = measure_lufs(ctx.ffmpeg, out)
        if got is None or abs(got - TARGET_LUFS) <= 0.6 or attempt == 1:
            break
        gain += TARGET_LUFS - got          # the limiter shaved some loudness off: top it up once
    return out


def build_audio(ctx: RenderCtx, segments: list, src_paths: dict, rwork: Path, warnings: list) -> Path:
    voice = render_voice(ctx, segments, src_paths, rwork / "voice.wav")
    music = _opt_module("music")
    if music is not None and hasattr(music, "build_audio"):
        try:
            mixed = music.build_audio(ctx, voice)
            if mixed and Path(mixed).exists():
                return Path(mixed)
            warnings.append("music module returned no file; used the voice only")
        except EngineError as exc:
            warnings.append(f"music skipped: {exc.message}")
            log(f"# music.build_audio failed: {exc.message}")
        except Exception as exc:    # noqa: BLE001 -- music must never cost the render
            warnings.append(f"music skipped: {type(exc).__name__}: {exc}")
            log(f"# music.build_audio crashed: {exc!r}")
    return normalize_voice(ctx, voice, rwork / "voice_norm.wav")


# --- video graph --------------------------------------------------------------------------------

def _layer_chain(idx: int, layer: Layer, f: float, fps: float, t_shift: float, dur: float):
    """(chain, x, y, t0, t1) for one overlay layer, or None when it falls outside the render."""
    t0, t1 = layer.t0 - t_shift, layer.t1 - t_shift
    if t1 <= 0 or t0 >= dur or t1 - t0 < 1e-3:
        return None
    skip = max(0.0, -t0)
    t0 = max(0.0, t0)
    t1 = min(dur, t1)
    w, h = max(2, int(round(layer.w * f / 2)) * 2), max(2, int(round(layer.h * f / 2)) * 2)
    parts = []
    if layer.kind == "video":
        parts.append(f"fps={fps}")
    parts.append("format=rgba")
    parts.append(f"scale={w}:{h}")
    x, y = layer.x * f, layer.y * f
    if layer.rotate_deg:
        a = layer.rotate_deg * math.pi / 180.0
        parts.append(f"rotate={a:.6f}:c=none:ow=rotw({a:.6f}):oh=roth({a:.6f})")
        rw = abs(w * math.cos(a)) + abs(h * math.sin(a))
        rh = abs(w * math.sin(a)) + abs(h * math.cos(a))
        x -= (rw - w) / 2
        y -= (rh - h) / 2
    span = t1 - t0
    if layer.fade_in > 0 and skip <= 0:
        parts.append(f"fade=t=in:st=0:d={_f(min(layer.fade_in, span / 2))}:alpha=1")
    if layer.fade_out > 0 and layer.t1 - t_shift <= dur + 1e-6:
        fo = min(layer.fade_out, span / 2)
        parts.append(f"fade=t=out:st={_f(max(0.0, span - fo))}:d={_f(fo)}:alpha=1")
    # Start the layer at t0 with transparent padding frames, NOT by shifting its timestamps: overlay
    # waits for the first frame of each input, so a layer whose first frame is at 66 s made ffmpeg
    # queue every main frame before it (GBs of full-resolution frames on a long take, and a render
    # 5-10x slower). The overlay's `enable` window still decides when it shows.
    parts.append("setpts=PTS-STARTPTS")
    if t0 > 0:
        parts.append(f"fps={fps},tpad=start_duration={_f(t0)}:color=0x00000000")   # tpad needs the fps timebase
    return ",".join(parts), int(round(x)), int(round(y)), t0, t1, skip


def build_video_cmd(ctx: RenderCtx, segments: list, src_meta: dict, src_paths: dict, faces: dict,
                    out_w: int, out_h: int, layers: list, zooms: list, ass_name: Optional[str],
                    audio: Path, audio_seek: float, dur: float, t_shift: float, encoder: str,
                    out_part: Path, graph_file: Path, use_hw: bool = True) -> list:
    fps = float(ctx.fmt.get("fps") or 30)
    f = out_w / float(ctx.fmt.get("width") or out_w)
    lanes = plan_lanes(segments)
    cmd = [ctx.ffmpeg, "-y", "-nostdin", "-hide_banner"]
    hw = tools.hwaccel() if (ctx.draft and use_hw) else None
    seg_input, seg_chain = {}, {}
    chains, labels = [], []
    for li, lane in enumerate(lanes):
        src = src_meta[lane["source"]]
        face = faces.get(lane["source"])
        hdr = bool(src.get("hdr"))
        gpu = hw == "cuda" and not hdr and "scale_cuda" in tools.filters()
        if gpu:
            cmd += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
            pre, per_seg = gpu_reframe(src, out_w, out_h, face)
        else:
            if hw and hw != "cuda" and not hdr:
                cmd += ["-hwaccel", hw]
            pre = None
            tm = HDR_CHAIN + "," if hdr and "zscale" in tools.filters() else ""
            per_seg = tm + reframe_filter(src, out_w, out_h, face, ctx.draft) + ",format=yuv420p"
        cmd += no_rotate_args(src)
        if lane["seek"] > 0:
            cmd += ["-ss", _f(lane["seek"])]
        cmd += ["-i", str(src_paths[lane["source"]])]
        n = len(lane["segs"])
        head = f"[{li}:v]" + (pre + "," if pre else "")
        if n > 1:
            chains.append(head + f"split={n}" + "".join(f"[L{li}s{si}]" for si in lane["segs"]))
        elif pre:
            chains.append(head.rstrip(",") + f"[L{li}s{lane['segs'][0]}]")
        for si in lane["segs"]:
            seg_input[si] = (f"L{li}s{si}" if (n > 1 or pre) else f"{li}:v", lane["seek"])
            seg_chain[si] = per_seg
    n_in = len(lanes)
    for i, seg in enumerate(segments):
        pad, seek = seg_input[i]
        # Cut points sit ON the frame grid, and a printed 4.166667 vs a frame at 4.1666666 decides
        # by rounding whether that frame is in: one frame gained or lost per segment, i.e. picture
        # drifting against sound across a many-cut video. Half a frame early is unambiguous.
        src_fps = float(src_meta[seg.source].get("fps") or fps)
        half = 0.5 / src_fps
        # The fps filter ends the stream at the LAST frame's timestamp (concat hands it frames with
        # no duration), so it never emits that last frame: every render came out one frame short.
        # The last segment carries one guard frame past its end; `end_frame` below trims it off.
        guard = 1.0 / src_fps if i == len(segments) - 1 else 0.0
        chains.append(f"[{pad}]trim=start={_f(max(0.0, seg.src_start - seek - half))}:"
                      f"end={_f(seg.src_end - seek - half + guard)},"
                      f"setpts=PTS-STARTPTS,{seg_chain[i]},setsar=1[v{i}]")
        labels.append(f"[v{i}]")
    n_frames = max(1, int(round(dur * fps)))
    # tpad covers a cut that ends on the source's very last frame (no guard frame to borrow)
    tail = f"fps={fps},tpad=stop=1:stop_mode=clone,trim=end_frame={n_frames}"
    if len(segments) == 1:
        chains.append(f"{labels[0]}{tail}[base0]")
    else:
        chains.append("".join(labels) + f"concat=n={len(segments)}:v=1:a=0,{tail}[base0]")
    cur = "base0"
    # zooms move the FOOTAGE, so they sit on the base, under every card and caption
    for zi, z in enumerate(zooms or []):
        t0, t1 = z.t0 - t_shift, z.t1 - t_shift
        if t1 <= 0 or t0 >= dur or z.scale <= 1.001:
            continue
        t0, t1 = max(0.0, t0), min(dur, t1)
        cw = int(round(out_w / z.scale / 2)) * 2
        ch = int(round(out_h / z.scale / 2)) * 2
        cx, cy = z.cx * f, z.cy * f
        x = int(min(max(0, cx - cw / 2), out_w - cw))
        y = int(min(max(0, cy - ch / 2), out_h - ch))
        chains.append(f"[{cur}]split=2[zm{zi}][zs{zi}]")
        # padded from 0 (see _layer_chain): the overlay never waits for the zoom's first frame. The
        # base is on the fps grid, so start on a frame: trim and padding then agree to the frame.
        k0 = int(math.ceil(t0 * fps - 1e-6))
        t0 = k0 / fps
        pad = f",fps={fps},tpad=start={k0}" if k0 > 0 else ""
        chains.append(f"[zs{zi}]trim=start={_f(t0)}:end={_f(t1)},setpts=PTS-STARTPTS,crop={cw}:{ch}:{x}:{y},"
                      f"scale={out_w}:{out_h}:flags={'fast_bilinear' if ctx.draft else 'lanczos'},"
                      f"setsar=1{pad}[zz{zi}]")
        chains.append(f"[zm{zi}][zz{zi}]overlay=0:0:eof_action=pass:repeatlast=0:"
                      f"enable='between(t,{_f(t0)},{_f(t1)})'[zb{zi}]")
        cur = f"zb{zi}"
    # overlay layers, lowest z first
    k = n_in
    layer_inputs = []
    for li, layer in enumerate(sorted(layers or [], key=lambda l: (l.z, l.t0))):
        lc = _layer_chain(li, layer, f, fps, t_shift, dur)
        if lc is None:
            continue
        chain, x, y, t0, t1, skip = lc
        span = t1 - t0 + 0.1
        p = Path(layer.path)
        if layer.kind == "image":
            layer_inputs += ["-loop", "1", "-framerate", _f(fps), "-t", _f(span), "-i", str(p)]
        else:
            if skip > 0:
                layer_inputs += ["-ss", _f(skip)]
            layer_inputs += ["-t", _f(span), "-i", str(p)]
        chains.append(f"[{k}:v]{chain}[l{li}]")
        chains.append(f"[{cur}][l{li}]overlay={x}:{y}:eof_action=pass:repeatlast=0:"
                      f"enable='between(t,{_f(t0)},{_f(t1)})'[o{li}]")
        cur = f"o{li}"
        k += 1
    if ass_name:
        chains.append(f"[{cur}]subtitles=filename={ass_name}:fontsdir=fonts[capd]")
        cur = "capd"
    chains.append(f"[{cur}]format=yuv420p[vout]")
    with open(graph_file, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(";\n".join(chains))
    cmd += layer_inputs
    if audio_seek > 0:
        cmd += ["-ss", _f(audio_seek)]
    cmd += ["-t", _f(dur + 0.05), "-i", str(audio)]
    audio_idx = k
    cmd += [*tools.filter_script_args(graph_file.name), "-map", "[vout]", "-map", f"{audio_idx}:a"]
    cmd += encoder_args(encoder, ctx.draft)
    cmd += ["-r", _f(fps), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            "-t", _f(dur), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats",
            "-f", "mp4", str(out_part)]
    return cmd


# Final x264 preset. Instagram re-encodes every upload, so the export only has to be a clean master at
# CRF 18. Measured on a 1:34 take (status/wire.md): encode 30-41 s vs `medium` 88-100 s, file 53.6 MB vs
# 64.6 MB, SSIM 0.993 against the `medium` file (`faster`: 45-48 s, 64.3 MB, the same SSIM). Same bytes
# per project still holds (software encoder, fixed args).
FINAL_PRESET = "veryfast"


def encoder_args(encoder: str, draft: bool) -> list:
    tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-color_range", "tv"]
    if encoder in tools.HW_ENCODER_OPTS:
        return (["-c:v", encoder] + tools.HW_ENCODER_OPTS[encoder]
                + ["-pix_fmt", tools.HW_ENCODER_PIX_FMT.get(encoder, "yuv420p")] + tags)
    if draft:
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p"] + tags
    return ["-c:v", "libx264", "-preset", FINAL_PRESET, "-crf", "18", "-profile:v", "high",
            "-pix_fmt", "yuv420p"] + tags


# --- cover --------------------------------------------------------------------------------------

def fallback_cover(ctx: RenderCtx, proj: dict, tl, src_meta: dict, src_paths: dict, faces: dict,
                   out_png: Path) -> Path:
    """A frame from the RAW take (never the captioned export), reframed to the output size."""
    cov = proj.get("cover") or {}
    sid = cov.get("source") or (tl.segments[0].source if tl.segments else "s1")
    t = cov.get("atSourceTime")
    if t is None:
        sid, t = tl.out_to_src(min(tl.duration * 0.25, 3.0))
        sid = sid or "s1"
    W, H = int(ctx.fmt["width"]), int(ctx.fmt["height"])
    vf = reframe_filter(src_meta[sid], W, H, faces.get(sid), False)
    if src_meta[sid].get("hdr") and "zscale" in tools.filters():
        vf = HDR_CHAIN + "," + vf
    tmp = out_png.with_name(out_png.stem + ".part.png")
    tools.text_run([ctx.ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    *no_rotate_args(src_meta[sid]), "-ss", _f(float(t)), "-i", str(src_paths[sid]), "-frames:v", "1", "-vf", vf,
                    str(tmp)], 120, "cover frame")
    os.replace(tmp, out_png)
    return out_png


# --- main ---------------------------------------------------------------------------------------

def parse_window(spec: Optional[str], duration: float):
    if not spec:
        return None
    try:
        a, b = (float(x) for x in spec.replace(",", ":").split(":"))
    except ValueError:
        raise EngineError("BAD_ARGS", f"--window needs a:b in output seconds (got {spec!r})",
                          "Reel Studio asked for a preview of a part of the video it couldn't read.")
    a, b = max(0.0, min(a, b)), min(duration, max(a, b))
    if b - a < 0.2:
        raise EngineError("BAD_ARGS", f"window {spec} is empty", "That part of the video is too short to preview.")
    return a, b


def make_ctx(project_dir: Path, proj: dict, tl, draft: bool, root: Path, rwork: Path) -> RenderCtx:
    def _progress(stage, pct, message):
        progress(stage or STAGE, pct, message)

    return RenderCtx(project=proj, project_dir=project_dir, root=root, out_timeline=tl.segments,
                     word_out_time=tl.word_out_time, duration=tl.duration, fmt=dict(proj["format"]),
                     draft=draft, work=project_dir / "work", ffmpeg=tools.ffmpeg(),
                     ffprobe=tools.ffprobe(), progress=_progress, word_out_end=tl.word_out_end,
                     words=tl.words)


GONE_WORDS = "it sits on words that are no longer in the transcript, so it was left out"


def unknown_anchor_skips(proj: dict, tl) -> tuple:
    """(skipped b-roll rows, warnings) for every b-roll / zoom whose anchor names a word id the
    transcript does not have. These used to vanish with a stderr line only: an empty report and a
    video silently missing the b-roll."""
    known = tl.index
    rows, warns = [], []
    for i, b in enumerate(proj.get("broll") or []):
        anc = b.get("anchor") or {}
        ids = [x for x in (anc.get("from"), anc.get("to")) if x]
        if not ids or any(x not in known for x in ids):
            rows.append({"id": b.get("id", f"b{i + 1}"), "treatment": b.get("treatment"),
                         "skipped": GONE_WORDS})
    if rows:
        warnings_n = len(rows)
        warns.append(f"{warnings_n} b-roll item{'s' if warnings_n != 1 else ''} left out: "
                     "the words they sit on are no longer in the transcript.")
    bad_z = sum(1 for z in proj.get("zooms") or []
                if any(x not in known for x in ((z.get("anchor") or {}).get("from"),
                                                (z.get("anchor") or {}).get("to")) if x))
    if bad_z:
        warns.append(f"{bad_z} zoom-in{'s' if bad_z != 1 else ''} left out: "
                     "the words they sit on are no longer in the transcript.")
    return rows, warns


def read_broll_report(project_dir: Path) -> list:
    """Per b-roll item, from A2's work/layers/layers.json: how it was actually shown. Items that
    could not be shown as asked carry `fallback` (and `shownAs`) or `skipped`, in plain words the
    editor can repeat to the user ("no room on the left of the face; shown above you instead")."""
    side = Path(project_dir) / "work" / "layers" / "layers.json"
    try:
        items = projmod.read_json(side).get("items") or []
    except (ValueError, OSError):
        return []
    out = []
    for it in items:
        row = {"id": it.get("id"), "treatment": it.get("treatment")}
        if it.get("skipped"):
            row["skipped"] = it["skipped"]
        if it.get("fallback"):
            row["fallback"] = it["fallback"]
            row["shownAs"] = it.get("fallbackTreatment") or it.get("zone")
        if it.get("remake"):                     # an animation the edit has since moved under
            row["remake"] = it["remake"]
            row["clash"] = it.get("clash") or []
        if it.get("captionHintY") is not None:
            row["captionHintY"] = it["captionHintY"]
            row["t0"], row["t1"] = it.get("t0"), it.get("t1")
        out.append(row)
    return out


def check_fontselect(stderr: str, font_path: Path) -> Optional[str]:
    """libass logs which file it actually used. Anything other than our font = silent substitution."""
    hits = [ln for ln in stderr.splitlines() if "fontselect:" in ln]
    if not hits:
        return None
    bad = [ln for ln in hits if font_path.name.lower() not in ln.lower()
           and font_path.stem.lower() not in ln.lower()]
    return bad[0].strip() if bad else None


def first_look_project(project_dir: Path, proj: dict, music: Optional[str] = None) -> dict:
    """The deterministic edit IN MEMORY (never saved): the analysis's default cut, captions on, and
    `music` when the project has no song yet. The app shows it while the AI edits project.json."""
    proj = json.loads(json.dumps(proj))
    af = project_dir / "work" / "analysis.json"
    if af.exists():
        keep = ((projmod.read_json(af).get("defaultCut") or {}).get("keep")) or []
        if keep:
            proj.setdefault("cut", {})["keep"] = keep
            proj["cut"]["source"] = "autocut"
    proj.setdefault("captions", {})["enabled"] = True
    mus = proj.setdefault("music", {})
    if music and not mus.get("track"):
        mus.update({"enabled": True, "track": music, "level": "under-voice"})
    return proj


def run(project_dir: Path, draft: bool = False, window: Optional[str] = None,
        root: Optional[Path] = None, verify: bool = True, first_look: bool = False,
        music: Optional[str] = None, cover: bool = True) -> dict:
    t_start = time.time()
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir)
    if first_look:
        draft = True
        proj = first_look_project(project_dir, proj, music)
    root = tools.root_dir(str(root) if root else None)
    progress(STAGE, 1, "Getting your video ready", force=True)
    words = projmod.load_transcript(project_dir, proj)["words"]
    tl = projmod.timeline(project_dir, proj, words)
    if tl.duration < 0.3 or not tl.segments:
        raise EngineError("EMPTY_CUT", "the cut is empty", "There's nothing left in the edit. Undo the last change.")
    win = parse_window(window, tl.duration)
    if win:
        draft = True        # a window is a preview: always the fast encoder

    committed = int(proj.get("version") or 0)
    version = pick_version(project_dir, proj, root)  # for a preview: the number this edit WILL get
    preview = bool(draft)
    vdir = preview_dir(project_dir) if preview else project_dir / "versions" / f"v{version}"
    if not preview and version == committed and (vdir / "export.mp4").exists() and (vdir / "render.json").exists():
        # a saved version is never rewritten: the same edit gets its video back
        made = projmod.read_json(vdir / "render.json")
        made.pop("segmentsDetail", None)
        return dict(made, file=str(vdir / "export.mp4"), versionDir=str(vdir), reused=True)
    if not preview and version > committed and vdir.exists():
        shutil.rmtree(vdir)      # above project.version: an attempt that was never saved
    vdir.mkdir(parents=True, exist_ok=True)
    if win:     # one scratch window at a time: older window slices go
        for old in vdir.glob("window_*"):
            try:
                old.unlink()
            except OSError:
                pass
    rwork = project_dir / "work" / "render"
    rwork.mkdir(parents=True, exist_ok=True)
    warnings: list = []

    src_meta = {s["id"]: s for s in proj["sources"]}
    src_paths = {s["id"]: projmod.source_path(project_dir, s) for s in proj["sources"]}
    for sid, p in src_paths.items():
        if not p.exists():
            raise EngineError("SOURCE_MISSING", f"missing source {p}",
                              "I can't find the original video for this project. It may have been "
                              "moved or deleted.")
    faces = source_faces(project_dir, proj)

    ctx = make_ctx(project_dir, proj, tl, draft, root, rwork)
    ctx.out_dir = vdir
    ctx.window = win
    timings = {}

    # 1. audio (always the full cut, then sliced for a window, so the music sits where it will)
    progress(STAGE, 4, "Cutting your sound", force=True)
    t = time.time()
    audio = build_audio(ctx, tl.segments, src_paths, rwork, warnings)
    timings["audio"] = round(time.time() - t, 2)

    # 2. b-roll layers + zooms (A2)
    t = time.time()
    layers, zooms = [], []
    layers_report = project_dir / "work" / "layers" / "layers.json"
    layers_report.unlink(missing_ok=True)       # read below and by the AI: only this render's
    broll = _opt_module("broll")
    if broll is not None and proj.get("broll"):
        progress(STAGE, 12, "Placing your pictures", force=True)
        try:
            layers = list(broll.build_layers(ctx) or [])
        except EngineError as exc:
            log(f"# b-roll skipped: {exc.message}")
            warnings.append(f"The b-roll was left out of this version: {exc.user_message}")
        except Exception as exc:   # noqa: BLE001
            # dev detail goes to the log, never into a warning the app may show
            log(f"# broll.build_layers crashed: {exc!r}")
            warnings.append(BROLL_FAILED)
    broll_report = read_broll_report(project_dir) if proj.get("broll") and broll is not None else []
    gone_rows, gone_warns = unknown_anchor_skips(proj, tl)
    broll_report = [r for r in broll_report if r.get("id") not in {g["id"] for g in gone_rows}] + gone_rows
    warnings += gone_warns
    zoom = _opt_module("zoom")
    if zoom is not None and proj.get("zooms"):
        try:
            zooms = list(zoom.build_zooms(ctx) or [])
        except Exception as exc:   # noqa: BLE001
            log(f"# zoom.build_zooms failed: {exc!r}")
            warnings.append(ZOOMS_FAILED)
    timings["layers"] = round(time.time() - t, 2)

    # 3. captions
    fmt = proj["format"]
    W, H, fps = int(fmt["width"]), int(fmt["height"]), float(fmt["fps"])
    ass_name, cap_report, font_path = None, [], None
    cap = proj.get("captions") or {}
    if cap.get("enabled", True):
        progress(STAGE, 16, "Writing your captions", force=True)
        words_out = tl.words_out
        shift = 0.0
        if win:
            a, b = win
            shift = a
            words_out = [dict(w, s=w["s"] - a, e=w["e"] - a) for w in tl.words_out if w["e"] > a and w["s"] < b]
        # split views of a close-up face: captions move to the seam instead of crossing the face
        spans = [(r["t0"] - shift, r["t1"] - shift, float(r["captionHintY"])) for r in broll_report
                 if r.get("captionHintY") is not None and r.get("t0") is not None and r.get("t1") is not None]
        ass, cap_report, cwarn, (family, font_path), stats = capmod.build_for_timeline(
            tl, proj, W, H, words_out=words_out, position_spans=spans)
        warnings += cwarn
        ass_name = "captions.ass"
        with open(rwork / ass_name, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(ass)
        fonts = rwork / "fonts"
        if fonts.exists():
            shutil.rmtree(fonts, ignore_errors=True)
        fonts.mkdir(parents=True, exist_ok=True)
        shutil.copy2(font_path, fonts / Path(font_path).name)

    # 4. the picture
    if win:
        a, b = win
        segments = cutmod.window_segments(tl.segments, a, b)
        dur, t_shift, audio_seek = b - a, a, a
    else:
        segments, dur, t_shift, audio_seek = tl.segments, tl.duration, 0.0, 0.0
    if draft:
        out_w = int(round(W * DRAFT_SCALE / 2)) * 2
        out_h = int(round(H * DRAFT_SCALE / 2)) * 2
        encoder = tools.draft_encoder()
    else:
        out_w, out_h, encoder = W, H, "libx264"
    if win:
        name = f"window_{a:.1f}-{b:.1f}.mp4"
    else:
        name = "draft.mp4" if draft else "export.mp4"
    out = vdir / name
    out_part = rwork / (name + ".part")
    graph = rwork / ("graph_" + name.replace(".mp4", ".txt"))
    cmd = build_video_cmd(ctx, segments, src_meta, src_paths, faces, out_w, out_h, layers, zooms,
                          ass_name, audio, audio_seek, dur, t_shift, encoder, out_part, graph)
    # The cover reads only the source and the project, never the encode's output: make it on a
    # thread while ffmpeg encodes (it used to add 3-9 s after the encode), and reuse it when nothing
    # it depends on changed since the last render (most notes).
    cover_job = None
    if not win and (cover or not draft):
        cover_job = CoverJob(ctx, proj, tl, src_meta, src_paths, faces, vdir / "cover.png", warnings)
    progress(STAGE, 20, "Making your video", force=True)
    t = time.time()

    def on_pct(p):
        progress(STAGE, 20 + 0.72 * p, "Making your video")

    try:
        err = tools.ffmpeg_progress(cmd, dur, on_pct, timeout=max(600, dur * 40), what="video render",
                                    cwd=rwork, user_message="I couldn't finish making your video. "
                                                            "Please try again.")
    except EngineError as exc:
        if draft:
            log(f"# hardware draft path failed, retrying in software: {exc.message[-400:]}")
            warnings.append("The fast preview path didn't work on this computer, so I used the slower one.")
            failed_encoder, encoder = encoder, "libx264"
            cmd = build_video_cmd(ctx, segments, src_meta, src_paths, faces, out_w, out_h, layers, zooms,
                                  ass_name, audio, audio_seek, dur, t_shift, encoder, out_part, graph,
                                  use_hw=False)
            err = tools.ffmpeg_progress(cmd, dur, on_pct, timeout=max(600, dur * 40), what="video render",
                                        cwd=rwork)
            if failed_encoder != "libx264":
                # Software worked where the GPU encoder did not: stop trying that encoder for a few days.
                tools.mark_encoder_failed(failed_encoder)
        else:
            raise
    timings["encode"] = round(time.time() - t, 2)
    if font_path is not None:
        bad = check_fontselect(err, Path(font_path))
        if bad:
            raise EngineError("FONT_SUBSTITUTED", f"libass used a different font: {bad}",
                              "Your captions came out in the wrong font, so I stopped. Please "
                              "reinstall Reel Studio.")
        if "fontselect:" not in err:
            warnings.append("libass did not report its font choice; caption font unverified")
    os.replace(out_part, out)

    result = {"version": version, "preview": preview, "versionDir": str(vdir), "file": str(out),
              "draft": draft, "window": list(win) if win else None, "firstLook": first_look,
              "duration": round(dur, 3), "segments": len(segments), "encoder": encoder,
              "size": [out_w, out_h], "layers": len(layers), "zooms": len(zooms),
              "captions": len(cap_report), "warnings": warnings,
              "broll": [r for r in broll_report if r.get("fallback") or r.get("skipped") or r.get("remake")]}

    # 5. cover (full renders only; a preview may skip it). It ran beside the encode (above).
    if cover_job is not None:
        progress(STAGE, 93, "Making your cover", force=True)
        t = time.time()
        result["cover"] = str(cover_job.result())
        timings["cover"] = round(time.time() - t + cover_job.seconds, 2)
        timings["coverWait"] = round(time.time() - t, 2)

    # 6. verify
    if verify:
        progress(STAGE, 95, "Checking your video", force=True)
        t = time.time()
        from . import verify as verifymod
        rep = verifymod.check(out, expect_duration=dur, expect_w=out_w, expect_h=out_h, expect_fps=fps,
                              captions=cap_report if not win else None, fmt=(W, H),
                              draft=draft)
        projmod.write_json(vdir / ("verify.json" if not win else f"verify_{name[:-4]}.json"), rep)
        result["verify"] = {"ok": rep["ok"], "fails": rep["fails"], "warns": rep["warns"]}
        timings["verify"] = round(time.time() - t, 2)

    timings["total"] = round(time.time() - t_start, 2)
    result["timings"] = timings
    if not win:
        # the reports that describe THIS video live beside it (verify, the AI's frame checks, e2e); a
        # report this render did not make is removed, so a reused folder never keeps an older one
        projmod.write_json(vdir / "captions.json", {"cues": cap_report})
        for report, name in ((layers_report, "layers.json"), (Path(audio).with_suffix(".json"), "mix.json")):
            if report.exists():
                copy_whole(report, vdir / name)
            else:
                (vdir / name).unlink(missing_ok=True)
        snap = json.loads(json.dumps(proj))
        projmod.write_json(vdir / "project.json", snap)
        manifest = dict(result, segmentsDetail=[s.__dict__ for s in tl.segments][:2000])
        projmod.write_json(vdir / ("render_draft.json" if draft else "render.json"), manifest)
        if not preview:
            projmod.write_json(vdir / "assets.json", asset_fingerprint(project_dir, proj, root))
        if not preview and int(proj.get("version") or 0) != version:
            # Re-read: an edit saved during this 1-2 minute render must survive. Patch the one field
            # render owns instead of writing back the dict loaded at the start.
            fresh = projmod.load(project_dir)
            fresh["version"] = version          # project.version = the last FINAL version
            projmod.save(project_dir, fresh)
    progress(STAGE, 100, "Your video is ready", force=True)
    return result


def copy_whole(src: Path, dst: Path) -> None:
    """Copy to a unique `.part` beside `dst`, then rename it into place: `dst` is never half a file."""
    part = dst.with_name(f"{dst.name}.{uuid.uuid4().hex[:8]}.part")
    try:
        shutil.copy2(src, part)
        os.replace(part, dst)
    finally:
        part.unlink(missing_ok=True)


def cover_key(ctx, proj: dict) -> str:
    """Everything cover.render reads: the cover settings, the sources, the format, the cut (it picks
    from kept moments), the transcript and face track it scores against, the draft flag (a preview
    scores fewer frames) and the cover code itself."""
    import hashlib

    def mt(p: Path) -> float:
        try:
            return round(p.stat().st_mtime, 3)
        except OSError:
            return 0.0
    pdir = Path(ctx.project_dir)
    here = Path(__file__).parent
    data = {"cover": proj.get("cover"), "sources": proj.get("sources"), "format": proj.get("format"),
            "cut": proj.get("cut"), "draft": bool(ctx.draft),
            "files": [mt(pdir / "work" / "transcript.json"), mt(pdir / "work" / "face.json"),
                      *(mt(f) for f in sorted((pdir / "work").glob("face-*.json"))),
                      mt(here / "cover.py"), mt(here / "placement.py"), mt(Path(__file__))]}
    return hashlib.sha1(json.dumps(data, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


class CoverJob:
    """render_cover on a worker thread, with a small on-disk cache (work/render/cover-cache/)."""

    def __init__(self, ctx, proj, tl, src_meta, src_paths, faces, out_png: Path, warnings: list):
        import dataclasses
        import threading
        self.out_png, self.seconds, self._res, self._exc = Path(out_png), 0.0, None, None
        # no progress from the thread: it would interleave "Making your cover" with the encode's percent
        quiet = dataclasses.replace(ctx, progress=None) if dataclasses.is_dataclass(ctx) else ctx
        cache = Path(ctx.project_dir) / "work" / "render" / "cover-cache"
        key = cover_key(ctx, proj)

        def work():
            t0 = time.time()
            try:
                hit = cache / f"{key}.png"
                if hit.exists():
                    self.out_png.parent.mkdir(parents=True, exist_ok=True)
                    copy_whole(hit, self.out_png)
                    meta = cache / f"{key}.json"
                    if meta.exists():
                        copy_whole(meta, Path(ctx.work) / "cover.json")
                    self._res = self.out_png
                    return
                self._res = render_cover(quiet, proj, tl, src_meta, src_paths, faces, self.out_png, warnings)
                try:
                    cache.mkdir(parents=True, exist_ok=True)
                    for old in sorted(cache.glob("*.png"), key=lambda f: f.stat().st_mtime)[:-8]:
                        old.unlink(missing_ok=True)
                        old.with_suffix(".json").unlink(missing_ok=True)
                    # the .png is the hit: it lands last and whole, so a killed copy is never reused
                    cj = Path(ctx.work) / "cover.json"
                    for src, dst in ((cj, cache / f"{key}.json"), (self._res, hit)):
                        if src.exists():
                            copy_whole(src, dst)
                except OSError:
                    pass
            except BaseException as exc:   # noqa: BLE001 -- re-raised in result()
                self._exc = exc
            finally:
                self.seconds = time.time() - t0
        self._t = threading.Thread(target=work, name="cover", daemon=True)
        self._t.start()

    def result(self) -> Path:
        self._t.join()
        if self._exc is not None:
            raise self._exc
        return self._res


def render_cover(ctx, proj, tl, src_meta, src_paths, faces, out_png: Path, warnings: list) -> Path:
    cover = _opt_module("cover")
    if cover is not None and hasattr(cover, "render"):
        try:
            p = cover.render(ctx, out_png)
            if p and Path(p).exists():
                return Path(p)
        except Exception as exc:   # noqa: BLE001 -- a missing cover never costs the export
            warnings.append("The cover maker had a problem, so I used a plain frame from your video.")
            log(f"# cover.render failed: {exc!r}")
    return fallback_cover(ctx, proj, tl, src_meta, src_paths, faces, out_png)


def cover_candidates(project_dir: Path, moments: list, source: Optional[str] = None, root: Optional[Path] = None) -> dict:
    """`cover-candidates --at t1,t2,...`: the best cover frame near each raw-take moment, as small
    stills the AI looks at before choosing (cover.candidates)."""
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir)
    tl = projmod.timeline(project_dir, proj)
    ctx = make_ctx(project_dir, proj, tl, True, tools.root_dir(str(root) if root else None),
                   project_dir / "work" / "render")
    cover = _opt_module("cover")
    sid = source or (ctx.out_timeline[0].source if ctx.out_timeline else proj["sources"][0]["id"])
    out_dir = project_dir / "work" / "cover-candidates"
    for f in out_dir.glob("cover_*.jpg") if out_dir.exists() else []:
        f.unlink(missing_ok=True)
    progress("cover", 10, "Looking for a cover", force=True)
    rows = cover.candidates(ctx, sid, [float(m) for m in moments][:6], out_dir)
    progress("cover", 100, "Looking for a cover", force=True)
    return {"source": sid, "candidates": rows}


def cover_only(project_dir: Path, root: Optional[Path] = None) -> dict:
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir)
    tl = projmod.timeline(project_dir, proj)
    version = max(1, pick_version(project_dir, proj, tools.root_dir(str(root) if root else None)))
    vdir = preview_dir(project_dir)      # a saved version's cover is never rewritten
    vdir.mkdir(parents=True, exist_ok=True)
    ctx = make_ctx(project_dir, proj, tl, False, tools.root_dir(str(root) if root else None),
                   project_dir / "work" / "render")
    src_meta = {s["id"]: s for s in proj["sources"]}
    src_paths = {s["id"]: projmod.source_path(project_dir, s) for s in proj["sources"]}
    warnings: list = []
    progress("cover", 10, "Making your cover", force=True)
    p = render_cover(ctx, proj, tl, src_meta, src_paths, source_faces(project_dir, proj),
                     vdir / "cover.png", warnings)
    progress("cover", 100, "Your cover is ready", force=True)
    return {"file": str(p), "version": version, "preview": True, "warnings": warnings}
