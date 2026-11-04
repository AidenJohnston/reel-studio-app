"""The corpus: one folder per take, the same shape for generated stand-ins and real footage.

    <take>/project/            made by `reelengine init`, plus work/transcript.json
    <take>/states/NN.json      each a full project.json, in session order
    <take>/session.json        {"steps": [{"note", "state", "moment": {"word": id}}]}
    <take>/spec.json           generated takes only: the spec and generator they were made from

Generated takes are built at setup time under the harness work folder (git ignores testdata/, and
media never goes in git). A real take is the same folder prepared by a person under
$REELENGINE_TEST_TAKES/<takeDir> (engine/tests/compositing/fixtures.py reads raw takes there too);
its states are the frozen edits of real note rounds, so replays cost no AI calls.

The stand-ins are synthetic: a skin-toned box on a moving gradient with grain, and speech-shaped
tones whose word timings are written straight into the transcript (no speech model is run). They
exercise the decode, scale, tonemap, caption and audio paths at phone-like sizes; they say nothing
about how real faces or voices compress.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import wave
from pathlib import Path

import numpy as np

RATE = 48000
SONG = "Library/Music/harness-song.wav"
SCRIPT = ("so here is the thing nobody tells you about editing short videos. you spend more time "
          "waiting than cutting. every small change means another full render. today I want to show "
          "you a faster way to work. first we cut the pauses out. then we fix the captions so they "
          "read well. then we add a little music under the voice. and that is the whole workflow "
          "from start to finish.")
RETAKE_PHRASE = 1          # the second sentence is said twice; the first attempt is cut
HEVC_ENCODERS = ("hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_videotoolbox")
# Bump when the generator's output changes for the same spec, so takes made by older code are rebuilt
# (2: HEVC color fields written with hevc_metadata).
GENERATOR = 2
SPEC_FILE = "spec.json"


# --- script and transcript ----------------------------------------------------------------------

def script_words(seconds: float) -> tuple:
    """Word timings for a take of `seconds`: (words, retake_ids). Pauses alternate between 0.55 s
    (one caption run) and 0.95 s (longer than captions.RUN_GAP, so a new run starts)."""
    phrases = [p.split() for p in SCRIPT.split(".") if p.strip()]
    order = list(range(len(phrases)))
    order.insert(RETAKE_PHRASE, RETAKE_PHRASE)        # said twice in a row
    words, retake, t, n, k = [], [], 0.5, 0, 0
    while True:
        idx = order[k % len(order)]
        first_attempt = k == RETAKE_PHRASE
        for tok in phrases[idx]:
            dur = 0.16 + 0.045 * len(tok)
            if t + dur > seconds - 0.4:
                return words, retake
            words.append({"id": f"w{n}", "source": "s1", "s": round(t, 3), "e": round(t + dur, 3), "w": tok})
            if first_attempt:
                retake.append(f"w{n}")
            n += 1
            t += dur + 0.07
        t += 0.55 if k % 2 == 0 else 0.95
        k += 1


def speech_audio(words: list, seconds: float, seed: int) -> np.ndarray:
    """Voiced tones (a harmonic stack at 110-150 Hz) with a short noise onset per word, over a quiet
    room floor. int16 mono at 48 kHz."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    out = rng.normal(0.0, 0.002, n)
    for w in words:
        i0, i1 = int(w["s"] * RATE), min(n, int(w["e"] * RATE))
        t = np.arange(i1 - i0) / RATE
        f0 = 110 + 40 * rng.random()
        voice = sum(np.sin(2 * math.pi * k * f0 * (1 + 0.02 * np.sin(2 * math.pi * 4 * t)) * t) / k for k in range(1, 12))
        env = np.minimum(1.0, np.minimum(t / 0.02, (t[-1] - t) / 0.05 + 1e-9))
        burst = rng.normal(0.0, 0.3, len(t)) * np.exp(-t / 0.015)
        out[i0:i1] += 0.12 * env * voice + 0.05 * burst
    return (np.clip(out, -1, 1) * 32767).astype(np.int16)


def song_audio(seconds: float = 40.0) -> np.ndarray:
    """A 120 bpm kick under a three-note pad. int16 mono at 48 kHz."""
    t = np.arange(int(seconds * RATE)) / RATE
    pad = sum(0.12 * np.sin(2 * math.pi * f * t) for f in (220.0, 277.2, 329.6))
    kick = 0.6 * np.sin(2 * math.pi * 55 * t) * np.exp(-25 * np.mod(t, 0.5))
    return (np.clip(pad + kick, -1, 1) * 32767).astype(np.int16)


