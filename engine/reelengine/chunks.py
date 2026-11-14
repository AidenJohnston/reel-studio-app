"""The chunks of a chunked final render (render.chunked_video), and the cache that keeps them.

A final export is cut into chunks of two keyframe intervals (about 2 s) at fixed output frames. Each chunk is
stored under a key built from everything that draws into its frames, so a later render re-encodes only the
chunks whose key changed and copies the rest. The key is what FFmpeg is asked to do for that chunk alone: its
command and filter graph (source frame range, crop, mirror, tone mapping, layer and zoom timing, the caption
track's clock), the content of every file the command reads, the caption events on screen during the chunk,
the caption font, the encoder settings, the engine version and the FFmpeg build. File identity is content,
never a modification time.

Why the chunks join into the video one pass over the whole cut draws, and give the same bytes whatever was
encoded before them: every chunk is encoded by an encoder of its own, which starts on the chunk's first frame
with nothing carried over (x264 keeps motion search hints across keyframes, so chunks cut from one long encode
depend on what came before them), with settings that fix every keyframe and quantiser (render.encoder_args).
A run of missing chunks is still drawn by one FFmpeg pass, one output per chunk.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Optional

from . import __version__, tools

FORMAT = 1                  # bump when what a chunk file holds changes meaning
KEYFRAMES_PER_CHUNK = 2
DIR = "chunks"              # under work/render/
# Caption events this close to a chunk still count as on screen in it: libass reads the frame's time in
# milliseconds, and an event a frame away may be what a neighbouring event's layout makes room for.
CAPTION_MARGIN = 0.1
# Encoders open at once in one pass. FFmpeg keeps each x264 encoder, with its frame threads, lookahead and
# reference frames, until the pass ends: a first export of a 60 s 1080x1920 reel peaked at 9.7 GB with all
# 31 in one pass, 3.0 GB at 8 and 1.7 GB at 4 (21.7 s for the export, against 18.9 s at 8).
ENCODERS_PER_PASS = 4
# Chunks from older edits are kept for undo, up to this many times the chunks of the current video.
KEEP_FACTOR = 3


def gop_frames(fps: float) -> int:
    """Frames between keyframes in a final export: one second (render.encoder_args)."""
    return max(1, int(round(fps)))


def chunk_frames(fps: float) -> int:
    return KEYFRAMES_PER_CHUNK * gop_frames(fps)


def plan(n_frames: int, fps: float) -> list:
    """[(first frame, end frame)] of the chunks of an n-frame video. Every chunk starts on a keyframe."""
    step = chunk_frames(fps)
    return [(f, min(f + step, n_frames)) for f in range(0, n_frames, step)]


def runs(indices: list, limit: int) -> list:
    """Consecutive chunk indices grouped, at most `limit` to a group: each group is drawn by one FFmpeg
    pass with an encoder per chunk, and FFmpeg keeps every encoder of a pass until the pass ends."""
    out = []
    for i in indices:
        if out and out[-1][-1] == i - 1 and len(out[-1]) < limit:
            out[-1].append(i)
        else:
            out.append([i])
    return out


def file_identity(path) -> str:
    """The SHA-256 of a file's whole content. Sampling a large take let a chunk outlive changed pixels between
    the samples (Astra engine review 2). Hashing reads every byte: about 3 GB/s from memory on an Apple M4 Pro,
    so a 2 GB 4K take adds about 0.7 s per export there plus its disk read (unmeasured); a CPU without SHA
    instructions may take several times longer. Each file is hashed once per export (render.chunked_video
    passes `known`)."""
    h = hashlib.sha256()
    with open(Path(path), "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def command_identity(cmd: list, cwd: Path, known: dict) -> list:
    """An FFmpeg command with the program left out and each input file replaced by its content hash.
    `known` holds the hashes already taken in this render, by path (every chunk reads the same take)."""
    out = []
    for prev, arg in zip(cmd, cmd[1:]):
        if prev == "-i":
            path = str(Path(cwd, arg))
            if path not in known:
                known[path] = file_identity(path)
            arg = known[path]
        out.append(str(arg))
    return out


def _ass_seconds(stamp: str) -> float:
    h, m, s = stamp.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def caption_events(ass: str, t0: float, t1: float) -> tuple:
    """(header, [Dialogue lines]) of an ASS track: the header whole (styles and play size draw every event)
    and the events on screen between t0 and t1 on the track's clock, give or take CAPTION_MARGIN."""
    header, events, fields = [], [], None
    for line in ass.splitlines():
        if line.startswith("Format:") and fields is None and header and header[-1].strip() == "[Events]":
            fields = [f.strip() for f in line[len("Format:"):].split(",")]
        if not line.startswith("Dialogue:"):
            header.append(line)
            continue
        vals = line[len("Dialogue:"):].split(",", len(fields) - 1)
        start, end = _ass_seconds(vals[fields.index("Start")]), _ass_seconds(vals[fields.index("End")])
        if start < t1 + CAPTION_MARGIN and end > t0 - CAPTION_MARGIN:
            events.append(line)
    return "\n".join(header), events


