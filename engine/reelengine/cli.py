"""`python -m reelengine <command> ...` -- the engine CLI (docs/architecture.md section 4).

stdout carries JSON lines only (progress / done / error); everything else goes to stderr.
Exit code 0 on done, 1 on error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import traceback
import uuid
from pathlib import Path

from . import proto
from .proto import EngineError, progress


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise EngineError("BAD_ARGS", f"{self.prog}: {message}",
                          "Something inside Reel Studio went wrong, "
                          "so try again or reinstall the app.")


def _project(args) -> Path:
    if not args.project:
        raise EngineError("BAD_ARGS", "--project is required",
                          "Reel Studio didn't say which video to work on. Please try again.")
    return Path(args.project)


def _in_work(args, option: str):
    """A path option that must stay inside <project>/work (a note's private document and drafts)."""
    value = getattr(args, option, None)
    if not value:
        return None
    pdir = _project(args).resolve()
    path = (pdir / value).resolve()
    if not path.is_relative_to(pdir / "work"):
        raise EngineError("UNSAFE_PATH", f"--{option.replace('_', '-')} {value} is outside {pdir / 'work'}",
                          "Reel Studio stopped because a file was outside this video's folder, so try again.")
    return path


def cmd_probe(args):
    from . import probe
    return probe.probe(Path(args.file))


def cmd_export_probe(args):
    from . import export_media
    return export_media.inspect(Path(args.file))


def cmd_export_media(args):
    from . import export_media
    if args.bitrate is None:
        if args.brightness:
            raise EngineError("BAD_ARGS", "--brightness needs a re-encode", "The export settings are invalid.")
        return export_media.remux(Path(args.file), Path(args.dest))
    return export_media.encode(Path(args.file), Path(args.dest), args.bitrate, args.brightness)


def cmd_export_cover(args):
    from . import export_media
    return export_media.cover(Path(args.file), Path(args.dest), args.at, args.brightness)


def cmd_classify(args):
    from . import classify
    return classify.run(Path(args.root) if args.root else None, [Path(f) for f in args.files],
                        move=args.move)


def cmd_init(args):
    from . import init as initmod
    return initmod.run(_project(args), args.title, [Path(f) for f in args.files], slug=args.slug,
                       faster_exports=args.faster_exports, keep_order=args.keep_order)


def cmd_detect_mirror(args):
    """Does a take look mirrored? (the check `init` runs on every new take; mirror_detect.py)"""
    import tempfile
    from . import mirror_detect
    with tempfile.TemporaryDirectory() as work:
        return mirror_detect.detect(Path(args.file), Path(work))


def cmd_transcribe(args):
    from . import transcribe
    return transcribe.run(_project(args), model_name=args.model, language=args.language,
                          prompt=args.prompt, device=args.device)


def cmd_footage(args):
    from . import footage, tools
    root = tools.root_dir(args.root)
    if args.footage_command == "index":
        sources = []
        for item in args.source or []:
            sid, sep, folder = item.partition("=")
            if not sep or not folder:
                raise EngineError("BAD_ARGS", f"--source needs ID=FOLDER, got {item!r}",
                                  "A footage folder in your settings is damaged. Remove it and add it again.")
            sources.append((sid, folder))
        return footage.index(root, model_name=args.model, budget_seconds=args.budget_seconds, sources=sources)
    if args.footage_command == "digest":
        return footage.digest(root, refs=args.ref)
    return footage.search(root, args.query, limit=args.limit)


def cmd_measure_reel(args):
    """A reference reel's pace, opening line and cut rhythm (measure.py), for My style's reference reels."""
    from . import measure
    return measure.measure(Path(args.file), Path(args.poster) if args.poster else None)


def cmd_download_model(args):
    from . import transcribe
    return transcribe.download_model(args.name or transcribe.default_model())


def cmd_speech_check(args):
    from . import transcribe
    return transcribe.speech_check(args.name)


def cmd_analyze(args):
    from . import analyze
    if getattr(args, "faces_only", False):
        return analyze.faces_only(_project(args))
    return analyze.run(_project(args))


def cmd_autocut(args):
    from . import analyze
    return analyze.autocut(_project(args), gap_cap=args.gap_cap)


def cmd_make_variant(args):
    from .variation import create_variant
    try:
        value = json.loads(args.value) if args.value is not None else None
    except (ValueError, TypeError):
        raise EngineError("BAD_VARIANT", "--value must be JSON", "That choice couldn't be read, so try again.")
    return create_variant(_project(args), args.variable, value=value, project_file=_in_work(args, "project_file"))


def cmd_lint_edit(args):
    from . import project, render, tools
    from .lint_edit import prepare
    pdir = _project(args)
    edit = project.load(pdir)
    tl = project.timeline(pdir, edit)
    ctx = render.make_ctx(pdir, edit, tl, True, tools.root_dir(args.root), pdir / "work" / "render")
    return prepare(ctx, tl)


def cmd_sync_angles(args):
    """Line camera --angle up with camera --of by their sound; --write records it as sources[].angleOf."""
    from . import angles, project
    from .compose_util import ffmpeg_bin
    pdir = _project(args)
    proj = project.load(pdir)
    by = {s["id"]: s for s in proj["sources"]}
    if args.angle not in by or args.of not in by or args.angle == args.of:
        raise EngineError("BAD_ARGS", f"--angle {args.angle} --of {args.of}: two different sources of this project",
                          "Reel Studio asked to line up cameras this video doesn't have. Please try again.")
    res = angles.sync_offset(ffmpeg_bin(), project.source_path(pdir, by[args.of]), project.source_path(pdir, by[args.angle]))
    if args.write:
        by[args.angle]["angleOf"] = {"source": args.of, **res}
        project.save(pdir, proj)
    return {"angle": args.angle, "of": args.of, **res, "written": bool(args.write)}


def cmd_angles(args):
    """Which camera the picture would show on each segment of the cut, without rendering."""
    from . import angles, project
    from .compose_util import ffmpeg_bin
    pdir = _project(args)
    proj = project.load(pdir)
    words = project.load_transcript(pdir, proj)["words"]
    tl = project.timeline(pdir, proj, words)
    warnings: list = []
    _pic, rows = angles.picture_segments(pdir, proj, tl.segments, words, ffmpeg_bin(), warnings)
    return {"angles": rows, "warnings": warnings}


def cmd_match_joins(args):
    from . import project
    pdir = _project(args)
    # inside a note, the note's private copy of the edit (render does the same)
    note = _in_work(args, "project_file")
    edit = project.load(pdir, file=note) if note else project.load(pdir)
    if args.keep is not None:
        try:
            edit["cut"]["keep"] = json.loads(args.keep)
        except (ValueError, TypeError):
            raise EngineError("BAD_ARGS", "--keep must be JSON", "Reel Studio couldn't read this cut, so try again.")
    keep = edit["cut"]["keep"]
    if args.every and isinstance(keep, list):
        # ask the question for every join that could hold one: after the first range, never next to a clip
        for i, item in enumerate(keep):
            if i and isinstance(item, dict) and "clip" not in item and isinstance(keep[i - 1], dict) and "clip" not in keep[i - 1]:
                item["join"] = {"transition": "match", "frames": 0}
    problems = project.validate(edit)
    if problems:
        raise EngineError("BAD_PROJECT", "; ".join(problems[:8]), "This cut can't be checked. Undo the last change and try again.")
    tl = project.timeline(pdir, edit)
    return {"joins": [{"keep": m["keep"], "transition": m.get("transition", "match"), "matched": m["played"] == m.get("transition", "match"),
                       "at": round(tl.segments[m["in"]].out_start, 3) if "in" in m else None,
                       **{k: m[k] for k in ("why", "look", "move") if k in m}} for m in tl.match_joins]}


def cmd_pace_preview(args):
    """How often the picture would change under each pace, from the plan a render would make (no encode)."""
    import copy
    from . import project, render, tools
    from .cut_style import CUT_STYLES, OPENING, OPENING_MAX_UNSTYLED, visual_change_meter
    from .lint_edit import prepare
    pdir = _project(args)
    base = project.load(pdir)
    seed = (base.get("cutStyle") or {}).get("seed", 1)
    paces = {}
    for preset in [None, *CUT_STYLES]:
        edit = copy.deepcopy(base)
        if preset:
            edit["cutStyle"] = {"preset": preset, "seed": seed}
        else:
            edit.pop("cutStyle", None)
        tl = project.timeline(pdir, edit)
        ctx = render.make_ctx(pdir, edit, tl, True, tools.root_dir(args.root), pdir / "work" / "render")
        lint = prepare(ctx, tl)
        meter = visual_change_meter(tl.duration, tl.segments, ctx.lint_visuals, ctx.lint_zooms, fps=float(edit["format"]["fps"]))
        paces[preset or "none"] = {"perMinute": meter["overall"]["perMinute"], "opening": meter["first5"]["total"],
                                   "openingMax": CUT_STYLES[preset]["openingMax"] if preset else OPENING_MAX_UNSTYLED,
                                   "issues": sorted({i["rule"] for i in lint["issues"]})}
    return {"seconds": OPENING, "paces": paces}


def cmd_render(args):
    from . import render
    return render.run(_project(args), draft=args.draft, window=args.window,
                      root=Path(args.root) if args.root else None, verify=not args.no_verify,
                      first_look=args.first_look, music=args.music, cover=not args.no_cover,
                      project_file=_in_work(args, "project_file"), out=_in_work(args, "out"), job_id=args.job_id, parent=args.parent, merge_parent=args.merge_parent,
                      rules=args.rules)


def cmd_proxy(args):
    from . import proxy
    return proxy.run(_project(args))


def cmd_cover(args):
    from . import render
    return render.cover_only(_project(args), root=Path(args.root) if args.root else None)


def cmd_cover_candidates(args):
    from . import render
    moments = [float(t) for t in (args.at or "").split(",") if t.strip()]
    if not moments:
        raise EngineError("BAD_ARGS", "cover-candidates needs --at", "Reel Studio didn't say which moments to look at.")
    return render.cover_candidates(_project(args), moments, source=args.source,
                                   root=Path(args.root) if args.root else None, picker=args.picker,
                                   project_file=_in_work(args, "project_file"))


def cmd_verify(args):
    from . import verify
    return verify.run(Path(args.file), expect_duration=args.expect_duration,
                      project_dir=Path(args.project) if args.project else None)


def cmd_score(args):
    from . import score
    return score.run(_project(args), args.version)


def cmd_frames(args):
    from . import frames
    times = [float(t) for t in args.times.split(",") if t.strip()]
    words = [w.strip() for w in args.words.split(",") if w.strip()]
    return frames.run(_project(args), times, render_id=args.render_id, file=Path(args.file) if args.file else None,
                      project_file=_in_work(args, "project_file"), words=words)


def cmd_inspect_render(args):
    from . import render_identity
    return render_identity.inspect(_project(args), args.render_id)


def cmd_moments(args):
    from . import moments
    project_file = _in_work(args, "project_file")
    if args.mark:
        return moments.mark(_project(args), project_file)
    return moments.run(_project(args), root=Path(args.root) if args.root else None, draft=not args.no_draft,
                       project_file=project_file, out=_in_work(args, "out"), job_id=args.job_id,
                       parent=args.parent, merge_parent=args.merge_parent)


def cmd_captions(args):
    from . import captions
    return captions.write_for_project(_project(args))


def _rel_to(path: Path, base: Path, prefix: str = "") -> str | None:
    try:
        return prefix + path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError:
        return None


def cmd_search_images(args):
    from . import assets
    query = args.query or " ".join(args.words or [])
    progress("search", 10, "Looking for pictures", force=True)
    found = assets.search(query, n=args.n, copyrighted=True if args.copyrighted else None)
    res = {"query": query, "results": found["results"], "plan": found["plan"]}
    if found.get("website"):
        res["website"] = found["website"]
    return res


def _thumb(proj: Path, out: Path, stem: str | None = None) -> str | None:
    """A small still the AI LOOKS at before placing a picture: a matching title can hide a wrong one."""
    try:
        from PIL import Image, ImageOps
        tdir = proj / "work" / "thumbs"
        tdir.mkdir(parents=True, exist_ok=True)
        with Image.open(out) as im:
            # upright, as the renderer's open_image shows it: phone JPEGs store pixels sideways plus an EXIF turn
            im = ImageOps.exif_transpose(im).convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            bg.alpha_composite(im)
            bg = bg.convert("RGB")
            bg.thumbnail((320, 320))
            thumb = tdir / f"{stem or out.stem}.jpg"
            bg.save(thumb, "JPEG", quality=80)
        return str(thumb)
    except Exception as e:  # noqa: BLE001 -- a missing thumbnail never costs the picture
        from .compose_util import log
        log(f"no thumbnail for {out.name}: {e}")
        return None


def cmd_inspect_image(args):
    """A picture the AI is choosing (Library, attachment or download), read where it is: its size and
    a still of its own, so candidates inspected side by side never share one."""
    from PIL import Image, ImageOps
    from .safepath import safe_resolve
    proj = _project(args)
    src = safe_resolve(proj, args.asset, root=Path(args.root) if args.root else None, what="image")
    from .asset_freeze import kind_of, sha256_of
    _ext, mime = kind_of(src, "image")
    with Image.open(src) as im:
        width, height = ImageOps.exif_transpose(im).size  # the size the video shows, as the still is drawn
    thumb = _thumb(proj, src, stem=f"candidate-{uuid.uuid4().hex}")
    if not thumb:
        raise EngineError("NOT_AN_IMAGE", f"no still for {src.name}", "I couldn't open that picture. Try another one.")
    return {"previewPath": _rel_to(Path(thumb), proj), "width": width, "height": height, "sha256": sha256_of(src), "mime": mime}


def cmd_inspect_media(args):
    from .asset_preview import inspect
    return inspect(_project(args), Path(args.root) if args.root else None, args.asset, args.command == 'inspect-video', args.preview)


def cmd_freeze_asset(args):
    from .asset_freeze import freeze
    return freeze(_project(args), Path(args.root) if args.root else None, args.asset, args.kind, args.expect_sha256)


def cmd_hash_asset(args):
    from .asset_freeze import hash_file
    return hash_file(_project(args), Path(args.root) if args.root else None, args.asset)


def cmd_register_capture(args):
    """A website screenshot the app captured into <project>/work/assets: record its credit
    ("Screenshot of <site>") in credits.json and make the still the AI looks at."""
    from . import assets
    from .safepath import safe_child
    proj = _project(args)
    rel = (args.asset or "").replace("\\", "/")
    if not rel.startswith("work/assets/") or "/" in rel[len("work/assets/"):]:
        raise EngineError("BAD_ARGS", f"register-capture: bad asset {args.asset!r}",
                          "Reel Studio lost track of that screenshot. Please try again.")
    out = safe_child(proj / "work" / "assets", rel[len("work/assets/"):], "image")
    if not out.is_file():
        raise EngineError("NOT_FOUND", f"register-capture: {out} missing", "The screenshot wasn't saved. Please try again.")
    credit = assets.register_capture(out, args.url, args.title)
    res = {"asset": rel, "path": str(out), "credit": credit}
    thumb = _thumb(proj, out)
    if thumb:
        res["thumb"] = thumb
    return res


def cmd_fetch_image(args):
    """Image URL -> <project>/work/assets (or --dest). `asset` is the project-relative path the
    edit can use."""
    from . import assets
    url = args.url or args.url_pos
    if not url:
        raise EngineError("BAD_ARGS", "fetch-image needs --url", "Paste the picture's address and try again.")
    proj = Path(args.project).resolve() if args.project else None
    if args.dest:
        dest = Path(args.dest)
    elif proj:
        dest = proj / "work" / "assets"
    else:
        raise EngineError("BAD_ARGS", "fetch-image needs --project or --dest",
                          "Reel Studio didn't say where to save the picture. Please try again.")
    progress("fetch", 10, "Downloading the picture", force=True)
    out = assets.fetch_image(url, dest, name=args.name).resolve()
    res = {"path": str(out), "url": url}
    if proj:
        res["asset"] = _rel_to(out, proj)
        thumb = _thumb(proj, out)
        if thumb:
            res["thumb"] = thumb
    return res


def cmd_download_media(args):
    """A link (YouTube, TikTok, Instagram...) -> a video in Library/B-roll or a song in
    Library/Music (or --dest / the project's work/assets with --to-project)."""
    from . import assets, tools
    url = args.url or args.url_pos
    if not url:
        raise EngineError("BAD_ARGS", "download-media needs --url", "Paste the link and try again.")
    kind = "music" if args.kind in ("music", "audio") else "video"
    root = tools.root_dir(args.root)
    if args.dest:
        dest = Path(args.dest)
    elif args.to_project and args.project:
        dest = Path(args.project) / "work" / "assets"
    else:
        dest = root / "Library" / ("Music" if kind == "music" else "B-roll")
    msg = "Downloading the song" if kind == "music" else "Downloading the video"
    progress("download", 1, msg, force=True)
    out = assets.download_media(url, dest, kind=kind, name=args.name,
                                progress=lambda pct: progress("download", pct, msg))
    out = Path(out).resolve()
    res = {"path": str(out), "kind": kind, "url": url}
    ref = _rel_to(out, root)
    if ref:
        res["asset"] = ref
    elif args.project:
        res["asset"] = _rel_to(out, Path(args.project))
    return res


def _music_features(p: Path) -> dict:
    """music.analyze_track, cached by the song's CONTENT across runs and paths
    (music.analyze_track_cached: one cache for the single-song and the --library calls)."""
    from . import music
    return music.analyze_track_cached(p)


def cmd_analyze_music(args):
    """Tempo, energy, mood, loudness curve and a suggested start point for a song. `file` may be a
    path or a Library/... reference (resolved against the Reel Studio root). `--library`: every song
    in Library/Music at once (one process; the AI listens to the whole library on each edit).
    `--fps`: also the beat grid to store in project.music.beats (beats.quantise). Cached per file."""
    from . import tools
    if args.library:
        lib = tools.root_dir(args.root) / "Library" / "Music"
        exts = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}
        files = sorted((f for f in lib.iterdir() if f.suffix.lower() in exts and f.is_file()), key=lambda f: f.name.lower()) if lib.exists() else []
        songs = []
        for n, f in enumerate(files):
            progress("music", 100 * n / max(1, len(files)), "Listening to your music", force=True)
            try:
                r = dict(_music_features(f))
            except EngineError as e:
                songs.append({"track": f"Library/Music/{f.name}", "error": e.user_message if hasattr(e, "user_message") else str(e)})
                continue
            songs.append({"track": f"Library/Music/{f.name}", **{k: r.get(k) for k in
                          ("duration", "bpm", "energy", "mood", "tags", "integratedLUFS", "dynamicRangeDb", "suggestedStartAt")}})
        return {"songs": songs}
    ref = args.file or args.track
    if not ref:
        raise EngineError("BAD_ARGS", "analyze-music needs a file", "Pick a song and try again.")
    p = Path(ref)
    if not p.is_absolute() and not p.exists():
        cand = tools.root_dir(args.root) / ref
        if args.project and not cand.exists():
            cand = Path(args.project) / ref
        p = cand
    if not p.exists():
        raise EngineError("MUSIC_MISSING", f"no such song: {p}", "I can't find that song. Pick another one.")
    progress("music", 10, "Listening to the song", force=True)
    r = dict(_music_features(p))
    if args.fps:
        from . import beats
        r["beatGrid"] = beats.quantise(r.get("beats") or [], args.fps, r["duration"], beats.file_sha256(p))
    if args.no_beats:
        r.pop("beats", None)
    if not args.curve:
        r.pop("curve", None)
    return r


