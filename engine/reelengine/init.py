"""`init --project <dir> --title T <files>...`: create the project folder + project.json, copy media."""
from __future__ import annotations

from pathlib import Path

from . import probe as probemod, project as projmod, tools
from .proto import EngineError, progress


def _media_name(i: int, src: Path) -> str:
    ext = src.suffix.lower() or ".mp4"
    return f"take{i:02d}{ext}"


def run(project_dir: Path, title: str, files: list, slug: str = None, faster_exports: bool = False) -> dict:
    project_dir = Path(project_dir)
    if projmod.project_file(project_dir).exists():
        raise EngineError("PROJECT_EXISTS", f"{project_dir} already has a project.json",
                          "There's already a video project here. Pick a different name.")
    if not files:
        raise EngineError("NO_FILES", "no files given", "Drop in at least one video to start.")
    infos = []
    for f in files:
        f = Path(f)
        info = probemod.probe(f, quick=True)
        if not info["hasVideo"] or info["kind"] == "image":
            raise EngineError("NOT_VIDEO", f"{f} has no video stream",
                              f"\"{f.name}\" isn't a video. Drop in the video of you talking.")
        if not info["hasAudio"]:
            raise EngineError("NO_AUDIO", f"{f} has no audio stream",
                              f"\"{f.name}\" has no sound. Try a different file.")
        if info["duration"] < 1.0:
            raise EngineError("TOO_SHORT", f"{f} is {info['duration']}s",
                              f"\"{f.name}\" is too short to make a video from.")
        infos.append((f, info))

    proj = projmod.new_project(title, slug=slug or projmod.slugify(project_dir.name, projmod.slugify(title)))
    normalize = any(info["variableFrameRate"] for _, info in infos) or len({info["fps"] for _, info in infos}) > 1
    if not faster_exports and not normalize and all(59.9 <= info["fps"] <= 60 for _, info in infos):
        proj["format"]["fps"] = 60
    media = project_dir / "media"
    (project_dir / "work").mkdir(parents=True, exist_ok=True)
    (project_dir / "versions").mkdir(parents=True, exist_ok=True)
    for i, (f, info) in enumerate(infos, start=1):
        progress("init", 100 * (i - 1) / len(infos), "Copying your video", force=True)
        dst = media / _media_name(i, f)
        if normalize:
            progress("init", 100 * (i - 1) / len(infos), "Preparing your video", force=True)
            dst = dst.with_suffix(".mp4")
            dst.parent.mkdir(parents=True, exist_ok=True)
            part = dst.with_suffix(".part.mp4")
            try:
                tools.ffmpeg_progress(
                    [tools.ffmpeg(), "-y", "-nostdin", "-hide_banner", "-i", str(f),
                     "-map", "0:v:0", "-map", "0:a:0", "-vf", "fps=30",
                     "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                     "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                     "-progress", "pipe:1", "-nostats", str(part)],
                    info["duration"],
                    lambda pct: progress("init", (100 * (i - 1) + pct) / len(infos), "Preparing your video"),
                    max(300, info["duration"] * 10), "prepare constant frame rate video")
                part.replace(dst)
            finally:
                part.unlink(missing_ok=True)
            info = probemod.probe(dst, quick=True)
        else:
            tools.safe_copy(f, dst)
        proj["sources"].append({
            "id": f"s{i}", "path": f"media/{dst.name}", "originalName": f.name,
            "duration": info["duration"], "fps": info["fps"] or 30.0,
            "width": info["width"], "height": info["height"], "rotation": info["rotation"],
            "hdr": bool(info.get("hdr")),
        })
    proj["cover"]["source"] = "s1"
    projmod.save(project_dir, proj)
    progress("init", 100, "Your video is in", force=True)
    return {"project": str(project_dir), "id": proj["id"], "slug": proj["slug"],
            "sources": proj["sources"]}
