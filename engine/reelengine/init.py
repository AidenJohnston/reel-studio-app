"""`init --project <dir> --title T <files>...`: create the project folder + project.json, copy media."""
from __future__ import annotations

from pathlib import Path

from . import mirror_detect, probe as probemod, project as projmod, tools
from .proto import EngineError, progress


PREPARING = "Preparing your video"      # the app shows this step's own progress (main/index.ts)


def _media_name(i: int, src: Path) -> str:
    ext = src.suffix.lower() or ".mp4"
    return f"take{i:02d}{ext}"


def run(project_dir: Path, title: str, files: list, slug: str = None, faster_exports: bool = False,
        keep_order: bool = False) -> dict:
    """`keep_order`: the sources are s1, s2, ... in the order given, never by capture time. A reel cut from parts
    of several files (app archive-reels.ts) names each part's file by that position."""
    project_dir = Path(project_dir)
    if projmod.project_file(project_dir).exists():
        raise EngineError("PROJECT_EXISTS", f"{project_dir} already has a project.json",
                          "There's already a video project here. Pick a different name.")
    if not files:
        raise EngineError("NO_FILES", "no files given", "Drop in at least one video to start.")
    infos = []
    for f in files:
        f = Path(f)
        info = probemod.probe(f, quick=True, cadence=True)
        if not info["hasVideo"] or info["kind"] == "image":
            raise EngineError("NOT_VIDEO", f"{f} has no video stream",
                              f"\"{f.name}\" isn't a video. Drop in the video of you talking.")
        if info["duration"] < 1.0:
            raise EngineError("TOO_SHORT", f"{f} is {info['duration']}s",
                              f"\"{f.name}\" is too short to make a video from.")
        infos.append((f, info))

    # Partial dates cannot order the undated files, so preserve the whole drop order in that case.
    if not keep_order and all(info.get("capturedAt") for _, info in infos):
        infos.sort(key=lambda entry: entry[1]["capturedAt"])

    proj = projmod.new_project(title, slug=slug or projmod.slugify(project_dir.name, projmod.slugify(title)))
    media = project_dir / "media"
    (project_dir / "work").mkdir(parents=True, exist_ok=True)
    (project_dir / "versions").mkdir(parents=True, exist_ok=True)
    steady = []
    # the app shows preparing as its own step (main/index.ts), so its percent covers only the clips re-encoded,
    # by length; copying is instant
    prep = [i for i, (_, info) in enumerate(infos, start=1) if info["variableFrameRate"] and not info["hdr"]]
    prep_total = sum(infos[i - 1][1]["duration"] for i in prep) or 1.0
    for i, (f, info) in enumerate(infos, start=1):
        dst = media / _media_name(i, f)
        # Only a clip whose frame timing varies is re-encoded, to a steady 30 fps. Steady clips are copied
        # whatever their rates, and the renderer turns each into the project rate. An HDR clip is copied
        # too: this 8-bit encode would flatten its colour, and the renderer already reads it as it is.
        if i in prep:
            done = sum(infos[k - 1][1]["duration"] for k in prep if k < i)
            progress("init", 100 * done / prep_total, PREPARING, force=True)
            dst = dst.with_suffix(".mp4")
            dst.parent.mkdir(parents=True, exist_ok=True)
            part = dst.with_suffix(".part.mp4")
            try:
                tools.ffmpeg_progress(
                    [tools.ffmpeg(), "-y", "-nostdin", "-hide_banner", "-i", str(f),
                     "-map", "0:v:0", "-map", "0:a:0",
                     # 4:2:0 needs even sides: screen and browser recordings can be 1365x767
                     "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
                     "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                     "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                     "-progress", "pipe:1", "-nostats", str(part)],
                    info["duration"],
                    lambda pct: progress("init", (100 * done + pct * info["duration"]) / prep_total, PREPARING),
                    max(300, info["duration"] * 10), "prepare constant frame rate video")
                part.replace(dst)
            finally:
                part.unlink(missing_ok=True)
            info = probemod.probe(dst, quick=True)
            steady.append(30.0)
        else:
            progress("init", 100 * (i - 1) / len(infos), "Copying your video", force=True)
            tools.safe_copy(f, dst)
            if not info["variableFrameRate"]:
                steady.append(info["fps"])
        proj["sources"].append({
            "id": f"s{i}", "path": f"media/{dst.name}", "originalName": f.name,
            "duration": info["duration"], "fps": info["fps"] or 30.0,
            "width": info["width"], "height": info["height"], "rotation": info["rotation"],
            "hdr": bool(info.get("hdr")), "hasAudio": info["hasAudio"],
            **({"capturedAt": info["capturedAt"]} if info.get("capturedAt") else {}),
        })
    # The final export keeps the smoothest steady rate up to 60; drafts and previews render at 30 or under
    # (render.preview_fps). Faster exports keeps the final at the default 30 too.
    smooth = [r for r in steady if 0 < r <= 60]
    if not faster_exports and smooth:
        proj["format"]["fps"] = max(smooth)
    proj["cover"]["source"] = "s1"
    check_mirror(project_dir, proj)
    projmod.save(project_dir, proj)
    progress("init", 100, "Your video is in", force=True)
    return {"project": str(project_dir), "id": proj["id"], "slug": proj["slug"],
            "sources": proj["sources"]}


def check_mirror(project_dir: Path, proj: dict) -> None:
    """Front-camera takes often come out mirrored (writing in the room reads backwards). Each take is
    looked at once, here, as it comes in (init is the only place takes are added), and keeps what was
    seen in `sources[].mirrorCheck`. Only a clearly mirrored take gets `mirror: true`, so every render
    flips it; the app says so with a one-click undo, and asks about a "maybe-mirrored" one instead.
    Nothing here ever un-flips or re-checks a take, and a file that was already un-mirrored reads as
    filmed, so a take is never flipped twice."""
    for i, s in enumerate(proj["sources"]):
        progress("init", 100 * i / len(proj["sources"]), "Checking your video is the right way round", force=True)
        r = mirror_detect.detect(project_dir / s["path"], project_dir / "work", duration=s.get("duration"))
        s["mirrorCheck"] = mirror_detect.project_record(r)
        if r["verdict"] == "mirrored":
            s["mirror"] = True