def even_frames(ffprobe: str, path: Path, store: Path, hashes: Optional[dict] = None) -> bool:
    """Whether a take's frames are evenly spaced. A chunk that starts inside a cut segment draws the frames
    the single pass draws there only when the take's frames sit on a fixed grid: on a variable-rate take
    the single pass's frame clock depends on every frame time before it. Read from the packet timestamps
    (no decoding) and remembered in `store` by the take's content. `hashes`: identities already taken in this
    render, by path (command_identity's `known`)."""
    key = str(Path(path))
    if hashes is not None and key in hashes:
        ident = hashes[key]
    else:
        ident = file_identity(path)
        if hashes is not None:
            hashes[key] = ident
    try:
        known = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        known = {}
    if ident not in known:
        out = tools.text_run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts",
                              "-of", "csv=p=0", str(path)], 300, "frame timing").stdout
        pts = sorted(int(x) for x in out.split() if x.strip().lstrip("-").isdigit())
        steps = [b - a for a, b in zip(pts, pts[1:])]
        # a time base that doesn't divide the frame rate (29.97 fps in 1/15360 s) alternates by one tick
        jitter = 1 if steps and min(steps) >= 100 else 0
        known[ident] = bool(steps) and min(steps) > 0 and max(steps) - min(steps) <= jitter
        store.write_text(json.dumps(known, indent=1), encoding="utf-8")
    return known[ident]


_BUILD: dict = {}


def ffmpeg_build(ffmpeg: str) -> str:
    """The first line of `ffmpeg -version`: the release or git build, which decodes, filters and encodes."""
    if ffmpeg not in _BUILD:
        out = tools.text_run([ffmpeg, "-hide_banner", "-version"], 30, "ffmpeg -version", check=False).stdout
        _BUILD[ffmpeg] = (out or "").splitlines()[0] if out else ""
    return _BUILD[ffmpeg]


def chunk_key(parts: dict) -> str:
    blob = json.dumps({"format": FORMAT, "engine": __version__, **parts}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class Cache:
    """work/render/chunks/<key>.mp4: one encoded chunk per key."""

    def __init__(self, folder: Path):
        self.dir = Path(folder)
        self.dir.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        return self.dir / f"{key}.mp4"

    def has(self, key: str) -> bool:
        return self.path(key).is_file()

    def put(self, made: Path, key: str) -> None:
        os.replace(made, self.path(key))

    def prune(self, used: list) -> None:
        """Mark this render's chunks as the newest, then drop the oldest others beyond the budget."""
        for key in used:
            try:
                os.utime(self.path(key))
            except OSError:
                pass
        keep = set(used)
        others = sorted((f for f in self.dir.glob("*.mp4") if f.stem not in keep),
                        key=lambda f: f.stat().st_mtime_ns, reverse=True)
        for f in others[max(0, KEEP_FACTOR * len(keep) - len(keep)):]:
            f.unlink(missing_ok=True)


def concat_list(names: list, list_file: Path) -> Path:
    """An ffconcat script naming the chunks in order, relative to the script's folder."""
    lines = ["ffconcat version 1.0"] + [f"file '{n}'" for n in names]
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return list_file