def write_wav(path: Path, pcm: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(RATE)
        wf.writeframes(pcm.tobytes())


# --- video --------------------------------------------------------------------------------------

def _run(cmd: list) -> None:
    p = subprocess.run([str(c) for c in cmd], capture_output=True, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.decode('utf-8', 'replace')[-1200:]}")


def hevc_encoder(ffmpeg: str, ten_bit: bool) -> str:
    """The first hardware HEVC encoder that really opens here. The product's FFmpeg has no software
    HEVC encoder (packaging/ffmpeg/build.sh builds only libx264)."""
    pix = "p010le" if ten_bit else "yuv420p"
    for name in HEVC_ENCODERS:
        probe = [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=256x256:d=0.1:r=30",
                 "-pix_fmt", pix, "-c:v", name, *(["-profile:v", "main10"] if ten_bit else []), "-f", "null", "-"]
        if subprocess.run([str(c) for c in probe], capture_output=True, stdin=subprocess.DEVNULL).returncode == 0:
            return name
    raise RuntimeError(f"none of {', '.join(HEVC_ENCODERS)} opens on this machine "
                       f"({'10' if ten_bit else '8'}-bit); the HEVC stand-ins need one")


def picture_graph(w: int, h: int, fps: float, seconds: float, seed: int, grain: int) -> str:
    """A head-and-shoulders stand-in: skin-toned face box with eyes over a drifting gradient."""
    fx, fy, fw, fh = int(w * 0.28), int(h * 0.24), int(w * 0.44), int(h * 0.30)
    ew, eh = int(fw * 0.12), int(fh * 0.05)
    return (f"gradients=s={w}x{h}:r={fps}:d={seconds}:c0=0x23324a:c1=0x7a6250:c2=0x3c5a48:nb_colors=3:"
            f"speed=0.01:seed={seed},"
            f"drawbox=x={fx}:y={fy}:w={fw}:h={fh}:color=0xd9a98c:t=fill,"
            f"drawbox=x={fx + int(fw * 0.22)}:y={fy + int(fh * 0.35)}:w={ew}:h={eh}:color=0x2a1e18:t=fill,"
            f"drawbox=x={fx + int(fw * 0.66)}:y={fy + int(fh * 0.35)}:w={ew}:h={eh}:color=0x2a1e18:t=fill,"
            f"noise=alls={grain}:allf=t")


def make_source(ffmpeg: str, spec: dict, wav: Path, out: Path) -> dict:
    """Encode one stand-in take. Returns the encoder settings used, for the report."""
    w, h, fps, secs = spec["width"], spec["height"], spec["fps"], spec["seconds"]
    graph = picture_graph(w, h, fps, secs, spec["seed"], spec.get("grain", 8))
    vf = []
    if spec.get("vfr"):
        # drop frames on two incommensurate cycles: frame durations of 1/30 and 2/30 s, irregularly
        vf.append(r"select='not(eq(mod(n\,7)\,3))*not(eq(mod(n\,11)\,5))'")
    if spec.get("rotation"):
        vf.append("transpose=1")      # stored landscape; the display matrix (below) turns it upright
    ten = spec.get("bitDepth") == 10
    if spec["codec"] == "hevc":
        enc = hevc_encoder(ffmpeg, ten)
        vargs = ["-c:v", enc, "-b:v", spec["bitrate"], "-maxrate", spec["bitrate"], "-g", str(int(fps)),
                 "-pix_fmt", "p010le" if ten else "yuv420p", *(["-profile:v", "main10"] if ten else []),
                 "-tag:v", "hvc1"]
    else:
        enc = "libx264"
        vargs = ["-c:v", enc, "-preset", "veryfast", "-b:v", spec["bitrate"], "-maxrate", spec["bitrate"],
                 "-bufsize", spec["bitrate"], "-g", str(int(fps)), "-pix_fmt", "yuv420p"]
    color = (["-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67"]
             if spec.get("transfer") == "hlg" else
             ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"])
    out.parent.mkdir(parents=True, exist_ok=True)
    remux = []
    if spec["codec"] == "hevc":
        # Hardware HEVC encoders may leave the color fields out of the bitstream, and the engine's
        # probe decides HDR from them (probe.py HDR_TRANSFERS). Write them into the SPS so the HLG
        # stand-in really reads as HLG: primaries/transfer/matrix as H.273 codes.
        p_, t_, m_ = (9, 18, 9) if spec.get("transfer") == "hlg" else (1, 1, 1)
        remux += ["-bsf:v", f"hevc_metadata=colour_primaries={p_}:transfer_characteristics={t_}:"
                            f"matrix_coefficients={m_}:video_full_range_flag=0"]
    stage = out.with_name(out.stem + ".stage.mp4") if (remux or spec.get("rotation")) else out
    _run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", graph, "-i", wav,
          *(["-vf", ",".join(vf)] if vf else []), *(["-fps_mode", "vfr"] if spec.get("vfr") else []),
          *vargs, *color, "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", str(RATE),
          "-t", str(secs), "-movflags", "+faststart", stage])
    if stage != out:
        rot = ["-display_rotation:v:0", str(spec["rotation"])] if spec.get("rotation") else []
        _run([ffmpeg, "-y", "-v", "error", *rot, "-i", stage, "-map", "0", "-c", "copy", *remux,
              *color, "-movflags", "+faststart", out])
        stage.unlink()
    return {"encoder": enc, "args": vargs + color + remux}


