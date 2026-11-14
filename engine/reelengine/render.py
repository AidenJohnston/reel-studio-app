"""`render [--draft] [--window a:b] [--rules file]`: project.json -> versions/vN/{export.mp4, cover.png,
verify.json} for a final render; drafts and window previews overwrite versions/preview/ (docs/versions.md).
With --rules, the result's `ruleChecks` says which checkable My style rules this render breaks
(rule_checks.py), and a final render that breaks one the rules file lists in `stopOn` returns before its encode.

Order of operations (docs/architecture.md section 5): cut video (+ zooms) -> overlay layers by z -> captions burned
last -> mux the audio. The audio is built FIRST, as its own file: the cut voice, then the music
and SFX mix (or plain loudness normalisation to -14 LUFS without the music module). The video pass
maps that file.

Segment boundaries are on the source frame grid (cut.py). Ordinary cuts concatenate matching
picture and voice spans. J/L joins overlap bounded audio handles on the same output clock without
moving the kept speech or lengthening the picture. Every ffmpeg input is bounded.

Inputs are opened in LANES: each lane is one ffmpeg input of a source whose segments run forward in
source time. A cut in source order is one lane per source. A reordered cut (hook recorded last,
placed first) gets an extra lane, opened with an input seek, so ffmpeg never has to buffer minutes
of decoded frames waiting for a later segment. The picture also starts a new lane across a long
gap of cut-away footage (video_lanes), so a long take cut short decodes only near what it keeps.
The voice keeps one lane per forward run: audio decode is cheap and its file is cached.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import math
import os
import shutil
import time
import uuid
from fractions import Fraction
from pathlib import Path
from typing import Optional

import reelengine

from . import anim_timing, captions as capmod, chunks as chunkmod, cut as cutmod, project as projmod, proxy as proxymod, render_identity, rule_checks, safepath, tools
from .cut_style import visual_change_meter
from .proto import EngineError, log, progress
from .render_ctx import Layer, RenderCtx, Segment, ZoomSpan

STAGE = "render"
TARGET_LUFS = -14.0
TRUE_PEAK = -1.5
LRA = 11
LIMIT = 0.97
DRAFT_SCALE = 0.5
SEEK_PREROLL = 3.0
# A new video input opens the file again and decodes from the keyframe before (start - SEEK_PREROLL);
# staying on the lane decodes the gap. Split only gaps clearly longer than that preroll plus a GOP.
# The 2 s margin is a judgment, not a measurement.
MIN_SEEK_GAP = SEEK_PREROLL + 2.0
# Every input holds its own decoder until ffmpeg exits (fftools/ffmpeg_dec.c frees the codec context
# only at cleanup), so memory grows with the input count. On Windows 11 (16 threads, FFmpeg 7.1.1-rs2)
# the final of a 4K HEVC take cut to five far-apart stretches peaked at 1.50 GiB with one input and
# 3.86 GiB with five, about 0.6 GiB per extra input. Three bounds the extra near 1.2 GiB for 8-bit 4K;
# 10-bit footage and Macs are unmeasured. Raising it trades memory for decode time.
# It caps only the seeks video_lanes adds. A reordered cut keeps every input plan_lanes gives it, as
# on main, even past this: a forward-only input cannot serve an earlier segment without buffering.
MAX_VIDEO_LANES = 3


BROLL_FAILED = "Some b-roll couldn't be added to this version. Try again, or pick a different picture."
ZOOMS_FAILED = "The zoom-ins couldn't be added to this version."
SFX_FAILED = "The sound effects couldn't be added to this version."


def _opt_module(name: str):
    """A2's modules are optional at render time: missing = that feature is skipped."""
    try:
        return importlib.import_module(f".{name}", __package__)
    except ImportError as exc:
        log(f"# {name} not available ({exc}); rendering without it")
        return None


# --- versions -----------------------------------------------------------------------------------

def asset_fingerprint(project_dir: Path, proj: dict, root: Optional[Path] = None) -> dict:
    """Engine version and {path: [size, mtime_ns]} of every file the edit reads. project.json alone cannot tell that a
    song or picture was REPLACED under the same name, or that the words changed: the transcript sets
    the cut's timings and the burned-in subtitles."""
    refs = [s.get("path") for s in proj.get("sources") or []]
    refs.append(projmod.TRANSCRIPT_REL)
    refs.append(projmod.song_ref(proj.get("music") or {}))
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
    out.update(anim_timing.rendered_clips(project_dir))   # an animation may play a clip re-timed to the cut
    return {"engineVersion": reelengine.__version__, "assets": out}


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
                prior = projmod.read_json(snap)
                same = projmod.edit_signature(prior) == projmod.edit_signature(proj)
                # Caption trials need distinct versions even though their video pixels match.
                trials_file = Path(project_dir) / "trials.json"
                if same and trials_file.exists():
                    trials = projmod.read_json(trials_file)
                    if any(t.get("parent_version") == cur and t.get("variable") == "caption" for t in trials):
                        same = False
                fp = vdir / "assets.json"
                if same:
                    same = fp.exists() and projmod.read_json(fp) == asset_fingerprint(project_dir, proj, root)
                if same:
                    return cur
            except (ValueError, OSError):
                pass
    return cur + 1


PREVIEW_DIR = "preview"


def preview_fps(fps: float) -> float:
    """The rate a draft or window preview renders at. Editing previews stay at 30 fps or under so they are
    as fast as before projects kept their source rate; only the final export keeps it, up to 60. From 48
    fps up a preview takes every other frame (60 -> 30, 59.94 -> 29.97, 50 -> 25), so motion stays even."""
    if fps <= 30:
        return fps
    return fps / 2 if fps >= 48 else 30.0


def preview_dir(project_dir: Path) -> Path:
    """versions/preview/: the ONE scratch folder every draft and window preview overwrites.
    Only a final render makes a user-visible version folder (docs/versions.md)."""
    return Path(project_dir) / "versions" / PREVIEW_DIR


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


def display_crop(disp: tuple, out_w: int, out_h: int, face: Optional[tuple]) -> tuple:
    """(x, y, cw, ch): the part of the upright picture (disp = its width, height) that fills
    out_w x out_h, centred on the face when known. Match cuts compare frames through it (match.py)."""
    w, h = disp
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
    return x, y, cw, ch


def reframe_plan(src: dict, out_w: int, out_h: int, face: Optional[tuple]) -> dict:
    """Where to crop the source so it fills out_w x out_h, centred on the face when known.
    The crop rect is in STORED (unrotated) pixels; `rot` is the clockwise turn applied last."""
    rw, rh = int(src.get("width") or out_w), int(src.get("height") or out_h)
    rot = int(src.get("rotation") or 0) % 360
    w, h = (rh, rw) if rot in (90, 270) else (rw, rh)          # display size
    x, y, cw, ch = display_crop((w, h), out_w, out_h, face)
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
    # One thread for the final, so the same project gives the same frames. The output is tagged BT.709
    # (encoder_args), and since FFmpeg 8 this scale also converts any other colour matrix (an untagged or
    # BT.601 take) to it, through RGB. Run in slices on several threads, that conversion gave different
    # pixels on every render. Measured on a 60 s reel from a 4K take: FFmpeg 7.1.1 encode 72 s -> 42 s
    # untagged, 32 s -> 34 s BT.709; FFmpeg 8.0.1 31 s -> 41 s untagged, 32 s -> 35 s BT.709. Drafts
    # keep the threads.
    chain.append(f"scale={pl['sw']}:{pl['sh']}:flags={'fast_bilinear' if draft else 'lanczos:threads=1'}")
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
        lane["seek"] = _lane_seek(lane["first"])
    return lanes


def _lane_seek(first: float) -> float:
    return max(0.0, math.floor((first - SEEK_PREROLL) * 10) / 10.0)