def cmd_anim_context(args):
    """Free region above the eyebrows + word times for an animation over --from..--to (see
    broll.anim_context). The AI calls this before rendering an animation."""
    from . import broll
    return broll.anim_context(_anim_ctx(args), args.word_from, args.word_to, args.duration)


def _anim_ctx(args):
    """A draft render context for the project (cut, words, face track): nothing is rendered."""
    from . import project as projmod, render, tools
    pdir = _project(args).resolve()
    proj = projmod.load(pdir, file=_in_work(args, "project_file"))
    words = projmod.load_transcript(pdir, proj)["words"]
    tl = projmod.timeline(pdir, proj, words)
    return render.make_ctx(pdir, proj, tl, True, tools.root_dir(args.root), pdir / "work" / "render")


def cmd_anim_jobs(args):
    """Animation clips the current cut needs re-rendered (beats re-timed to the words, see
    anim_timing). The app renders each one before a render."""
    from . import anim_timing
    return {"jobs": anim_timing.jobs(_anim_ctx(args))}


def cmd_attach(args):
    """A picture, GIF or short clip attached to a note -> <project>/work/assets/attach-* + sidecar."""
    from . import attach
    return attach.run(_project(args), Path(args.file), name=args.name)


def cmd_fonts(args):
    """The caption fonts a project can name: each file's names (captions.font_index), the person's own first."""
    from . import captions, tools
    out, seen = [], set()
    yours = Path(tools.root_dir(None)) / "Library" / "Fonts"
    for folder in tools.font_dirs():
        for path in sorted(folder.iterdir()):
            if path.suffix.lower() not in (".ttf", ".otf") or path in seen:
                continue
            seen.add(path)
            try:
                names = captions._ttf_metrics(path)["names"]
            except Exception:  # noqa: BLE001  a damaged file is left out, as font_index leaves it out
                continue
            out.append({"names": sorted(names | {path.stem}), "file": path.name,
                        "yours": folder.resolve() == yours.resolve()})
    return {"fonts": out, "default": captions.DEFAULT_FONT}