# --- project and session ------------------------------------------------------------------------

def _keep_ranges(ids: list) -> list:
    """Consecutive word ids -> cut.keep ranges."""
    out, run = [], None
    for i in ids:
        n = int(i[1:])
        if run and n == run[1] + 1:
            run[1] = n
        else:
            if run:
                out.append(run)
            run = [n, n]
    if run:
        out.append(run)
    return [{"from": f"w{a}", "to": f"w{b}"} for a, b in out]


def session_states(base: dict, words: list, retake: list, keep_seconds=None) -> list:
    """(note, state, moment word id) for a five-note session: first cut, caption style, a cut in
    the middle, one caption word fixed, music. Each state is a full project.json."""
    # keepSeconds is one [start, end] span or a list of them (a long take cut down to a few stretches)
    spans = None if keep_seconds is None else (
        keep_seconds if isinstance(keep_seconds[0], list) else [keep_seconds])
    kept = [w for w in words if w["id"] not in retake
            and (spans is None or any(a <= w["s"] and w["e"] <= b for a, b in spans))]
    ids = [w["id"] for w in kept]

    def state(keep_ids, **changes) -> dict:
        p = json.loads(json.dumps(base))
        p["transcript"] = {"file": "work/transcript.json", "language": "en", "model": "synthetic"}
        p["cut"].update({"keep": _keep_ranges(keep_ids), "source": "ai"})
        for path, value in changes.items():
            node = p
            keys = path.split("__")
            for k in keys[:-1]:
                node = node[k]
            node[keys[-1]] = value
        return p

    style = dict(base["captions"]["style"], size=120, case="as-is", position=0.7)
    third = len(ids) // 3
    # the middle cut drops one whole phrase-sized run of words after the first third
    dropped = ids[third:third + 6]
    after = [i for i in ids if i not in dropped]
    fixed = after[len(after) // 2]
    word = next(w for w in words if w["id"] == fixed)
    music = {"enabled": True, "track": SONG, "startAt": 0.0, "level": "under-voice", "automation": [],
             "fadeOut": 1.5}
    s0 = state(ids)
    s1 = state(ids, captions__style=style)
    s2 = state(after, captions__style=style)
    s3 = state(after, captions__style=style,
               captions__corrections=[{"from": word["w"], "to": "REEL", "at": fixed}])
    s4 = state(after, captions__style=style, captions__corrections=s3["captions"]["corrections"], music=music)
    return [("first cut", s0, ids[0]), ("captions bigger, as said, higher", s1, ids[len(ids) // 4]),
            ("cut a run of words in the middle", s2, ids[third + 6]),
            ("fix one caption word", s3, fixed), ("music under the voice", s4, after[2 * len(after) // 3])]


def build_synthetic(ffmpeg: str, reference, spec: dict, take_dir: Path, root: Path) -> dict:
    """Generate one stand-in take folder. `reference` is the pinned Engine (init runs on it)."""
    secs = spec["seconds"]
    words, retake = script_words(secs)
    scratch = take_dir / "source"
    wav = scratch / "speech.wav"
    write_wav(wav, speech_audio(words, secs, spec["seed"]))
    src = scratch / f"{take_dir.name}.mp4"
    enc = make_source(ffmpeg, spec, wav, src)
    wav.unlink()
    proj_dir = take_dir / "project"
    reference.run("init", ["--project", proj_dir, "--title", take_dir.name, src])
    src.unlink()                 # init linked or copied it into project/media
    scratch.rmdir()
    (proj_dir / "work" / "transcript.json").write_text(
        json.dumps({"language": "en", "model": "synthetic", "words": words}, indent=1), encoding="utf-8")
    base = json.loads((proj_dir / "project.json").read_text(encoding="utf-8"))
    steps = []
    (take_dir / "states").mkdir(exist_ok=True)
    for k, (note, st, moment) in enumerate(session_states(base, words, retake, spec.get("keepSeconds"))):
        name = f"states/{k:02d}.json"
        (take_dir / name).write_text(json.dumps(st, indent=2), encoding="utf-8")
        steps.append({"note": note, "state": name, "moment": {"word": moment}})
    (take_dir / "session.json").write_text(json.dumps({"steps": steps}, indent=2), encoding="utf-8")
    # last: a take without this file is unfinished or from older code, and is rebuilt
    (take_dir / SPEC_FILE).write_text(json.dumps({"key": spec_key(spec), "spec": spec}, indent=1), encoding="utf-8")
    return {"source": enc, "words": len(words)}


def ensure_song(root: Path) -> Path:
    p = root / SONG
    if not p.exists():
        write_wav(p, song_audio())
    return p


def spec_key(spec: dict) -> str:
    return hashlib.sha256(json.dumps({"generator": GENERATOR, "spec": spec}, sort_keys=True).encode()).hexdigest()


def needs_build(spec: dict, take_dir: Path) -> bool:
    """A generated take is reused only when it was finished by this generator from this spec."""
    try:
        return json.loads((take_dir / SPEC_FILE).read_text(encoding="utf-8")).get("key") != spec_key(spec)
    except (OSError, ValueError):
        return True


def validate(spec, take_dir: Path) -> None:
    """Run before every use of a take, made now or long ago: the engine must read the source the
    way the spec says, or the take measures the wrong path (an HLG clip read as SDR never
    tonemaps). `spec` is None for real footage, which only has to have the corpus layout."""
    missing = [n for n in ("project/project.json", "project/work/transcript.json", "session.json")
               if not (take_dir / n).is_file()]
    if missing:
        raise RuntimeError(f"take {take_dir.name} is missing {', '.join(missing)}")
    if spec is None:
        return
    # the base project and every state: the states are what the engines render
    files = ["project/project.json"] + [st["state"] for st in
                                        json.loads((take_dir / "session.json").read_text(encoding="utf-8"))["steps"]]
    problems = []
    base = json.loads((take_dir / files[0]).read_text(encoding="utf-8"))["sources"]
    if len(base) != 1:
        problems.append(f"{files[0]}: a generated take has one source, found {len(base)}")
    for rel in files:
        sources = json.loads((take_dir / rel).read_text(encoding="utf-8"))["sources"]
        if sources != base:            # renders pick metadata by source id: every state must agree
            problems.append(f"{rel}: its sources differ from project/project.json")
        src = sources[0]
        if bool(src.get("hdr")) != (spec.get("transfer") == "hlg"):
            problems.append(f"{rel}: hdr={bool(src.get('hdr'))}, the spec says transfer={spec.get('transfer', 'sdr')}")
        # rotated or not: the display matrix's sign convention can turn a spec of 90 into a probed 270
        if bool(int(src.get("rotation") or 0) % 360) != bool(int(spec.get("rotation") or 0) % 360):
            problems.append(f"{rel}: rotation {src.get('rotation') or 0}, the spec says {spec.get('rotation') or 0}")
    if problems:
        raise RuntimeError(f"take {take_dir.name} does not match its spec: {'; '.join(problems)}. "
                           f"Delete {take_dir} and run setup again.")


def take_bytes(take_dir: Path) -> int:
    return sum(f.stat().st_size for f in (take_dir / "project" / "media").iterdir() if f.is_file())