def video_lanes(segments: list) -> list:
    """plan_lanes, but a lane that would decode through more than MIN_SEEK_GAP of cut-away footage
    starts again as a new input seeked to just before its next segment. A 5-minute take cut to
    45 s otherwise decodes the whole span between its first and last kept second. The largest gaps
    are split first, and only while the total stays within MAX_VIDEO_LANES. The lanes plan_lanes
    needs are all kept, so a reordered cut with more of them than the cap gets no added seeks and
    opens as many inputs as it does on main. Each piece is opened and trimmed the same way a reordered
    cut's lanes already are, so the frames it yields are the same."""
    lanes = plan_lanes(segments)
    gaps = []
    for li, lane in enumerate(lanes):
        idx = lane["segs"]
        for k in range(1, len(idx)):
            gap = segments[idx[k]].src_start - segments[idx[k - 1]].src_end
            if gap > MIN_SEEK_GAP:
                gaps.append((gap, li, k))
    gaps.sort(key=lambda g: -g[0])
    splits: dict = {}
    for _, li, k in gaps[:max(0, MAX_VIDEO_LANES - len(lanes))]:
        splits.setdefault(li, []).append(k)
    out = []
    for li, lane in enumerate(lanes):
        cuts = [0] + sorted(splits.get(li, [])) + [len(lane["segs"])]
        for a, b in zip(cuts, cuts[1:]):
            idx = lane["segs"][a:b]
            first = segments[idx[0]].src_start
            out.append({"source": lane["source"], "segs": idx, "first": first,
                        "last": segments[idx[-1]].src_end, "seek": _lane_seek(first)})
    return out


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
    # Version 3 handles audio EOF before trimming and fixes concat's sample format and layout.
    data = [3, [[s.source, round(s.src_start, 6), round(s.src_end, 6)] for s in segments],
            {k: st(v) for k, v in sorted(src_paths.items())}]
    if any(s.audio_lead or s.audio_tail for s in segments):
        data.append([[s.out_start, s.audio_lead, s.audio_tail] for s in segments])
    return hashlib.sha1(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()


def render_voice(ctx: RenderCtx, segments: list, src_paths: dict, out: Path, source_audio: dict) -> Path:
    """The cut voice, 48 kHz stereo wav: exactly the picture's segments, each padded to its planned length
    (a source with no sound, or sound that ends early, is silence there; multi-source). J/L joins mix source
    handles across an unchanged picture clock.
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
    overlap = any(s.audio_lead or s.audio_tail for s in segments)
    if overlap:
        segments = [Segment(s.source, s.src_start - s.audio_lead, s.src_end + s.audio_tail,
                            s.out_start - s.audio_lead) for s in segments]
    lanes = plan_lanes(segments)
    cmd = [ctx.ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error"]
    seg_input = {}
    chains, labels = [], []
    input_index = 0
    for li, lane in enumerate(lanes):
        source = lane["source"]
        bounds = source_audio[source]
        # Do not send an empty atrim into aresample/apad. Some ffmpeg builds cannot establish
        # its format at EOF, and fail when concat requests the first audio frame.
        audible = [si for si in lane["segs"] if bounds is not None
                   and segments[si].src_start < bounds[1] and segments[si].src_end > bounds[0]]
        if not audible:
            continue
        if lane["seek"] > 0:
            cmd += ["-ss", _f(lane["seek"])]
        cmd += ["-vn", "-i", str(src_paths[source])]
        n = len(audible)
        head = f"[{input_index}:a]"
        unknown_end = math.isinf(bounds[1])
        if unknown_end:
            # Some containers omit stream duration. Pad before atrim in that case, so a trim
            # beyond the unreported EOF still receives frames with a known audio format.
            head += ("aresample=48000:async=1:first_pts=0,"
                     "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                     f"apad=whole_dur={_f(lane['last'] - lane['seek'])},")
        if n > 1:
            chains.append(head + f"asplit={n}" + "".join(f"[A{li}s{si}]" for si in audible))
        elif unknown_end:
            chains.append(head + f"anull[A{li}s{audible[0]}]")
        for si in audible:
            seg_input[si] = (f"A{li}s{si}" if n > 1 or unknown_end else f"{input_index}:a", lane["seek"])
        input_index += 1
    fade = 0.006
    for i, seg in enumerate(segments):
        d = seg.src_end - seg.src_start
        f = min(fade, d / 4)
        samples = round(d * 48000)
        if i not in seg_input:
            chain = f"anullsrc=r=48000:cl=stereo:d={_f(d)},"
        else:
            pad, seek = seg_input[i]
            end = min(seg.src_end, source_audio[seg.source][1])
            # Preserve the source clock for late audio, then pad the real audio tail to the
            # planned clip length. Set the format before padding as well as before concat.
            chain = (f"[{pad}]atrim=start={_f(seg.src_start - seek)}:end={_f(end - seek)},"
                     f"asetpts=PTS-{_f(seg.src_start - seek)}/TB,aresample=48000:async=1:first_pts=0,"
                     f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                     f"apad=whole_dur={_f(d)},")
        chains.append(chain + f"atrim=end_sample={samples},asetpts=N/SR/TB,"
                      f"afade=t=in:d={_f(f)},afade=t=out:st={_f(max(0.0, d - f))}:d={_f(f)},"
                      f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
                      + (f",adelay={round(seg.out_start * 48000)}S:all=1" if overlap else "") + f"[a{i}]")
        labels.append(f"[a{i}]")
    if overlap:
        # Place rather than concat the handles: concat would lengthen the reel and
        # shift every later word. Fades remain local to each source's audio edges.
        chains.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0,"
                      f"apad=whole_dur={_f(ctx.duration)},atrim=duration={_f(ctx.duration)}[aout]")
    elif len(segments) == 1:
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


def normalize_voice(ctx: RenderCtx, voice: Path, out: Path, expected_silence: bool = False) -> Path:
    """Voice only (no music module): measured gain to -14 LUFS, then a peak limiter at ~-1.9 dBFS.
    loudnorm resamples to 192 kHz and costs ~7 s a pass; this is two fast decodes."""
    if expected_silence:
        return voice
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


def probe_source_audio(ctx: RenderCtx, segments: list, src_paths: dict) -> dict:
    """{source id: (start, end) of its audio stream in source seconds, or None with no audio stream}."""
    source_audio = {}
    for sid in sorted({seg.source for seg in segments}):
        probe = tools.text_run([ctx.ffprobe, "-v", "error", "-select_streams", "a:0",
                                "-show_entries", "stream=start_time,duration:format=start_time", "-of", "json", str(src_paths[sid])],
                               30, "audio probe")
        info = json.loads(probe.stdout)
        stream = next(iter(info.get("streams") or []), None)
        if stream is None:
            source_audio[sid] = None
        else:
            origin = float((info.get("format") or {}).get("start_time") or 0.0)
            start = float(stream.get("start_time") or origin) - origin
            # Unknown stream duration must not be replaced with the VIDEO duration.
            end = start + float(stream["duration"]) if stream.get("duration") else float("inf")
            source_audio[sid] = (start, end)
    return source_audio


def build_audio(ctx: RenderCtx, segments: list, src_paths: dict, rwork: Path, warnings: list) -> Path:
    source_audio = probe_source_audio(ctx, segments, src_paths)
    mcfg = ctx.project.get("music") or {}
    # Silence is intentional only when every kept source lacks audio and no music is requested.
    # An unexpectedly silent recording or failed music mix must still fail loudness verification.
    ctx.expected_silence = not any(source_audio.values()) and not (mcfg.get("enabled", True) and mcfg.get("track"))
    voice = render_voice(ctx, segments, src_paths, rwork / "voice.wav", source_audio)
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
    return normalize_voice(ctx, voice, rwork / "voice_norm.wav", expected_silence=ctx.expected_silence)


# --- video graph --------------------------------------------------------------------------------

def _frames_between(lo: float, hi: float, fps: float) -> tuple:
    """(first, last) output frames whose time FFmpeg's `between(t, lo, hi)` admits. Frame n's time is n
    times the time base the `fps` filter sets, the inverse of the rate it parses from `fps` (29.97 is
    2997/100), as a double; comparing those exactly needs no tolerance."""
    rate = Fraction(fps).limit_denominator(1001000)
    step = rate.denominator / rate.numerator
    first = max(0, math.floor(lo / step) - 1)
    while first * step < lo:
        first += 1
    last = math.floor(hi / step) + 1
    while last >= 0 and last * step > hi:
        last -= 1
    return first, last


def _layer_chain(idx: int, layer: Layer, f: float, fps: float, t_shift: float, dur: float,
                 video_dur: Optional[float] = None):
    """(chain, x, y, t0, t1, seek, lead) for one overlay layer, or None when it falls outside the render.

    `seek` is where to start reading a video layer's input, `lead` how many seconds of it the chain
    reads and trims before the render's first frame. `video_dur` is the whole video's length: a window
    or still (any render but the full one) draws each layer frame the full render draws at that moment,
    with the same fade, counted in frames as the full render counts them."""
    full_render = t_shift == 0 and (video_dur is None or abs(dur - video_dur) < 1e-6)
    t0, t1 = layer.t0 - t_shift, layer.t1 - t_shift
    if full_render and (t1 <= 0 or t0 >= dur or t1 - t0 < 1e-3):
        return None
    skip = max(0.0, -t0)
    t0 = max(0.0, t0)
    t1 = min(dur, t1)
    if not full_render:
        # The output frames the full render's enable (below) admits, moved onto this window's frames.
        vd = layer.t1 if video_dur is None else video_dur
        c0, c1 = max(0.0, layer.t0), min(layer.t1, vd)
        if c1 <= 0 or c0 >= vd or layer.t1 - layer.t0 < 1e-3:
            return None
        k0 = round(t_shift * fps)                              # as the caption track maps a window
        first, last = _frames_between(float(_f(c0)), float(_f(c1)), fps)
        first, last = first - k0, last - k0
        if last < 0 or first > round(dur * fps) - 1 or last < first:
            return None
        # enable at half-frame midpoints: it admits exactly those frames, whatever the rounding
        t0, t1 = max(0.0, (first - 0.5) / fps), (last + 0.5) / fps
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
    if full_render:
        span = t1 - t0
        if layer.fade_in > 0 and skip <= 0:
            parts.append(f"fade=t=in:st=0:d={_f(min(layer.fade_in, span / 2))}:alpha=1")
        if layer.fade_out > 0 and layer.t1 - t_shift <= dur + 1e-6:
            fo = min(layer.fade_out, span / 2)
            parts.append(f"fade=t=out:st={_f(max(0.0, span - fo))}:d={_f(fo)}:alpha=1")
        pad, seek, trim = None, skip, 0
    else:
        # What the full render draws: the layer's input seeked past the video's start, `pad` transparent
        # frames (tpad rounds its duration to the nearest frame), then layer frame j at output frame
        # pad + j with its fades timed from frame 0. Output frame k0 starts this window.
        span = c1 - c0
        fi = min(layer.fade_in, span / 2) if layer.fade_in > 0 and layer.t0 >= 0 else 0.0
        fo = min(layer.fade_out, span / 2) if layer.fade_out > 0 and layer.t1 <= vd + 1e-6 else 0.0
        pad_full = math.floor(float(_f(c0)) * fps + 0.5) if c0 > 0 else 0
        j0 = k0 - pad_full                                     # the layer frame at this window's frame 0
        if j0 < 0 or layer.kind == "image":
            js = 0                                             # an image input can't be seeked
        elif fi > 0 and j0 < fi * fps:
            js = 0                                             # inside the fade-in: read from its start
        elif fo > 0 and j0 > (span - fo) * fps:
            js = math.floor((span - fo) * fps)                 # inside the fade-out: from where it began
        else:
            js = j0
        if fi > 0 and js == 0:
            parts.append(f"fade=t=in:st=0:d={_f(fi)}:alpha=1")
        if fo > 0:
            parts.append(f"fade=t=out:st={_f(span - fo - js / fps)}:d={_f(fo)}:alpha=1")
        trim = max(0, j0 - js)
        if trim:
            parts.append(f"trim=start_frame={trim}")
        pad, seek = max(0, -j0), max(0.0, -layer.t0) + js / fps
    # Start the layer at t0 with transparent padding frames, NOT by shifting its timestamps: overlay
    # waits for the first frame of each input, so a layer whose first frame is at 66 s made ffmpeg
    # queue every main frame before it (GBs of full-resolution frames on a long take, and a render
    # 5-10x slower). The overlay's `enable` window still decides when it shows.
    parts.append("setpts=PTS-STARTPTS")
    if pad is None and t0 > 0:
        parts.append(f"fps={fps},tpad=start_duration={_f(t0)}:color=0x00000000")   # tpad needs the fps timebase
    elif pad:
        parts.append(f"fps={fps},tpad=start={pad}:color=0x00000000")
    return ",".join(parts), int(round(x)), int(round(y)), t0, t1, seek, trim / fps


def _zoom_frames(z: ZoomSpan, fps: float, video_dur: float) -> Optional[tuple]:
    """[first, end) frames of the full video a zoom punches in on: those starting in [t0, t1). A window or a
    chunk zooms these same frames, counted on its own (video_graph)."""
    if z.scale <= 1.001:
        return None
    first = max(0, int(math.ceil(z.t0 * fps - 1e-6)))
    end = min(int(round(video_dur * fps)), int(math.ceil(z.t1 * fps - 1e-6)))
    return (first, end) if end > first else None


SHUTTER = 0.5        # of a frame: the film camera's 180-degree shutter
TAP_PX = 2.0         # blur taps at most this far apart at the corner farthest from the zoom's fixed point
MAX_DOUBLINGS = 4    # 16 taps: 8 left visible bands on hard edges in the fastest frame


def _snap_chain(zi: int, z: ZoomSpan, k0: int, k1: int, crop: tuple, scale_chain: str, fps: float,
                t_shift: float, out_w: int, out_h: int, draft: bool, tag: str = "z") -> list:
    """Chains turning [zs<zi>] (the base) into [zz<zi>]: output frames k0..k1-1 of snap zoom z. Every
    label starts with `tag` ("z" for the footage, "q" for the speaker's matte, which moves with it).

    Each frame crops the base to a rectangle between the full frame and the hold's crop, all sharing
    one fixed point, so the picture grows out of that point like a camera punch-in. While the scale
    moves, a frame averages 2^d taps spread across its shutter time, a radial blur as long as the
    zoom's speed: the smallest-scale tap, then d passes that each average the image with a copy of
    itself zoomed in about the fixed point (zooming in never needs pixels outside the frame). Held
    frames use the plain crop and scale, unblurred."""
    from .zoom import progress
    k_shift = round(t_shift * fps)      # frame k here is the full video's frame k + k_shift (video_graph)
    cw, ch, x, y = crop
    s_end = out_w / cw
    fx, fy = x / (1 - cw / out_w), y / (1 - ch / out_h)
    reach = max(math.hypot(cx - fx, cy - fy) for cx in (0, out_w) for cy in (0, out_h))

    def scale(k, u):    # the zoom's scale u of the way through frame k's shutter
        return 1 + (s_end - 1) * progress(z, (k + k_shift) / fps + u * SHUTTER / fps, fps)

    def shutter(k):     # (doublings, smallest tap's scale, scale ratio between taps); None = held
        a, b = scale(k, 0), scale(k, 1)
        if min(a, b) >= s_end - 1e-9:
            return None
        d = min(MAX_DOUBLINGS, max(0, math.ceil(math.log2(reach * (max(a, b) / min(a, b) - 1) / TAP_PX + 1))))
        n = 1 << d
        lo, hi = sorted((scale(k, 0.5 / n), scale(k, 1 - 0.5 / n)))
        return d, lo, (hi / lo) ** (1 / (n - 1)) if n > 1 else 1.0

    runs = []       # [doublings, first frame, end frame, [(lo, ratio) per frame]]
    for k in range(k0, k1):
        sh = shutter(k)
        d = None if sh is None else sh[0]
        if runs and runs[-1][0] == d:
            runs[-1][2] = k + 1
        else:
            runs.append([d, k, k + 1, []])
        if sh:
            runs[-1][3].append(sh[1:])

    def warp(vals, left, top, right, bottom, interp):
        """perspective onto the source rectangle whose edges are e0 + e1 * vals[frame]."""
        expr = f"{vals[-1]:.6f}"
        for i in range(len(vals) - 2, -1, -1):      # perspective numbers its frames from 1
            expr = f"if(eq(in,{i + 1}),{vals[i]:.6f},{expr})"
        le, ri, to, bo = (f"'{e0}+{e1}*{expr}'" for e0, e1 in (left, right, top, bottom))
        return (f"perspective=x0={le}:y0={to}:x1={ri}:y1={to}:x2={le}:y2={bo}:x3={ri}:y3={bo}:"
                f"sense=source:eval=frame:interpolation={interp}")

    chains, labels = [f"[{tag}s{zi}]split={len(runs)}" + "".join(f"[{tag}s{zi}r{ri}]" for ri in range(len(runs)))], []
    for ri, (d, a, b, rows) in enumerate(runs):
        chain = f"[{tag}s{zi}r{ri}]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS"
        if d is None:
            held = scale_chain if draft else scale_chain.replace(f"crop={cw}:{ch}:{x}:{y}",
                                                               f"crop={cw}:{ch}:{x}:{y}:exact=1")
            chains.append(f"{chain},{held}[{tag}r{zi}r{ri}]")
            labels.append(f"[{tag}r{zi}r{ri}]")
            continue
        q = [(1 - 1 / lo) / (1 - 1 / s_end) for lo, _ in rows]
        # scale maps pixel centres; perspective maps coordinates directly. Match
        # that half-pixel convention and keep the held crop's exact luma origin
        # so entering/leaving the hold cannot introduce a one-pixel reversal.
        dx = 0 if draft else (cw / out_w - 1) / 2
        dy = 0 if draft else (ch / out_h - 1) / 2
        chain += "," + warp(q, (0, x + dx), (0, y + dy),
                            (out_w, x + cw - out_w + dx), (out_h, y + ch - out_h + dy),
                            "linear" if draft else "cubic")
        for j in range(d):
            v = [1 - r ** -(1 << j) for _, r in rows]
            p = f"{tag}d{zi}r{ri}p{j}"
            chains.append(f"{chain},split=2[{p}a][{p}b]")
            chains.append(f"[{p}b]" + warp(v, (0, fx), (0, fy), (out_w, fx - out_w), (out_h, fy - out_h),
                                       "linear" if draft else "cubic")
                          + f"[{p}z]")
            chain = f"[{p}a][{p}z]mix=inputs=2"
        chains.append(f"{chain}[{tag}r{zi}r{ri}]")
        labels.append(f"[{tag}r{zi}r{ri}]")
    pad = f",tpad=start={k0}" if k0 > 0 else ""
    chains.append("".join(labels) + f"concat=n={len(runs)}:v=1:a=0,setpts=N/({fps}*TB),fps={fps}{pad}[{tag}z{zi}]")
    return chains


def _ramp_chain(zi: int, z: ZoomSpan, k0: int, k1: int, crop: tuple, fps: float,
                t_shift: float, out_w: int, out_h: int, draft: bool, tag: str = "z") -> str:
    # FFmpeg 7.1.1 ignores crop size commands. Drafts use zoompan; finals need
    # fractional source coordinates because zoompan rounds size and origin
    # separately, reversing slow motion by more than a pixel in rendered tests.
    cw, ch, x, y = crop
    k_shift = round(t_shift * fps)      # frame k here is the full video's frame k + k_shift (video_graph)

    def zoom_scale(frame0: int) -> str:
        # perspective counts its first input as 1, whereas zoompan uses PTS.
        clock = "in_time" if draft else f"(in-1)/{_f(fps)}"
        t = f"({clock}+{_f((frame0 + k_shift) / fps)})"

        def ramp(start: float, frames: int) -> str:
            u = f"clip(({t}-{_f(start)})/{_f(frames / fps)},0,1)"
            return f"pow(1-{u},4)"

        amount = ramp(z.t1 - z.ramp_out / fps, z.ramp_out) if z.ramp_out else "1"
        if z.ramp_in:
            amount = (f"if(lt({t},{_f(z.t0 + z.ramp_in / fps)}),"
                      f"1-{ramp(z.t0, z.ramp_in)},{amount})")
        return f"(1+{_f(out_w / cw - 1)}*{amount})"

    pad = f",tpad=start={k0}" if k0 else ""
    if draft:
        crop_x = f"(iw-iw/zoom)*{_f(x / (out_w - cw))}"
        crop_y = f"(ih-ih/zoom)*{_f(y / (out_h - ch))}"
        return (f"[{tag}s{zi}]trim=start_frame={k0}:end_frame={k1},setpts=PTS-STARTPTS,"
                f"zoompan=z='{zoom_scale(k0)}':x='{crop_x}':y='{crop_y}':"
                f"d=1:s={out_w}x{out_h}:fps={fps},setsar=1{pad}[{tag}z{zi}]")

    # Use the ordinary scaler during a hold. Only moving frames pay for the
    # fractional warp; a full-length drift remains one moving run.
    runs = []
    for k in range(k0, k1):
        t = (k + k_shift) / fps
        moving = ((z.ramp_in and t < z.t0 + z.ramp_in / fps) or
                  (z.ramp_out and t > z.t1 - z.ramp_out / fps))
        if runs and runs[-1][0] == bool(moving):
            runs[-1][2] = k + 1
        else:
            runs.append([bool(moving), k, k + 1])

    chains = [f"[{tag}s{zi}]split={len(runs)}" + "".join(f"[{tag}p{zi}r{ri}]" for ri in range(len(runs)))]
    labels = []
    for ri, (moving, a, b) in enumerate(runs):
        head = f"[{tag}p{zi}r{ri}]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS,"
        if moving:
            q = f"((1-1/{zoom_scale(a)})/(1-{_f(cw / out_w)}))"
            # Match scale's pixel-centre convention and the exact held crop.
            dx, dy = (cw / out_w - 1) / 2, (ch / out_h - 1) / 2
            left, top = f"{_f(x + dx)}*{q}", f"{_f(y + dy)}*{q}"
            right = f"{out_w}+{_f(x + cw - out_w + dx)}*{q}"
            bottom = f"{out_h}+{_f(y + ch - out_h + dy)}*{q}"
            motion = (f"perspective=x0='{left}':y0='{top}':x1='{right}':y1='{top}':"
                      f"x2='{left}':y2='{bottom}':x3='{right}':y3='{bottom}':"
                      "sense=source:eval=frame:interpolation=cubic")
        else:
            motion = f"crop={cw}:{ch}:{x}:{y}:exact=1,scale={out_w}:{out_h}:flags=lanczos"
        label = f"[{tag}r{zi}p{ri}]"
        chains.append(f"{head}{motion},setsar=1{label}")
        labels.append(label)
    chains.append("".join(labels) + f"concat=n={len(runs)}:v=1:a=0,setpts=N/({fps}*TB),fps={fps}{pad}[{tag}z{zi}]")
    return ";\n".join(chains)


def build_video_cmd(ctx: RenderCtx, segments: list, src_meta: dict, src_paths: dict, faces: dict,
                    out_w: int, out_h: int, layers: list, zooms: list, ass_name: Optional[str],
                    audio: Optional[Path], audio_seek: float, dur: float, t_shift: float, encoder: Optional[str],
                    out_part: Path, graph_file: Path, fast: bool = True) -> list:
    """The draft/final ffmpeg command; writes the filter graph to `graph_file`. fast=False is the
    draft path from before hardware decode: no -hwaccel, and an HDR source tonemapped before the
    crop and scale. render.run retries a failed draft that way. Finals always decode in software.
    audio=None is a still (stills()): one PNG frame, with no sound and no encoder."""
    fps = float(ctx.fmt.get("fps") or 30)
    cmd, chains, k = video_graph(ctx, segments, src_meta, src_paths, faces, out_w, out_h, layers, zooms, ass_name,
                                 dur, t_shift, encoder, fast)
    write_graph(chains, graph_file)
    if audio is None:       # a still (stills()): the one frame as a PNG, with no sound and no encode
        return cmd + [*tools.filter_script_args(graph_file.name), "-map", "[vout]", "-frames:v", "1",
                      "-c:v", "png", "-f", "image2", "-update", "1", str(out_part)]
    if audio_seek > 0:
        cmd += ["-ss", _f(audio_seek)]
    cmd += ["-t", _f(dur + 0.05), "-i", str(audio)]
    audio_idx = k
    cmd += [*tools.filter_script_args(graph_file.name), "-map", "[vout]", "-map", f"{audio_idx}:a",
            "-af", "apad"]
    cmd += encoder_args(encoder, ctx.draft, fps)
    cmd += ["-r", _f(fps), *AUDIO_ARGS,
            "-t", _f(dur), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats",
            "-f", "mp4", str(out_part)]
    return cmd


AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]


def write_graph(chains: list, graph_file: Path) -> None:
    with open(graph_file, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(";\n".join(chains))


def video_graph(ctx: RenderCtx, segments: list, src_meta: dict, src_paths: dict, faces: dict,
                out_w: int, out_h: int, layers: list, zooms: list, ass_name: Optional[str],
                dur: float, t_shift: float, encoder: Optional[str] = None, fast: bool = True) -> tuple:
    """(command up to and with its inputs, filter chains ending in [vout], the next input's index) for the
    picture of output seconds [t_shift, t_shift + dur): the whole video, a window, a chunk or a still. A
    window or chunk draws the frames the whole video draws there (zooms, layers, mattes and captions are
    placed on the full video's frame clock), which chunked_video relies on."""
    fps = float(ctx.fmt.get("fps") or 30)
    f = out_w / float(ctx.fmt.get("width") or out_w)
    lanes = video_lanes(segments)
    cmd = [ctx.ffmpeg, "-y", "-nostdin", "-hide_banner"]
    fast = ctx.draft and fast
    cuda = fast and tools.hwaccel() == "cuda" and "scale_cuda" in tools.filters()

    def on_cuda(src: dict) -> bool:     # decode and scale on an NVIDIA GPU; needs an FFmpeg with scale_cuda
        return cuda and not src.get("hdr")

    mem_dec = []
    if fast and not all(on_cuda(src_meta[lane["source"]]) for lane in lanes):
        devices, mem_dec = tools.hwaccel_to_memory(encoder)
        cmd += devices                         # global options: once, before the first input
    seg_input, seg_chain = {}, {}
    chains, labels = [], []
    for li, lane in enumerate(lanes):
        src = src_meta[lane["source"]]
        face = faces.get(lane["source"])
        hdr = bool(src.get("hdr"))
        if on_cuda(src):
            cmd += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
            pre, per_seg = gpu_reframe(src, out_w, out_h, face)
        else:
            cmd += mem_dec
            pre = None
            reframe = reframe_filter(src, out_w, out_h, face, ctx.draft)
            if hdr and "zscale" in tools.filters():
                # A fast draft tonemaps the cropped, scaled frame (540x960, 1/16 of a 4K one); the
                # result is within PSNR 43 dB of tonemapping first (frame 60 of the 4K HLG stand-in,
                # Windows 11). Finals and the retry keep tonemap-then-scale: finals so their bytes
                # don't change, the retry because zscale reads colour matrices `scale` refuses (ICtCp).
                per_seg = (reframe + "," + HDR_CHAIN if fast
                           else HDR_CHAIN + "," + reframe + ",format=yuv420p")
            else:
                per_seg = reframe + ",format=yuv420p"
        cmd += no_rotate_args(src)
        # A preview copy's clock runs `inputOffset` behind the original's (proxy.py: it has no
        # sound that starts before the picture). Seek on its own clock and shift what is left, so its
        # frames reach the trims below at the original's times; for an original both are as before.
        off = float(src.get("inputOffset") or 0.0)
        seek_in = max(0.0, lane["seek"] - off)
        if seek_in > 0:
            cmd += ["-ss", _f(seek_in)]
        if seek_in + off - lane["seek"] > 1e-9:
            cmd += ["-itsoffset", _f(seek_in + off - lane["seek"])]
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
    exposure = float(ctx.project.get("exposure", 1.0))
    if exposure != 1.0:
        chains.append(f"[{cur}]exposure=exposure={_f(math.log2(exposure))}[exposed]")
        cur = "exposed"
    # The speaker cut out for words behind them ("matte" layers, segment.py): each matte clip is padded
    # to the whole render on the base's frame grid, so the zoom chains below move it exactly as they
    # move the footage, frame for frame.
    mattes, drawn = [], []
    for layer in layers or []:
        (mattes if layer.kind == "matte" else drawn).append(layer)
    layer_inputs, k, qcur = [], n_in, None
    for mi, layer in enumerate(mattes):
        t0, t1 = layer.t0 - t_shift, layer.t1 - t_shift
        if t1 <= 0 or t0 >= dur:
            continue
        layer_inputs += ["-i", str(layer.path)]
        # the clip's frame j is the full render's frame ceil(t0 * fps) + j (segment.matte_clip); a window
        # starting inside it drops whole frames, so the cut-out stays on the frame it was made for
        first = int(math.ceil(layer.t0 * fps - 1e-6)) - int(round(t_shift * fps))
        drop = f"trim=start_frame={-first},setpts=PTS-STARTPTS," if first < 0 else ""
        chains.append(f"[{k}:v]setpts=PTS-STARTPTS,fps={fps},{drop}format=gray,scale={out_w}:{out_h},"
                      f"tpad=start={max(0, first)}:stop=-1:stop_mode=add:color=black,trim=end_frame={n_frames}[qm{mi}]")
        if qcur is None:
            qcur = f"qm{mi}"
        else:
            chains.append(f"[{qcur}][qm{mi}]blend=all_mode=lighten[qb{mi}]")
            qcur = f"qb{mi}"
        k += 1

    k_shift = round(t_shift * fps)

    def zoom_lane(cur: str, tag: str) -> str:
        """The zoom chains on `cur`; labels start with `tag`. Returns the zoomed label."""
        for zi, z in enumerate(zooms or []):
            span = _zoom_frames(z, fps, max(ctx.duration or 0.0, t_shift + dur))   # the whole video's length
            if span is None:
                continue
            # counted in frames of the full video: frame k here is its frame k + k_shift, as the caption track
            # maps a window, so a window or a chunk (chunked_video) zooms exactly the frames the full render does
            k0, k1 = max(0, span[0] - k_shift), min(n_frames, span[1] - k_shift)
            if k1 <= k0:
                continue
            cw = int(round(out_w / z.scale / 2)) * 2
            ch = int(round(out_h / z.scale / 2)) * 2
            cx, cy = z.cx * f, z.cy * f
            x = int(min(max(0, cx - cw / 2), out_w - cw))
            y = int(min(max(0, cy - ch / 2), out_h - ch))
            chains.append(f"[{cur}]split=2[{tag}m{zi}][{tag}s{zi}]")
            # padded from 0 (see _layer_chain): the overlay never waits for the zoom's first frame. The trim and
            # the padding count frames, and `enable` sits on half-frame midpoints, so all three agree on exactly
            # frames k0..k1-1 whatever the rounding of their times.
            pad = f",fps={fps},tpad=start={k0}" if k0 > 0 else ""
            scale_chain = (f"crop={cw}:{ch}:{x}:{y},scale={out_w}:{out_h}:flags={'fast_bilinear' if ctx.draft else 'lanczos'},"
                           f"setsar=1")
            # a crop rounded to the full width or height has no fixed point to grow from
            if (z.ramp_in or z.ramp_out) and cw < out_w and ch < out_h:
                if z.blur:
                    chains.extend(_snap_chain(zi, z, k0, k1, (cw, ch, x, y), scale_chain, fps, t_shift, out_w, out_h,
                                              ctx.draft, tag))
                else:
                    chains.append(_ramp_chain(zi, z, k0, k1, (cw, ch, x, y), fps, t_shift, out_w, out_h, ctx.draft, tag))
            else:
                chains.append(f"[{tag}s{zi}]trim=start_frame={k0}:end_frame={k1},setpts=PTS-STARTPTS,{scale_chain}{pad}[{tag}z{zi}]")
            chains.append(f"[{tag}m{zi}][{tag}z{zi}]overlay=0:0:eof_action=pass:repeatlast=0:"
                          f"enable='between(t,{_f(max(0.0, (k0 - 0.5) / fps))},{_f((k1 - 0.5) / fps)})'[{tag}b{zi}]")
            cur = f"{tag}b{zi}"
        return cur

    # zooms move the FOOTAGE, so they sit on the base, under every card and caption
    cur = zoom_lane(cur, "z")
    people = []
    if qcur is not None:
        # the matte's grey may arrive in either range after the zoom filters' conversions: anything
        # near black is background, near white is the speaker
        qcur = zoom_lane(qcur, "q")
        chains.append(f"[{cur}]split=2[qbase][qfg]")
        chains.append(f"[{qcur}]format=gray,lut=c0='clip((val-24)*255/208,0,255)'[qa]")
        live = [m for m in mattes if m.t1 - t_shift > 0 and m.t0 - t_shift < dur]
        chains.append("[qfg][qa]alphamerge" + (f",split={len(live)}" if len(live) > 1 else "")
                      + "".join(f"[qp{j}]" for j in range(len(live))))
        people = [(m, f"qp{j}") for j, m in enumerate(live)]
        cur = "qbase"
    # overlay layers, lowest z first; a speaker cut-out draws at its own z, above its words
    order = sorted([(l.z, l.t0, i, l, None) for i, l in enumerate(drawn)] +
                   [(m.z, m.t0, len(drawn) + j, m, lab) for j, (m, lab) in enumerate(people)], key=lambda r: r[:3])
    for li, (_z, _t, _i, layer, person) in enumerate(order):
        if person is not None:
            t0, t1 = max(0.0, layer.t0 - t_shift), min(dur, layer.t1 - t_shift)
            chains.append(f"[{cur}][{person}]overlay=0:0:eof_action=pass:repeatlast=0:"
                          f"enable='between(t,{_f(t0)},{_f(t1)})'[o{li}]")
            cur = f"o{li}"
            continue
        lc = _layer_chain(li, layer, f, fps, t_shift, dur, ctx.duration)
        if lc is None:
            continue
        chain, x, y, t0, t1, seek, lead = lc
        span = lead + t1 - t0 + 0.1
        p = Path(layer.path)
        if layer.kind == "image":
            layer_inputs += ["-loop", "1", "-framerate", _f(fps), "-t", _f(span), "-i", str(p)]
        else:
            if seek > 0:
                layer_inputs += ["-ss", _f(seek)]
            layer_inputs += ["-t", _f(span), "-i", str(p)]
        chains.append(f"[{k}:v]{chain}[l{li}]")
        chains.append(f"[{cur}][l{li}]overlay={x}:{y}:eof_action=pass:repeatlast=0:"
                      f"enable='between(t,{_f(t0)},{_f(t1)})'[o{li}]")
        cur = f"o{li}"
        k += 1
    if ass_name:
        # The caption track is timed on the full video's clock. Each segment is trimmed to the nearest
        # frame, so a window's frame k is the full render's frame round(t_shift * fps) + k: the track is
        # read at that frame's timestamp (the stream is on the 1/fps base the `fps` filter set), which
        # gives libass the same millisecond the full render gives it, then the frame gets its own back.
        to_full = from_full = ""
        if t_shift > 0:
            k0 = round(t_shift * fps)
            to_full, from_full = f"setpts=PTS+{k0},", f",setpts=PTS-{k0}"
        chains.append(f"[{cur}]{to_full}subtitles=filename={ass_name}:fontsdir=fonts{from_full}[capd]")
        cur = "capd"
    chains.append(f"[{cur}]format=yuv420p[vout]")
    return cmd + layer_inputs, chains, k


# Final x264 preset. Instagram re-encodes every upload, so the export only has to be a clean master (CRF 18
# then, a constant QP 18 since chunked finals, #184). Measured on a 1:34 take (status/wire.md): encode 30-41 s vs `medium` 88-100 s, file 53.6 MB vs
# 64.6 MB, SSIM 0.993 against the `medium` file (`faster`: 45-48 s, 64.3 MB, the same SSIM). Same bytes
# per project still holds (software encoder, fixed args).
FINAL_PRESET = "veryfast"
FINAL_QP = 18
X264_THREADS = 8


def encoder_args(encoder: str, draft: bool, fps: float) -> list:
    tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-color_range", "tv"]
    if encoder in tools.HW_ENCODER_OPTS:
        return (["-c:v", encoder] + tools.HW_ENCODER_OPTS[encoder]
                + ["-pix_fmt", tools.HW_ENCODER_PIX_FMT.get(encoder, "yuv420p")] + tags)
    if draft:
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p"] + tags
    # A keyframe every second: the player seeks by decoding from the keyframe before the target, and x264's
    # default allows 250 frames between them (over 8 s at 30 fps). Measured on 60 s reels, files grew 5-9%.
    # A chunked final (chunked_video) is joined from chunks each encoded alone, so nothing may carry across a
    # keyframe: a constant QP (CRF's rate control carries frame complexity over; 180 of 240 frames differed
    # chunked), a closed GOP with no scene-cut keyframes, and a fixed thread count (x264's frame threads change
    # its decisions). #184 measured QP 18 at CRF 18's PSNR with a smaller file on synthetic takes; real phone
    # takes are unmeasured.
    gop = str(round(fps))
    return ["-c:v", "libx264", "-preset", FINAL_PRESET, "-qp", str(FINAL_QP), "-profile:v", "high",
            "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-flags", "+cgop", "-threads", str(X264_THREADS),
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
    from .variation import resolve
    effective, decisions = resolve(proj, tl)
    if decisions is None:
        effective = proj
    # Seeded offsets must reach the audio planner, not only the render metadata.
    resolved_tl = projmod.timeline(project_dir, effective, tl.words, root=root)
    tl.segments[:] = resolved_tl.segments
    def _progress(stage, pct, message):
        progress(stage or STAGE, pct, message)

    return RenderCtx(project=effective, variation=decisions, project_dir=project_dir, root=root, out_timeline=tl.segments,
                     word_out_time=tl.word_out_time, duration=tl.duration, fmt=dict(proj["format"]),
                     draft=draft, work=project_dir / "work", ffmpeg=tools.ffmpeg(),
                     ffprobe=tools.ffprobe(), progress=_progress, word_out_end=tl.word_out_end, is_kept=tl.is_kept,
                     words=tl.words, src_to_out=tl.src_to_out)


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
        if "source" in anc:
            continue
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


def read_broll_report(items: list) -> list:
    """Per b-roll item, from the layers.json items this render's build_layers wrote: how it was
    actually shown. Items that could not be shown as asked carry `fallback` (and `shownAs`) or
    `skipped`, in plain words the editor can repeat to the user ("no room on the left of the face;
    shown above you instead")."""
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


def mix_measured(audio: Path) -> Optional[dict]:
    """The mix report beside the audio this render used (music.build_audio), or None when it is missing.
    The voice-only fallback (no music module, or the mix failed) has no music in it."""
    audio = Path(audio)
    if not audio.name.startswith("mix-"):
        return {"music": None}
    try:
        return json.loads(audio.with_suffix(".json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_rules(path: Optional[str]) -> Optional[tuple]:
    """`--rules`: the rules file (rule_checks.py), parsed strictly before any work starts."""
    if path is None:
        return None
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise EngineError("BAD_RULE", f"rules file: {exc}", "I couldn't read your My style rules. Please try again.") from None
    return rule_checks.parse_rules(text)


def font_check(err: str, font_path, warnings: list) -> None:
    """Stop on captions drawn in another font (libass's fontselect lines in `err`); warn when libass said nothing."""
    bad = check_fontselect(err, Path(font_path))
    if bad:
        raise EngineError("FONT_SUBSTITUTED", f"libass used a different font: {bad}",
                          "Your captions came out in the wrong font, so I stopped. Please "
                          "reinstall Reel Studio.")
    if "fontselect:" not in err:
        warnings.append("libass did not report its font choice; caption font unverified")


def _chunk_window(segments: list, duration: float, f0: int, f1: int, n_frames: int, fps: float) -> tuple:
    """(segments, dur, t_shift) for output frames [f0, f1); the whole cut's own when that is all of it."""
    if f0 == 0 and f1 == n_frames:
        return segments, duration, 0.0
    return cutmod.window_segments(segments, f0 / fps, f1 / fps), (f1 - f0) / fps, f0 / fps


def chunked_video(ctx: RenderCtx, tl, segments: list, src_meta: dict, src_paths: dict, faces: dict, layers: list,
                  zooms: list, ass_name: Optional[str], font_path, audio: Path, out_part: Path, rwork: Path, on_pct,
                  warnings: list) -> Optional[dict]:
    """A final export as a row of cached ~2 s chunks (chunks.py). Chunks with no file under their key are encoded,
    one FFmpeg pass per run of consecutive missing chunks, each chunk by an encoder of its own; then every chunk is
    joined by the concat demuxer, copying the picture, and the sound is encoded whole beside it as the single pass
    encodes it. `segments` is the picture's timeline (a camera choice included, use_angles).
    -> {total, encoded: [indices of the chunks encoded]}, or None when a take's frames are unevenly spaced
    (chunks.even_frames) or its frame rate is not the project's: that final is rendered in one pass."""
    cache = chunkmod.Cache(rwork / chunkmod.DIR)
    timing = cache.dir / "frame-timing.json"
    takes = {seg.source for seg in segments}
    fps = float(ctx.fmt["fps"])
    # A take at another rate than the project's is resampled by the `fps` filter, whose rounding phase is set by
    # where the graph starts: a chunk drawn alone picks other source frames than the same chunk drawn inside a
    # longer run (Astra engine review 1: 4 frames differed before encoding, 24 fps into 30). Nothing yet keeps the
    # whole timeline's phase in a chunk, so such a final is rendered in one pass.
    if any(abs(float(src_meta[sid].get("fps") or 0.0) - fps) > 1e-3 for sid in takes):
        log("# a take's frame rate differs from the project's: the final is rendered in one pass")
        return None
    known: dict = {}       # each file's content hash, taken once for this export (chunks.command_identity)
    if not all(chunkmod.even_frames(ctx.ffprobe, src_paths[sid], timing, known) for sid in takes):
        log("# a take's frames are unevenly spaced: the final is rendered in one pass")
        return None
    W, H = int(ctx.fmt["width"]), int(ctx.fmt["height"])
    n_frames = max(1, int(round(tl.duration * fps)))
    spans = chunkmod.plan(n_frames, fps)
    enc = encoder_args("libx264", False, fps)
    ass = (rwork / ass_name).read_text(encoding="utf-8") if ass_name else None
    font = chunkmod.file_identity(font_path) if font_path else None
    build = chunkmod.ffmpeg_build(ctx.ffmpeg)

    def picture(f0: int, f1: int) -> tuple:
        segs, dur, shift = _chunk_window(segments, tl.duration, f0, f1, n_frames, fps)
        cmd, chains, _ = video_graph(ctx, segs, src_meta, src_paths, faces, W, H, layers, zooms, ass_name, dur, shift,
                                     "libx264", False)
        return cmd, chains, dur, shift

    keys = []
    for f0, f1 in spans:
        cmd, chains, dur, shift = picture(f0, f1)
        keys.append(chunkmod.chunk_key({
            "ffmpeg": build, "frames": f1 - f0, "command": chunkmod.command_identity(cmd, rwork, known),
            "graph": chains, "encoder": enc, "font": font,
            "captions": chunkmod.caption_events(ass, shift, shift + dur) if ass else None}))
    missing = [i for i, key in enumerate(keys) if not cache.has(key)]
    todo = sum(spans[i][1] - spans[i][0] for i in missing)
    made_dir, graph = cache.dir / "new", rwork / "graph_chunk.txt"
    done = 0
    for run in chunkmod.runs(missing, chunkmod.ENCODERS_PER_PASS):
        # One pass draws the run's frames; each chunk gets its own encoder, which starts fresh on the chunk's first
        # frame (chunks.py), so how runs are split never changes a chunk. The first output only counts frames.
        f0, f1 = spans[run[0]][0], spans[run[-1]][1]
        cmd, chains, dur, shift = picture(f0, f1)
        chains.append(f"[vout]split={len(run) + 1}[count]" + "".join(f"[c{j}]" for j in range(len(run))))
        for j, i in enumerate(run):
            a, b = spans[i][0] - f0, spans[i][1] - f0
            chains.append(f"[c{j}]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS[p{j}]")
        write_graph(chains, graph)
        shutil.rmtree(made_dir, ignore_errors=True)
        made_dir.mkdir()
        cmd += [*tools.filter_script_args(graph.name), "-progress", "pipe:1", "-nostats",
                "-map", "[count]", "-f", "null", "-"]
        for j in range(len(run)):
            cmd += ["-map", f"[p{j}]", *enc, "-r", _f(fps), "-f", "mp4", str(made_dir / f"{j:05d}.mp4")]

        def run_pct(p, base=done, frames=f1 - f0):
            on_pct(90 * (base + frames * p / 100) / todo)
        err = tools.ffmpeg_progress(cmd, dur, run_pct, timeout=max(600, dur * 40), what="chunk render", cwd=rwork,
                                    frames=f1 - f0)
        if font_path is not None and chunkmod.caption_events(ass, shift, shift + dur)[1]:
            font_check(err, font_path, warnings)
        for j, i in enumerate(run):
            cache.put(made_dir / f"{j:05d}.mp4", keys[i])
        done += f1 - f0
    shutil.rmtree(made_dir, ignore_errors=True)

    listing = chunkmod.concat_list([cache.path(key).name for key in keys], cache.dir / "export.ffconcat")
    dur = tl.duration
    cmd = [ctx.ffmpeg, "-y", "-nostdin", "-hide_banner", "-f", "concat", "-i", str(listing),
           "-t", _f(dur + 0.05), "-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "apad",
           *AUDIO_ARGS, "-t", _f(dur), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats",
           "-f", "mp4", str(out_part)]
    tools.ffmpeg_progress(cmd, dur, lambda p: on_pct(90 + p / 10 if todo else p), timeout=max(300, dur * 4),
                          what="chunk join")
    got = tools.text_run([ctx.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=nb_frames", "-of", "csv=p=0", str(out_part)], 60, "chunk join check").stdout
    if got.strip() != str(n_frames):
        raise RuntimeError(f"the joined chunks have {got.strip() or 'no'} frames, not {n_frames}")
    cache.prune(keys)
    return {"total": len(spans), "encoded": missing}


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
        music: Optional[str] = None, cover: bool = True, project_file: Optional[Path] = None,
        out: Optional[Path] = None, job_id: Optional[str] = None, parent: Optional[int] = None,
        merge_parent: Optional[int] = None, rules: Optional[str] = None, chunked: bool = True) -> dict:
    t_start = time.time()
    checks = read_rules(rules)
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir, file=project_file)
    committed = int(proj.get("version") or 0)
    if parent is not None and (type(parent) is not int or not 1 <= parent <= committed):
        raise EngineError("BAD_NOTE_BASE", f"invalid parent {parent} at version {committed}",
                          "Choose a saved version to change.")
    if merge_parent is not None:
        if parent is None or type(merge_parent) is not int or not 1 <= merge_parent <= committed or merge_parent == parent:
            raise EngineError("BAD_MERGE", "merge needs two different saved parents", "Choose two different saved versions to combine.")
        for n in (parent, merge_parent):
            saved_dir = project_dir / "versions" / f"v{n}"
            if not (saved_dir / "export.mp4").is_file() or not (saved_dir / "project.json").is_file() or (saved_dir / ".rendering").exists():
                raise EngineError("BAD_MERGE", f"missing saved parent {n}", "One of these versions is missing or unfinished. Choose another version.")
    if first_look:
        draft = True
        proj = first_look_project(project_dir, proj, music)
    root = tools.root_dir(str(root) if root else None)
    progress(STAGE, 1, "Getting your video ready", force=True)
    # Taken before anything is read: a file changed during the render can only make the key older than
    # the picture, so frames then draws stills instead of trusting this render (current_render).
    pkey = picture_key(project_dir, proj, root)
    tl = edit_timeline(project_dir, proj, root)
    win = parse_window(window, tl.duration)
    if win:
        draft = True        # a window is a preview: always the fast encoder

    # the version this edit started from: this render's receipt says what changed since it. That is the one
    # project.json points at, or for a branched note or a merge, its parent (docs/versions.md)
    since = parent if parent is not None else committed
    committed_snapshot = project_dir / "versions" / f"v{since}" / "project.json"
    baseline = projmod.read_json(committed_snapshot) if committed_snapshot.exists() else None
    # A branch records a new child even if its result matches the latest video. Reusing that
    # folder would lose the selected parent, and saved metadata must never be rewritten.
    version = committed + 1 if merge_parent is not None or (parent is not None and parent < committed) else pick_version(project_dir, proj, root)
    preview = bool(draft)
    vdir = (Path(out) if out else preview_dir(project_dir)) if preview else project_dir / "versions" / f"v{version}"
    if not preview and version == committed:
        # a saved version is never rewritten: the same edit gets its video back
        if (vdir / "export.mp4").exists() and (vdir / "render.json").exists():
            made = projmod.read_json(vdir / "render.json")
            made.pop("segmentsDetail", None)
            # nothing was rendered: the receipt says what changed since the version, not the saved render's own
            receipt = {"receipt": {"jobId": job_id, "renderId": made.get("renderId"), "version": version,
                                   "facts": projmod.net_changes(baseline, proj)}} if baseline is not None else {}
            return dict(made, file=str(vdir / "export.mp4"), versionDir=str(vdir), reused=True, **receipt)
        # one with a file missing (removed by hand) is left as it is too: this render is the next version
        version = committed + 1
        vdir = project_dir / "versions" / f"v{version}"
    if not preview and version > committed:
        # A note renders its private copy, whose version is the one it started from. A version that
        # project.json saved since (another note, a change made by hand) is never replaced.
        saved = committed if project_file is None else int(projmod.load(project_dir, check=False).get("version") or 0)
        if version <= saved:
            raise EngineError("PROJECT_CHANGED", f"v{version} was saved after {project_file} was copied (project.json is at v{saved})",
                              "Your video was changed somewhere else while I worked on your note, so I left it as it was. "
                              "Send your note again.")
        if vdir.exists():
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
    render_id = "r_" + uuid.uuid4().hex
    input_fp = render_identity.fingerprint({
        "edit": projmod.edit_signature(proj), "words": tl.words, "assets": asset_fingerprint(project_dir, proj, root),
        "draft": draft, "window": win})

    src_meta, src_paths = source_files(project_dir, proj, root)
    faces = source_faces(project_dir, proj)
    # The picture of a draft or window comes from each take's preview copy when it is finished
    # (proxy.py); sound, the cover and every final read the originals.
    if draft:
        vmeta, vpaths, vfaces, video_from = proxymod.for_preview(project_dir, src_meta, src_paths, faces)
    else:
        vmeta, vpaths, vfaces, video_from = src_meta, src_paths, faces, {sid: "original" for sid in src_meta}

    ctx = make_ctx(project_dir, proj, tl, draft, root, rwork)
    if preview:
        ctx.fmt["fps"] = preview_fps(float(ctx.fmt.get("fps") or 30))
    ctx.out_dir = vdir
    ctx.window = win
    angle_rows = use_angles(ctx, tl, warnings)
    from .lint_edit import prepare
    lint = prepare(ctx, tl)
    for m in tl.match_joins:
        if m.get("played") == "hard":
            name = "A match cut" if m.get("transition", "match") == "match" else "A cut on action"
            warnings.append(f"{name} plays as a plain cut: {m.get('why') or 'its frames were not compared'}.")
    timings = {}

    # 1. audio (always the full cut, then sliced for a window, so the music sits where it will)
    progress(STAGE, 4, "Cutting your sound", force=True)
    t = time.time()
    audio = build_audio(ctx, tl.segments, src_paths, rwork, warnings)
    timings["audio"] = round(time.time() - t, 2)
    if proj.get("sfx") or any(s.join_transition == "smash" for s in tl.segments):
        try:
            from . import sfx as sfxmod
            placed, left = sfxmod.plan(ctx)
            warnings += [f"Sound effect {r['sound']} left out: {r['skipped']}." for r in left]
            if placed and ctx.sfx_mixed is None:     # the effects, or the whole music step, failed
                warnings.append(SFX_FAILED)
        except Exception as exc:   # noqa: BLE001
            log(f"# sound effects skipped: {exc!r}")
            warnings.append(SFX_FAILED)

    # 2. b-roll layers + zooms (A2)
    t = time.time()
    layers_report = project_dir / "work" / "layers" / "layers.json"
    layers, zooms, layer_items, raw_broll, broll_report = overlays(ctx, proj, tl, warnings)
    timings["layers"] = round(time.time() - t, 2)

    # 3. captions
    fmt = proj["format"]
    # a draft or window renders at preview_fps (set on ctx.fmt above); the final keeps the project rate
    W, H, fps = int(fmt["width"]), int(fmt["height"]), float(ctx.fmt["fps"])
    ass_name, cap_report, font_path = burn_captions(ctx, proj, tl, broll_report, rwork, warnings)
    # a window keeps the full track's cues that overlap it; a full render's go beside the video (#87)
    if win:
        cap_report = [r for r in cap_report if r["e"] > win[0] and r["s"] < win[1]]

    # Every rule is measured on what was just built, before the encode: a final render that breaks
    # one the app asked to stop on returns now, without spending a minute or two on a video.
    rule_report = None
    if checks is not None and not win:
        gone = {r["id"] for r in broll_report if r.get("skipped")}
        rule_report = rule_checks.check(checks[0], cues=cap_report, fmt=(W, H), mix=mix_measured(audio),
                                        broll=[r for r in layer_items if r.get("id") not in gone], duration=tl.duration)
        if not preview and any(f["id"] in checks[1] for f in rule_report["failures"]):
            # the version folder made above holds nothing yet: no number is used up
            shutil.rmtree(vdir, ignore_errors=True)
            progress(STAGE, 100, "Checking your rules", force=True)
            timings["total"] = round(time.time() - t_start, 2)
            return {"version": version, "preview": preview, "draft": draft, "encoded": False,
                    "ruleChecks": rule_report, "warnings": warnings, "timings": timings}

    # 4. the picture
    if win:
        a, b = win
        segments = cutmod.window_segments(ctx.picture_timeline or tl.segments, a, b)
        dur, t_shift, audio_seek = b - a, a, a
    else:
        segments, dur, t_shift, audio_seek = ctx.picture_timeline or tl.segments, tl.duration, 0.0, 0.0
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
    cmd = build_video_cmd(ctx, segments, vmeta, vpaths, vfaces, out_w, out_h, layers, zooms,
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

    chunks = None
    if chunked and not draft and not win:
        # A final is made of cached chunks (chunked_video), so an edit re-encodes only the chunks it touched. A take
        # that can't be chunked, or anything going wrong there, falls back to the single pass below, except
        # captions in the wrong font, which the single pass would draw the same way.
        try:
            chunks = chunked_video(ctx, tl, segments, src_meta, src_paths, faces, layers, zooms, ass_name, font_path,
                                   audio, out_part, rwork, on_pct, warnings)
        except EngineError as exc:
            if exc.code == "FONT_SUBSTITUTED":
                raise
            log(f"# chunked final failed, rendering it in one pass: {exc.message[-400:]}")
        except Exception as exc:   # noqa: BLE001 -- the single pass is the fallback for any failure
            log(f"# chunked final failed, rendering it in one pass: {exc!r}")
    err = None
    if chunks is None:
        err = None
        try:
            err = tools.ffmpeg_progress(cmd, dur, on_pct, timeout=max(600, dur * 40), what="video render",
                                        cwd=rwork, user_message="I couldn't finish making your video. "
                                                                "Please try again.")
        except EngineError as exc:
            if not draft:
                raise
            if vpaths != src_paths:
                # A damaged copy fails whatever encodes it: read the originals with the same encoder first,
                # so a bad copy costs one retry and never marks a working encoder as failed.
                log(f"# draft from the preview copies failed, retrying from the originals: {exc.message[-400:]}")
                video_from = {sid: "original" for sid in src_meta}
                cmd = build_video_cmd(ctx, segments, src_meta, src_paths, faces, out_w, out_h, layers, zooms,
                                      ass_name, audio, audio_seek, dur, t_shift, encoder, out_part, graph)
                try:
                    err = tools.ffmpeg_progress(cmd, dur, on_pct, timeout=max(600, dur * 40), what="video render",
                                                cwd=rwork)
                except EngineError as again:
                    exc = again
            if err is None:
                log(f"# hardware draft path failed, retrying in software: {exc.message[-400:]}")
                warnings.append("The fast preview path didn't work on this computer, so I used the slower one.")
                # the originals too: a damaged preview copy must cost speed, never the preview
                video_from = {sid: "original" for sid in src_meta}

                def slow(enc: str) -> str:
                    return tools.ffmpeg_progress(build_video_cmd(ctx, segments, src_meta, src_paths, faces, out_w,
                                                                 out_h, layers, zooms, ass_name, audio, audio_seek,
                                                                 dur, t_shift, enc, out_part, graph, fast=False),
                                                 dur, on_pct, timeout=max(600, dur * 40), what="video render",
                                                 cwd=rwork)
                # Hardware decode AND a GPU encoder: either may have failed, so keep the encoder first and a
                # decoder that can't open this file doesn't get a working encoder marked as failed for days.
                # Not after a timeout: a third full timeout would leave the user waiting half an hour.
                both_gpu = encoder != "libx264" and "-hwaccel" in cmd
                if both_gpu and exc.code != "TIMEOUT":
                    try:
                        err = slow(encoder)
                    except EngineError as exc2:
                        log(f"# software decode with {encoder} failed too: {exc2.message[-400:]}")
                if err is None:
                    failed_encoder, encoder = encoder, "libx264"
                    err = slow(encoder)
                    if failed_encoder != "libx264" and not (both_gpu and exc.code == "TIMEOUT"):
                        # Software worked where the GPU encoder did not: stop trying that encoder for a few days.
                        # (After a timeout with hardware decode, nothing showed the encoder was at fault.)
                        tools.mark_encoder_failed(failed_encoder)
    timings["encode"] = round(time.time() - t, 2)
    if font_path is not None and chunks is None:      # a chunked final checked each pass that drew captions
        font_check(err, font_path, warnings)
    os.replace(out_part, out)

    visual_changes = visual_change_meter(dur, segments, raw_broll, zooms, visual_offset=t_shift, fps=fps)
    result = {"renderId": render_id, "inputFingerprint": input_fp, "fps": fps, "encoded": True,
              "version": version, "preview": preview, "versionDir": str(vdir), "file": str(out),
              "draft": draft, "window": list(win) if win else None, "firstLook": first_look,
              "duration": round(dur, 3), "segments": len(segments), "encoder": encoder,
              "size": [out_w, out_h], "videoFrom": video_from, "layers": len(layers), "zooms": len(zooms),
              "captions": len(cap_report), "warnings": warnings, "visualChanges": visual_changes,
              "chunks": chunks,    # None: not a final, or a final rendered in one pass
              "expectedSilence": ctx.expected_silence,
              "broll": [r for r in broll_report if r.get("fallback") or r.get("skipped") or r.get("remake")],
              **({"angles": angle_rows} if angle_rows else {})}
    result.update(lint)
    if rule_report is not None:
        result["ruleChecks"] = rule_report
    if ctx.variation is not None:
        result["variation"] = ctx.variation

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
                              draft=draft, expected_silence=ctx.expected_silence)
        rep.update(renderId=render_id, inputFingerprint=input_fp)
        projmod.write_json(vdir / ("verify.json" if not win else f"verify_{name[:-4]}.json"), rep)
        result["verify"] = {"ok": rep["ok"], "fails": rep["fails"], "warns": rep["warns"]}
        timings["verify"] = round(time.time() - t, 2)

    timings["total"] = round(time.time() - t_start, 2)
    result["timings"] = timings
    if baseline is not None:
        result["receipt"] = {"jobId": job_id, "renderId": render_id, "version": version,
                             "facts": projmod.net_changes(baseline, proj)}
    if not win:
        # the reports that describe THIS video live beside it (verify, the AI's frame checks, e2e); a
        # report this render did not make is removed, so a reused folder never keeps an older one
        projmod.write_json(vdir / "captions.json", {"cues": cap_report})
        for report, dst_name in ((layers_report, "layers.json"), (Path(audio).with_suffix(".json"), "mix.json")):
            if report.exists():
                copy_whole(report, vdir / dst_name)
            else:
                (vdir / dst_name).unlink(missing_ok=True)
        snap = json.loads(json.dumps(proj))
        projmod.write_json(vdir / "project.json", snap)
        manifest = dict(result, file=out.name, segmentsDetail=[s.__dict__ for s in tl.segments][:2000], words=tl.words_out,
                        captionsReport=cap_report, format=[W, H], layerItems=layer_items, videoSha256=render_identity.video_digest(out),
                        pictureKey=pkey)
        projmod.write_json(vdir / ("render_draft.json" if draft else "render.json"), manifest)
        if not preview and result.get("receipt", {}).get("facts"):
            receipts = vdir / "receipts.json"
            # a new number starts a new list: a render stopped before project.version moved left a stale one
            kept = projmod.read_json(receipts) if receipts.exists() and version == int(proj.get("version") or 0) else []
            projmod.write_json(receipts, [*kept, result["receipt"]])
        if not preview:
            projmod.write_json(vdir / "assets.json", asset_fingerprint(project_dir, proj, root))
            metadata = {"parent": parent if parent is not None else committed or None}
            if merge_parent is not None:
                metadata["parents"] = [parent, merge_parent]
            projmod.write_json(vdir / "version.json", metadata)
        if not preview and int(proj.get("version") or 0) != version:
            # Re-read: an edit saved during this 1-2 minute render must survive. Patch the one field
            # render owns instead of writing back the dict loaded at the start.
            projmod.update_version(project_dir, version, file=project_file)  # project.version = the last FINAL version
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


def edit_timeline(project_dir: Path, proj: dict, root: Optional[Path] = None):
    """The project's cut on the output clock, refusing an empty cut. `root` finds a Library song whose beats
    land the cuts (project.timeline)."""
    tl = projmod.timeline(project_dir, proj, root=root)
    if tl.duration < 0.3 or not tl.segments:
        raise EngineError("EMPTY_CUT", "the cut is empty", "There's nothing left in the edit. Undo the last change.")
    return tl


def source_files(project_dir: Path, proj: dict, root: Optional[Path] = None) -> tuple:
    """({id: source}, {id: path}), refusing a source that is no longer on disk."""
    src_meta = {s["id"]: s for s in proj["sources"]}
    src_paths = {s["id"]: projmod.source_path(project_dir, s, root=root) for s in proj["sources"]}
    for sid, p in src_paths.items():
        if not p.exists():
            raise EngineError("SOURCE_MISSING", f"missing source {p}",
                              "I can't find the original video for this project. It may have been "
                              "moved or deleted.")
    return src_meta, src_paths


# A flash join (Resolve's "dip to color", in white): the picture fades to white over FLASH_IN frames before the cut
# and back over FLASH_OUT after it. It is a layer like any picture, so a draft, a window and the final draw it the
# same, and captions stay on top of it. Frame counts judged by eye in other editors' presets (2 in, 3 out); no
# measurement behind them.
FLASH_IN, FLASH_OUT, FLASH_Z = 2, 3, 10_000


def use_angles(ctx: RenderCtx, tl, warnings: list) -> list:
    """Point the picture at the chosen camera on each segment (angles.py); [{out, angle}] when the
    project switches cameras, else []. Sound and words stay on tl.segments."""
    from . import angles
    pic, rows = angles.picture_segments(ctx.project_dir, ctx.project, tl.segments, ctx.words, ctx.ffmpeg, warnings)
    ctx.picture_timeline = pic if rows else None
    return rows


def flash_layers(ctx: RenderCtx, segments: list) -> list:
    cuts = [s.out_start for s in segments[1:] if s.join_transition == "flash"]
    if not cuts:
        return []
    from PIL import Image
    png = Path(ctx.work) / "render" / "flash.png"
    if not png.exists():
        png.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (16, 16), (255, 255, 255)).save(png)
    W, H = int(ctx.fmt["width"]), int(ctx.fmt["height"])
    # the project's frame rate, not a preview's, so a draft and a window flash for as long as the final does
    fps = float(((ctx.project or {}).get("format") or {}).get("fps") or ctx.fmt["fps"])
    return [Layer(path=png, kind="image", t0=max(0.0, t - FLASH_IN / fps), t1=t + FLASH_OUT / fps, x=0, y=0, w=W, h=H,
                  z=FLASH_Z, fade_in=FLASH_IN / fps, fade_out=FLASH_OUT / fps) for t in cuts]


def overlays(ctx: RenderCtx, proj: dict, tl, warnings: list) -> tuple:
    """(layers, zooms, layer items, raw b-roll, broll_report): the b-roll layers and zooms (A2) drawn
    over the cut. The layer items are the records build_layers wrote to work/layers/layers.json, which
    is removed first so it holds only this picture's; raw b-roll is those items when a layer was drawn
    (the visual-change meter's pictures, cut-vocab). The zooms are the ones lint_edit.prepare planned."""
    layers, zooms, layer_items, raw_broll = [], [], [], []
    layers_report = Path(ctx.project_dir) / "work" / "layers" / "layers.json"
    layers_report.unlink(missing_ok=True)       # read below and by the AI: only this render's
    broll = _opt_module("broll")
    if broll is not None and proj.get("broll"):
        progress(STAGE, 12, "Placing your pictures", force=True)
        try:
            layers = list(broll.build_layers(ctx) or [])
            layer_items = projmod.read_json(layers_report).get("items") or []
            # the visual-change meter counts the pictures that made it into the video (cut-vocab)
            if layers:
                raw_broll = layer_items
        except EngineError as exc:
            log(f"# b-roll skipped: {exc.message}")
            warnings.append(f"The b-roll was left out of this version: {exc.user_message}")
        except Exception as exc:   # noqa: BLE001
            # dev detail goes to the log, never into a warning the app may show
            log(f"# broll.build_layers crashed: {exc!r}")
            warnings.append(BROLL_FAILED)
    broll_report = read_broll_report(layer_items)
    gone_rows, gone_warns = unknown_anchor_skips(proj, tl)
    broll_report = [r for r in broll_report if r.get("id") not in {g["id"] for g in gone_rows}] + gone_rows
    warnings += gone_warns
    zoom = _opt_module("zoom")
    if zoom is not None and (proj.get("zooms") or ctx.variation is not None):
        try:
            zooms = ctx.lint_zooms
        except Exception as exc:   # noqa: BLE001
            log(f"# zoom.build_zooms failed: {exc!r}")
            warnings.append(ZOOMS_FAILED)
    layers += flash_layers(ctx, tl.segments)
    return layers, zooms, layer_items, raw_broll, broll_report


def burn_captions(ctx: RenderCtx, proj: dict, tl, broll_report: list, rwork: Path, warnings: list) -> tuple:
    """(ass_name, cue report, font path): the full video's caption track and its font, written into
    rwork for the `subtitles` filter. (None, [], None) when captions are off."""
    W, H = int(proj["format"]["width"]), int(proj["format"]["height"])
    ass_name, cap_report, font_path = None, [], None
    cap = proj.get("captions") or {}
    if cap.get("enabled", True):
        progress(STAGE, 16, "Writing your captions", force=True)
        # split views of a close-up face: captions move to the seam instead of crossing the face
        spans = [(r["t0"], r["t1"], float(r["captionHintY"])) for r in broll_report
                 if r.get("captionHintY") is not None and r.get("t0") is not None and r.get("t1") is not None]
        # A window burns this same full-length track, read on the full video's clock (build_video_cmd).
        # Grouping only the window's words made lines the full video never shows ("HERE IS THE" where
        # the video shows "SO HERE IS"), so a window starting or ending mid-line drew the wrong words.
        ass, cap_report, cwarn, (family, font_path), stats = capmod.build_for_timeline(
            tl, proj, W, H, position_spans=spans, project_dir=ctx.project_dir)
        warnings += cwarn
        ass_name = "captions.ass"
        with open(rwork / ass_name, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(ass)
        fonts = rwork / "fonts"
        if fonts.exists():
            shutil.rmtree(fonts, ignore_errors=True)
        fonts.mkdir(parents=True, exist_ok=True)
        shutil.copy2(font_path, fonts / Path(font_path).name)
    return ass_name, cap_report, font_path


# --- reusing a render, or drawing stills without one (frames) --------------------------------------

def picture_key(project_dir: Path, proj: dict, root: Optional[Path] = None) -> str:
    """Everything the picture of a full render depends on: the edit without its music (sound only), the
    notes and the post text (edit_signature), the files the picture reads, the transcript the captions
    are timed from, and the engine itself. The files outside project.json are the face track (the crop
    and where cards go) and the app's rendered animations (a remade one keeps its id and file name). The
    engine is its version plus its code and bundled fonts, as cover_key keys on cover code (a dev build
    changes them without a new version). A render whose manifest carries the key a project has now shows
    that project's frames (current_render). When cuts, zooms, b-roll or cards land on the song's beats
    (music.onBeat, or a cut style's beat accents), the song moves the picture, so the music stays in."""
    from .cut_style import beat_accents_on
    on_beat = beat_accents_on(proj) or bool((proj.get("music") or {}).get("onBeat"))
    silent = proj if on_beat else dict(proj, music=None)
    try:
        transcript = hashlib.sha256(projmod.transcript_path(project_dir, proj).read_bytes()).hexdigest()
    except OSError:
        transcript = None
    # the transcript is keyed by its bytes: beta's asset_fingerprint (#87) also lists its size and time,
    # which a rewrite with the same words changes
    assets = asset_fingerprint(project_dir, silent, root)
    assets["assets"].pop(projmod.TRANSCRIPT_REL, None)
    work, here = Path(project_dir) / "work", Path(__file__).parent

    def stats(base: Path, files) -> dict:
        out = {}
        for f in files:
            try:
                st = f.stat()
                out[f.relative_to(base).as_posix()] = [st.st_size, st.st_mtime_ns]
            except OSError:
                continue
        return out
    blob = json.dumps({"edit": projmod.edit_signature(silent), "assets": assets,
                       "work": stats(work, [*work.glob("face*.json"), *(work / "animations").glob("*")]),
                       "transcript": transcript, "engine": reelengine.__version__,
                       "engineFiles": stats(here, [*here.glob("*.py"), *(here / "fonts").rglob("*")])},
                      sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def current_render(project_dir: Path, project_file: Optional[Path] = None, root: Optional[Path] = None) -> Optional[dict]:
    """The newest full render, preview or final, that shows the edit as it is now (a note's private copy
    when `project_file` is given), bound by render_identity, or None. Its manifest must carry the edit's
    picture key and be written after the mp4 (an mp4 newer than its manifest is a render that stopped
    before its last step), and its video and verify report must be that render's own (#50). A note's
    previews in work/notes/ count, as render ids are found there too."""
    project_dir = Path(project_dir)
    key = picture_key(project_dir, projmod.load(project_dir, file=project_file),
                      tools.root_dir(str(root) if root else None))
    found = []
    for manifest, man in render_identity.manifests(project_dir):
        if man.get("pictureKey") != key:
            continue
        video = manifest.parent / Path(str(man.get("file") or "")).name
        try:
            made = video.stat().st_mtime_ns
            if manifest.stat().st_mtime_ns >= made:
                found.append((made, manifest))
        except OSError:
            continue
    for _, manifest in sorted(found, reverse=True):
        try:
            return render_identity.bind(manifest)
        except EngineError:
            continue
    return None


def frame_at(t: float, fps: float, n_frames: int) -> int:
    """The output frame a still at `t` seconds shows: the nearest one, inside the video. A still drawn
    by stills() and one taken from a render (frames.py) use this same frame."""
    return min(max(0, int(round(float(t) * fps))), max(0, n_frames - 1))


def word_times(words: list, ids) -> list:
    """For each word id, the time its still shows: the middle of the word on the timeline being looked
    at (a render's own `words`, or the edit's), rounded to 0.01 s as look_at_frames rounds it."""
    by_id = {w["id"]: w for w in words}
    out = []
    for wid in ids or []:
        w = by_id.get(wid)
        if w is None:
            raise EngineError("BAD_ARGS", f"word {wid} is not in the cut", f"Word {wid} is not in the cut.")
        out.append(math.floor((w["s"] + w["e"]) / 2 * 100 + 0.5) / 100)
    return out


def settle_on_animations(items: list, times: list) -> tuple:
    """A frame in the middle of an animation shows a count-up half way or half its words (a live run read
    a count-up mid-way and reported the wrong number). A time inside an animation's window moves to its
    settled end, 0.15 s before it ends. `items` are the layer records of the picture being looked at: a
    render's own (its manifest's layerItems), or the ones stills() just built.
    -> (times, [{asked, sampled, id}] for each time it moved)"""
    anims = [r for r in items or [] if isinstance(r, dict)
             and (r.get("treatment") == "animation" or r.get("zone") in ("animation", "full"))
             and isinstance(r.get("t0"), (int, float)) and isinstance(r.get("t1"), (int, float)) and not r.get("skipped")]
    pick, moved = [], []
    for t in times:
        a = next((r for r in anims if r["t0"] <= t < r["t1"]), None)
        end = t if a is None else math.floor(max(a["t0"], a["t1"] - 0.15) * 100 + 0.5) / 100
        if end != t:
            moved.append({"asked": t, "sampled": end, "id": str(a.get("id"))})
        pick.append(end)
    return pick, moved


def stills(project_dir: Path, times: list, width: int, root: Optional[Path] = None,
           project_file: Optional[Path] = None, words: Optional[list] = None,
           out_dir: Optional[Path] = None, on_still=None, settle_within: Optional[list] = None) -> dict:
    """PNG stills of the edit as it is now (a note's private copy when `project_file` is given), with no
    render to take them from. Each is the draft's frame at that time (frame_at), drawn by the draft's own
    graph (build_video_cmd) over a one-frame window: the same layers, zooms and full-length caption
    track, with no sound and no encode. `words` adds the middle of each word on the edit's timeline. It
    writes work/render/ and work/layers/ as a render does, so it must never run beside one.
    The PNGs go to `out_dir` (default work/frames); `on_still({t, file})` is called as each one is written.
    `settle_within` ([[a, b], ...]): a time moves to an animation's settled end only when that end is still
    inside one of these spans (moments.py asks for frames of what changed, not of what is beside it)."""
    t_start = time.time()
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir, file=project_file)
    root = tools.root_dir(str(root) if root else None)
    tl = edit_timeline(project_dir, proj, root)
    rwork = project_dir / "work" / "render"
    rwork.mkdir(parents=True, exist_ok=True)
    out_dir = Path(out_dir) if out_dir else project_dir / "work" / "frames"   # with a render's frames (frames.py), never in a version
    out_dir.mkdir(parents=True, exist_ok=True)
    warnings: list = []
    src_meta, src_paths = source_files(project_dir, proj, root)
    faces = source_faces(project_dir, proj)
    # a still is the draft's frame, so it reads what the draft reads: each take's finished preview copy (proxy.py)
    vmeta, vpaths, vfaces, video_from = proxymod.for_preview(project_dir, src_meta, src_paths, faces)
    ctx = make_ctx(project_dir, proj, tl, True, root, rwork)
    ctx.fmt["fps"] = preview_fps(float(ctx.fmt.get("fps") or 30))     # a still is the draft's frame (#146)
    use_angles(ctx, tl, warnings)
    times = [*times, *word_times(tl.words_out, words)]
    if not times:
        raise EngineError("BAD_ARGS", "no times given", "Reel Studio didn't say which moments to show.")
    from .lint_edit import prepare
    prepare(ctx, tl)                                # the zooms a draft draws, with lint's ramp fixes
    layers, zooms, layer_items, _, broll_report = overlays(ctx, proj, tl, warnings)
    ass_name, _, font_path = burn_captions(ctx, proj, tl, broll_report, rwork, warnings)
    W, H, fps = int(proj["format"]["width"]), int(proj["format"]["height"]), float(ctx.fmt["fps"])
    n_frames = max(1, int(round(tl.duration * fps)))
    asked = list(times)
    times, moved = settle_on_animations(layer_items, times)
    if settle_within is not None:
        def inside(t: float) -> bool:           # the frame that time draws, not the time itself
            f = frame_at(t, fps, n_frames) / fps
            return any(a - 1e-6 <= f < b for a, b in settle_within)
        times = [t if inside(t) else a for t, a in zip(times, asked)]
        moved = [m for m in moved if inside(m["sampled"])]
    timings = {"setup": round(time.time() - t_start, 2), "stills": []}

    # drawn at the draft's own size, then scaled as frames.from_video scales a draft frame
    out_w = int(round(W * DRAFT_SCALE / 2)) * 2
    out_h = int(round(H * DRAFT_SCALE / 2)) * 2
    one = 1.0 / fps
    out = []
    for n, t in enumerate(times):
        t_still = time.time()
        k = frame_at(t, fps, n_frames)
        a = k / fps
        segments = cutmod.window_segments(ctx.picture_timeline or tl.segments, a, a + one)
        png, part = out_dir / f"still_{k:06d}.png", rwork / "still.png"
        graph = rwork / "graph_still.txt"

        def draw(fast: bool) -> str:
            # the slow retry reads the originals, as a draft's does: a damaged copy costs speed, never the still
            meta, paths, fcs = (vmeta, vpaths, vfaces) if fast else (src_meta, src_paths, faces)
            cmd = build_video_cmd(ctx, segments, meta, paths, fcs, out_w, out_h, layers, zooms,
                                  ass_name, None, 0.0, one, a, None, part, graph, fast=fast)
            return tools.text_run(cmd, 120, "still", cwd=rwork,
                                  user_message="I couldn't draw that moment of your video. Please try again.").stderr
        used = video_from
        try:
            err = draw(True)
        except EngineError as exc:      # as a draft does: the fast path failed, the draft from before next
            log(f"# fast still failed, retrying the slow way: {exc.message[-400:]}")
            used = {sid: "original" for sid in src_meta}
            err = draw(False)
        if font_path is not None:
            bad = check_fontselect(err, Path(font_path))
            if bad:
                raise EngineError("FONT_SUBSTITUTED", f"libass used a different font: {bad}",
                                  "Your captions came out in the wrong font, so I stopped. Please "
                                  "reinstall Reel Studio.")
        if out_w == width:
            os.replace(part, png)
        else:
            tools.text_run([ctx.ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(part),
                            "-vf", f"scale={width}:-2", str(png)], 60, "still scale")
        out.append({"t": round(a, 3), "file": str(png), "videoFrom": used})
        timings["stills"].append(round(time.time() - t_still, 2))
        if on_still is not None:
            on_still(out[-1])
        progress("frames", 100 * (n + 1) / len(times), "Looking at your video")
    return {"frames": out, "animationsSampledAtEnd": moved, "warnings": warnings,
            # pictures shown differently or skipped, and animations to remake, as render_draft reports them
            "broll": [r for r in broll_report if r.get("fallback") or r.get("skipped") or r.get("remake")],
            "timings": timings,
            # per take: what every still read, or "mixed" when a slow retry read the original for some
            "videoFrom": {sid: (vals.pop() if len(vals) == 1 else "mixed")
                          for sid in src_meta for vals in [{f["videoFrom"][sid] for f in out}]}}


def cover_key(ctx, proj: dict, src_paths: dict) -> str:
    """Everything cover.render reads: the cover settings, the sources, the format, the cut (it picks
    from kept moments), the transcript and face track it scores against, the draft flag (a preview
    scores fewer frames) and the cover code itself."""
    import hashlib

    def mt(p: Path) -> float:
        try:
            return round(p.stat().st_mtime, 3)
        except OSError:
            return 0.0

    def st(p) -> list:
        try:
            s = Path(p).stat()
            return [str(p), s.st_size, s.st_mtime_ns]
        except OSError:
            return [str(p), None, None]
    pdir = Path(ctx.project_dir)
    here = Path(__file__).parent
    # The source files' size and mtime, as voice_signature keys them: a video replaced in place keeps
    # the same project entry, and without these the old cover would be served from the cache.
    data = {"cover": proj.get("cover"), "sources": proj.get("sources"), "format": proj.get("format"),
            "sourceFiles": {k: st(v) for k, v in sorted(src_paths.items())},
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
        key = cover_key(ctx, proj, src_paths)

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


def cover_candidates(project_dir: Path, moments: list, source: Optional[str] = None, root: Optional[Path] = None,
                     picker: bool = False, project_file: Optional[Path] = None) -> dict:
    """`cover-candidates --at t1,t2,...`: the best cover frame near each raw-take moment, as small
    stills the AI looks at before choosing (cover.candidates). `--picker` writes the app's cover
    picker stills to their own folder: every call empties its folder first, and the AI may be
    reading its own stills at the same time."""
    project_dir = Path(project_dir).resolve()
    proj = projmod.load(project_dir, file=project_file)
    tl = projmod.timeline(project_dir, proj)
    ctx = make_ctx(project_dir, proj, tl, True, tools.root_dir(str(root) if root else None),
                   project_dir / "work" / "render")
    cover = _opt_module("cover")
    sid = source or (ctx.out_timeline[0].source if ctx.out_timeline else proj["sources"][0]["id"])
    out_dir = project_dir / "work" / ("cover-picker" if picker else "cover-candidates")
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
    src_paths = {s["id"]: projmod.source_path(project_dir, s, root=root) for s in proj["sources"]}
    warnings: list = []
    use_angles(ctx, tl, warnings)              # the cover shows the camera the reel shows
    progress("cover", 10, "Making your cover", force=True)
    p = render_cover(ctx, proj, tl, src_meta, src_paths, source_faces(project_dir, proj),
                     vdir / "cover.png", warnings)
    progress("cover", 100, "Your cover is ready", force=True)
    return {"file": str(p), "version": version, "preview": True, "warnings": warnings}