def cmd_doctor(args):
    from . import doctor
    return doctor.run()


def cmd_import_reference(args):
    from . import reference_import
    return reference_import.run(Path(args.file), Path(args.output) if args.output else None)


def cmd_reference_scan(args):
    from . import reference_import
    return reference_import.scan([Path(f) for f in args.files])


# Commands that change nothing in the project, `attach`, which only adds its own uniquely named file,
# and `proxy`, which writes only work/proxy/ under its own per-take lock (proxy.py) and outlives the job
# that starts it: they run even while Reel Studio has the project open. Every other command given
# --project is refused then unless Reel Studio runs it (owner.py). `score` only reads a saved version's
# folder, which no job rewrites.
NOT_PROJECT_WRITES = {"probe", "doctor", "verify", "search-images", "analyze-music", "download-model",
                      "classify", "attach", "proxy", "score"}


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(prog="reelengine", description="Reel Studio media engine")
    sub = p.add_subparsers(dest="command", parser_class=_Parser)

    def add(name, fn, help_):
        sp = sub.add_parser(name, help=help_)
        sp.set_defaults(fn=fn)
        sp.add_argument("--project", help="project folder")
        sp.add_argument("--owner", help="token of the Reel Studio job that has the project open (owner.py)")
        return sp

    sp = add("probe", cmd_probe, "describe a media file")
    sp.add_argument("file")
    sp = add("export-probe", cmd_export_probe, "read what a platform export decides on: size, audio bitrate, edit lists")
    sp.add_argument("file")
    sp = add("export-media", cmd_export_media, "re-encode a finished edit to fit a platform's size limit, or only redo its audio")
    sp.add_argument("file")
    sp.add_argument("--dest", required=True)
    sp.add_argument("--bitrate", type=int, help="video bits per second for a re-encode at the same size; without it, copy the video")
    sp.add_argument("--brightness", type=float, default=0.0, help="with a re-encode: brighten (+) or darken (-), -0.3 to 0.3")
    sp = add("export-cover", cmd_export_cover, "save a JPEG cover from a video frame or a picture")
    sp.add_argument("file")
    sp.add_argument("--dest", required=True)
    sp.add_argument("--at", type=float, help="seconds into a video (default: the whole picture)")
    sp.add_argument("--brightness", type=float, default=0.0, help="brighten (+) or darken (-) the cover, -0.3 to 0.3")
    sp = add("classify", cmd_classify, "sort dropped files into the Library")
    sp.add_argument("--root", help="Reel Studio root (default REELENGINE_ROOT or ~/Documents/Reel Studio)")
    sp.add_argument("--move", action="store_true", help="move instead of copy")
    sp.add_argument("files", nargs="+")
    sp = add("init", cmd_init, "create a project from raw takes")
    sp.add_argument("--faster-exports", action="store_true")
    sp.add_argument("--keep-order", action="store_true",
                    help="number the sources in the order given, not by capture time")
    sp.add_argument("--title", default="My video")
    sp.add_argument("--slug")
    sp.add_argument("files", nargs="+")
    sp = add("detect-mirror", cmd_detect_mirror, "does a take look mirrored (writing reads backwards)?")
    sp.add_argument("file")
    sp = add("transcribe", cmd_transcribe, "speech to words")
    sp.add_argument("--model")
    sp.add_argument("--language")
    sp.add_argument("--prompt")
    sp.add_argument("--device", choices=["auto", "cuda", "cpu"])
    sp = sub.add_parser("footage", help="index and search Library footage")
    footage_sub = sp.add_subparsers(dest="footage_command", required=True, parser_class=_Parser)
    for action in ("index", "search", "digest"):
        fp = footage_sub.add_parser(action)
        fp.set_defaults(fn=cmd_footage)
        fp.add_argument("--root", help="Reel Studio root")
        if action == "index":
            fp.add_argument("--source", action="append",
                            help="ID=FOLDER: an added footage folder, indexed with the Library (repeatable)")
            fp.add_argument("--model")
            fp.add_argument("--budget-seconds", type=float, help="stop between stages after this budget")
        elif action == "digest":
            fp.add_argument("--ref", action="append",
                            help="only this file, as Library/... or Footage/<folder>/... (repeatable)")
        elif action == "search":
            fp.add_argument("--query", required=True)
            fp.add_argument("--limit", type=int, default=8)
    add("fonts", cmd_fonts, "list the caption fonts a project can name")
    sp = add("measure-reel", cmd_measure_reel, "how fast a finished reel talks and cuts, and its opening line")
    sp.add_argument("--file", required=True)
    sp.add_argument("--poster", help="save one still of the reel here (jpg)")
    sp = add("download-model", cmd_download_model, "download the speech model")
    sp.add_argument("--name")
    sp = add("speech-check", cmd_speech_check, "time the speech model at a few thread counts on a short sample")
    sp.add_argument("--name")
    sp = add("analyze", cmd_analyze, "pauses, retakes, default cut")
    sp.add_argument("--faces-only", action="store_true", help="only the face track (no transcript needed)")
    sp = add("make-variant", cmd_make_variant, "save a one-variable trial")
    sp.add_argument("--variable", required=True, choices=["seed", "hook", "cover", "caption", "brightness"])
    sp.add_argument("--value", help="editor's alternative, encoded as JSON; omit for a new seed or +8%% exposure")
    sp.add_argument("--project-file", help="a note's private copy of project.json: the edit to change")
    sp = add("autocut", cmd_autocut, "write the deterministic default cut")
    sp.add_argument("--gap-cap", type=float)
    sp = add("lint-edit", cmd_lint_edit, "check the edit without rendering")
    sp.add_argument("--root")
    sp = add("match-joins", cmd_match_joins, "say which joins of the cut can be match cuts")
    sp.add_argument("--keep", help="cut.keep to check instead of the project's, as JSON")
    sp.add_argument("--every", action="store_true", help="check every join that could hold a match, not only the ones that ask for it")
    sp.add_argument("--project-file", help="the edit to read instead of project.json, inside work/ (a note's private copy)")
    sp = add("sync-angles", cmd_sync_angles, "line one camera up with another by their sound")
    sp.add_argument("--angle", required=True, help="the other camera's source id")
    sp.add_argument("--of", required=True, help="the main camera's source id")
    sp.add_argument("--write", action="store_true", help="record the offset in project.json (sources[].angleOf)")
    add("angles", cmd_angles, "which camera the picture shows on each segment, without rendering")
    sp = add("pace-preview", cmd_pace_preview, "count the picture changes each pace would make, without rendering")
    sp.add_argument("--root")
    sp = add("render", cmd_render, "render project.json")
    sp.add_argument("--draft", action="store_true")
    sp.add_argument("--window", help="a:b output seconds")
    sp.add_argument("--root")
    sp.add_argument("--no-verify", action="store_true")
    sp.add_argument("--no-cover", action="store_true", help="skip cover.png (previews)")
    sp.add_argument("--first-look", action="store_true",
                    help="preview of the deterministic edit (default cut + captions) without saving it")
    sp.add_argument("--music", help="Library/... song for --first-look when the project has none")
    sp.add_argument("--project-file", help="render this project document instead of project.json")
    sp.add_argument("--rules", help="JSON file of checkable My style rules (rule_checks.py); the result's "
                                    "`ruleChecks` lists the ones this render breaks")
    sp.add_argument("--parent", type=int, help="saved version this edit is based on (default: latest)")
    sp.add_argument("--merge-parent", type=int, help="second saved parent; always makes a new final version")
    sp.add_argument("--out", help="folder for a draft (default versions/preview)")
    sp.add_argument("--job-id", help="the app job this render belongs to (recorded in its receipt)")
    add("proxy", cmd_proxy, "make the 1080p copy of each 4K or HDR take that previews read")
    sp = add("cover-candidates", cmd_cover_candidates, "the best cover frame near each moment, as stills")
    sp.add_argument("--at", required=True, help="raw-take seconds t1,t2,...")
    sp.add_argument("--source")
    sp.add_argument("--picker", action="store_true", help="stills for the app's cover picker (work/cover-picker)")
    sp.add_argument("--root")
    sp.add_argument("--project-file")
    sp = add("cover", cmd_cover, "render cover.png only")
    sp.add_argument("--root")
    sp = add("verify", cmd_verify, "check an mp4")
    sp.add_argument("file")
    sp.add_argument("--expect-duration", type=float)
    sp = add("score", cmd_score, "the mechanical checks one saved version passes (score.py); reads its reports, renders nothing")
    sp.add_argument("--version", type=int, required=True)
    sp = add("frames", cmd_frames, "stills: of one render, or of the edit (from a render that is up to date, else drawn directly)")
    sp.add_argument("--render-id")
    sp.add_argument("--project-file", help="a note's private copy of project.json: the edit to show")
    sp.add_argument("--words", default="", help="word ids: a still at the middle of each")
    sp.add_argument("--times", default="")
    sp.add_argument("--file")
    sp = add("inspect-render", cmd_inspect_render, "one render's own reports")
    sp.add_argument("--render-id", required=True)
    sp = add("moments", cmd_moments, "stills of what the last edit changed, then the window around them, then the draft")
    sp.add_argument("--mark", action="store_true", help="only record the project as it is as the state shown")
    sp.add_argument("--no-draft", action="store_true", help="stop after the stills and the window")
    sp.add_argument("--root")
    sp.add_argument("--project-file", help="a note's private copy of project.json: the edit to show")
    sp.add_argument("--out", help="folder for the stills, window and draft (default versions/preview)")
    sp.add_argument("--parent", type=int, help="as render's: the saved version this edit is based on")
    sp.add_argument("--merge-parent", type=int, help="as render's: a second saved parent")
    sp.add_argument("--job-id", help="as render's: the app job the draft belongs to")
    add("captions", cmd_captions, "write the caption file only (debug)")
    add("doctor", cmd_doctor, "check the install")
    sp = add("import-reference", cmd_import_reference, "import FCPXML or Premiere FCP7 XML")
    sp.add_argument("file")
    sp.add_argument("--output", help="write the import record as JSON")
    sp = add("reference-scan", cmd_reference_scan, "count the timelines import-reference would read from each export")
    sp.add_argument("files", nargs="+")
    sp = add("search-images", cmd_search_images, "find freely licensed pictures on the web")
    sp.add_argument("--query")
    sp.add_argument("--n", type=int, default=8)
    sp.add_argument("--copyrighted", action="store_true",
                    help="also posters/stills of shows and films (copyrighted; labelled as such)")
    sp.add_argument("words", nargs="*")
    sp = add("inspect-image", cmd_inspect_image, "a picture's size and a still of it for the AI to look at")
    sp.add_argument("--asset", required=True)
    sp.add_argument("--root")
    for name in ('inspect-video', 'inspect-audio'):
        sp = add(name, cmd_inspect_media, 'a local contact sheet or waveform for an asset candidate')
        sp.add_argument('--asset', required=True)
        sp.add_argument('--root')
        sp.add_argument('--preview')
    sp = add("freeze-asset", cmd_freeze_asset, "copy a picture, clip or song into work/assets/frozen (a clone where the disk supports it)")
    sp.add_argument("--asset", required=True)
    sp.add_argument("--kind", required=True)
    sp.add_argument("--root")
    sp.add_argument("--expect-sha256")
    sp = add("hash-asset", cmd_hash_asset, "sha256 of a project or Library file, read in chunks")
    sp.add_argument("--asset", required=True)
    sp.add_argument("--root")
    sp = add("register-capture", cmd_register_capture, "credit a website screenshot saved in work/assets")
    sp.add_argument("--asset", required=True)
    sp.add_argument("--url", required=True)
    sp.add_argument("--title")
    sp = add("fetch-image", cmd_fetch_image, "download a picture into the project")
    sp.add_argument("--url")
    sp.add_argument("url_pos", nargs="?")
    sp.add_argument("--dest")
    sp.add_argument("--name")
    sp = add("download-media", cmd_download_media, "download a video or song from a link")
    sp.add_argument("--url")
    sp.add_argument("url_pos", nargs="?")
    sp.add_argument("--kind", choices=["video", "music", "audio"], default="video")
    sp.add_argument("--dest")
    sp.add_argument("--root")
    sp.add_argument("--name")
    sp.add_argument("--to-project", action="store_true", help="save into <project>/work/assets")
    sp = add("anim-context", cmd_anim_context, "free region above the face + word times for an animation")
    sp.add_argument("--from", dest="word_from", required=True)
    sp.add_argument("--to", dest="word_to", required=True)
    sp.add_argument("--duration", type=float)
    sp.add_argument("--root")
    sp.add_argument("--project-file")
    sp = add("anim-jobs", cmd_anim_jobs, "animation clips to re-render for the current cut")
    sp.add_argument("--root")
    sp.add_argument("--project-file")
    sp = add("attach", cmd_attach, "add a picture, GIF or short clip attached to a note")
    sp.add_argument("file")
    sp.add_argument("--name", help="the file's original name (shown to the user)")
    sp = add("analyze-music", cmd_analyze_music, "tempo, energy and a good start point of a song")
    sp.add_argument("file", nargs="?")
    sp.add_argument("--track")
    sp.add_argument("--root")
    sp.add_argument("--no-beats", action="store_true")
    sp.add_argument("--fps", type=float, help="add beatGrid: the beats as whole frames at this rate")
    sp.add_argument("--curve", action="store_true", help="include the 5 s loudness curve")
    sp.add_argument("--library", action="store_true", help="every song in Library/Music (features only)")
    return p


def main(argv=None) -> int:
    proto.capture_stdout()
    try:
        parser = build_parser()
        args = parser.parse_args(argv)
        if not getattr(args, "fn", None):
            raise EngineError("BAD_ARGS", "no command given",
                              "Something inside Reel Studio went wrong, so try again.")
        # commands without a project (footage search, Library indexing) have nothing to own
        if getattr(args, "project", None) and args.command not in NOT_PROJECT_WRITES:
            from . import owner
            owner.check(Path(args.project), args.owner)
        result = args.fn(args)
        proto.done(result)
        return 0
    except EngineError as exc:
        proto.log(f"error {exc.code}: {exc.message}")
        proto.error(exc.code, exc.message, exc.user_message)
        return 1
    except KeyboardInterrupt:
        proto.error("CANCELLED", "interrupted", "Stopped.")
        return 1
    except OSError as exc:
        # a full disk while writing (errno ENOSPC, EDQUOT; Windows ERROR_DISK_FULL): say what to do, not "unexpected"
        if not proto.disk_full(exc):
            tb = traceback.format_exc()
            proto.log(tb)
            proto.error("INTERNAL", f"{type(exc).__name__}: {exc}\n{tb[-1500:]}",
                        "Something unexpected went wrong, so try again, and restart Reel Studio if it keeps happening.")
            return 1
        proto.error("NO_SPACE", repr(exc), proto.NO_SPACE_MESSAGE)
        return 1
    except MemoryError as exc:
        proto.error("OUT_OF_MEMORY", repr(exc),
                    "Your computer ran out of memory working on this video, so close other apps "
                    "and try again.")
        return 1
    except Exception as exc:   # noqa: BLE001 -- never die without telling the app why
        tb = traceback.format_exc()
        proto.log(tb)
        proto.error("INTERNAL", f"{type(exc).__name__}: {exc}\n{tb[-1500:]}",
                    "Something unexpected went wrong, so try again, and restart Reel Studio if it "
                    "keeps happening.")
        return 1


def run() -> int:
    """The engine as a process (`python -m reelengine`, the `reelengine` command): on Windows it first
    joins the Job Object that ends its ffmpeg with it. main() alone does not, because tests call it
    inside their own process."""
    if sys.platform == "win32":
        from .contain import contain_children
        contain_children()
    return main()


if __name__ == "__main__":
    sys.exit(run())
