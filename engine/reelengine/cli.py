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
from pathlib import Path

from . import proto
from .proto import EngineError, progress


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise EngineError("BAD_ARGS", f"{self.prog}: {message}",
                          "Reel Studio sent the engine a request it didn't understand. "
                          "Please try again or reinstall the app.")


def _project(args) -> Path:
    if not args.project:
        raise EngineError("BAD_ARGS", "--project is required",
                          "Reel Studio didn't say which video to work on. Please try again.")
    return Path(args.project)


def cmd_probe(args):
    from . import probe
    return probe.probe(Path(args.file))


def cmd_classify(args):
    from . import classify
    return classify.run(Path(args.root) if args.root else None, [Path(f) for f in args.files],
                        move=args.move)


def cmd_init(args):
    from . import init as initmod
    return initmod.run(_project(args), args.title, [Path(f) for f in args.files], slug=args.slug)


def cmd_transcribe(args):
    from . import transcribe
    return transcribe.run(_project(args), model_name=args.model, language=args.language,
                          prompt=args.prompt, device=args.device)


def cmd_download_model(args):
    from . import transcribe
    return transcribe.download_model(args.name or transcribe.default_model())


def cmd_analyze(args):
    from . import analyze
    if getattr(args, "faces_only", False):
        return analyze.faces_only(_project(args))
    return analyze.run(_project(args))


def cmd_autocut(args):
    from . import analyze
    return analyze.autocut(_project(args), gap_cap=args.gap_cap)


def cmd_render(args):
    from . import render
    return render.run(_project(args), draft=args.draft, window=args.window,
                      root=Path(args.root) if args.root else None, verify=not args.no_verify,
                      first_look=args.first_look, music=args.music, cover=not args.no_cover)


def cmd_cover(args):
    from . import render
    return render.cover_only(_project(args), root=Path(args.root) if args.root else None)


def cmd_cover_candidates(args):
    from . import render
    moments = [float(t) for t in (args.at or "").split(",") if t.strip()]
    if not moments:
        raise EngineError("BAD_ARGS", "cover-candidates needs --at", "Reel Studio didn't say which moments to look at.")
    return render.cover_candidates(_project(args), moments, source=args.source,
                                   root=Path(args.root) if args.root else None)


def cmd_verify(args):
    from . import verify
    return verify.run(Path(args.file), expect_duration=args.expect_duration,
                      project_dir=Path(args.project) if args.project else None)


def cmd_frames(args):
    from . import frames
    times = [float(t) for t in args.times.split(",") if t.strip()]
    return frames.run(_project(args), times, file=Path(args.file) if args.file else None)


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


def _thumb(proj: Path, out: Path) -> str | None:
    """A small still the AI LOOKS at before placing a picture: a matching title can hide a wrong one."""
    try:
        from PIL import Image
        tdir = proj / "work" / "thumbs"
        tdir.mkdir(parents=True, exist_ok=True)
        with Image.open(out) as im:
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            bg.alpha_composite(im)
            bg = bg.convert("RGB")
            bg.thumbnail((320, 320))
            thumb = tdir / f"{out.stem}.jpg"
            bg.save(thumb, "JPEG", quality=80)
        return str(thumb)
    except Exception as e:  # noqa: BLE001 -- a missing thumbnail never costs the picture
        from .compose_util import log
        log(f"no thumbnail for {out.name}: {e}")
        return None


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
    Cached per file."""
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
    if args.no_beats:
        r.pop("beats", None)
    if not args.curve:
        r.pop("curve", None)
    return r


def cmd_anim_context(args):
    """Free region above the eyebrows + word times for an animation over --from..--to (see
    broll.anim_context). The AI calls this before rendering an animation."""
    from . import broll, project as projmod, render, tools
    pdir = _project(args).resolve()
    proj = projmod.load(pdir)
    words = projmod.load_transcript(pdir, proj)["words"]
    tl = projmod.timeline(pdir, proj, words)
    ctx = render.make_ctx(pdir, proj, tl, True, tools.root_dir(args.root), pdir / "work" / "render")
    return broll.anim_context(ctx, args.word_from, args.word_to, args.duration)


def cmd_attach(args):
    """A picture, GIF or short clip attached to a note -> <project>/work/assets/attach-* + sidecar."""
    from . import attach
    return attach.run(_project(args), Path(args.file), name=args.name)


def cmd_doctor(args):
    from . import doctor
    return doctor.run()


# Commands that change nothing in the project, and `attach`, which only adds its own uniquely named
# file: they run even while Reel Studio has the project open. Every other command given --project is
# refused then unless Reel Studio runs it (owner.py).
NOT_PROJECT_WRITES = {"probe", "doctor", "verify", "search-images", "analyze-music", "download-model",
                      "classify", "attach"}


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
    sp = add("classify", cmd_classify, "sort dropped files into the Library")
    sp.add_argument("--root", help="Reel Studio root (default REELENGINE_ROOT or ~/Documents/Reel Studio)")
    sp.add_argument("--move", action="store_true", help="move instead of copy")
    sp.add_argument("files", nargs="+")
    sp = add("init", cmd_init, "create a project from raw takes")
    sp.add_argument("--title", default="My video")
    sp.add_argument("--slug")
    sp.add_argument("files", nargs="+")
    sp = add("transcribe", cmd_transcribe, "speech to words")
    sp.add_argument("--model")
    sp.add_argument("--language")
    sp.add_argument("--prompt")
    sp.add_argument("--device", choices=["auto", "cuda", "cpu"])
    sp = add("download-model", cmd_download_model, "download the speech model")
    sp.add_argument("--name")
    sp = add("analyze", cmd_analyze, "pauses, retakes, default cut")
    sp.add_argument("--faces-only", action="store_true", help="only the face track (no transcript needed)")
    sp = add("autocut", cmd_autocut, "write the deterministic default cut")
    sp.add_argument("--gap-cap", type=float)
    sp = add("render", cmd_render, "render project.json")
    sp.add_argument("--draft", action="store_true")
    sp.add_argument("--window", help="a:b output seconds")
    sp.add_argument("--root")
    sp.add_argument("--no-verify", action="store_true")
    sp.add_argument("--no-cover", action="store_true", help="skip cover.png (previews)")
    sp.add_argument("--first-look", action="store_true",
                    help="preview of the deterministic edit (default cut + captions) without saving it")
    sp.add_argument("--music", help="Library/... song for --first-look when the project has none")
    sp = add("cover-candidates", cmd_cover_candidates, "the best cover frame near each moment, as stills")
    sp.add_argument("--at", required=True, help="raw-take seconds t1,t2,...")
    sp.add_argument("--source")
    sp.add_argument("--root")
    sp = add("cover", cmd_cover, "render cover.png only")
    sp.add_argument("--root")
    sp = add("verify", cmd_verify, "check an mp4")
    sp.add_argument("file")
    sp.add_argument("--expect-duration", type=float)
    sp = add("frames", cmd_frames, "extract frames from the latest render")
    sp.add_argument("--times", required=True)
    sp.add_argument("--file")
    add("captions", cmd_captions, "write the caption file only (debug)")
    add("doctor", cmd_doctor, "check the install")
    sp = add("search-images", cmd_search_images, "find freely licensed pictures on the web")
    sp.add_argument("--query")
    sp.add_argument("--n", type=int, default=8)
    sp.add_argument("--copyrighted", action="store_true",
                    help="also posters/stills of shows and films (copyrighted; labelled as such)")
    sp.add_argument("words", nargs="*")
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
    sp = add("attach", cmd_attach, "add a picture, GIF or short clip attached to a note")
    sp.add_argument("file")
    sp.add_argument("--name", help="the file's original name (shown to the user)")
    sp = add("analyze-music", cmd_analyze_music, "tempo, energy and a good start point of a song")
    sp.add_argument("file", nargs="?")
    sp.add_argument("--track")
    sp.add_argument("--root")
    sp.add_argument("--no-beats", action="store_true")
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
                              "Reel Studio didn't tell the engine what to do. Please try again.")
        if sys.platform == "win32":
            from .contain import contain_children
            contain_children()
        if args.project and args.command not in NOT_PROJECT_WRITES:
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
    except MemoryError as exc:
        proto.error("OUT_OF_MEMORY", repr(exc),
                    "Your computer ran out of memory working on this video. Close other apps "
                    "and try again.")
        return 1
    except Exception as exc:   # noqa: BLE001 -- never die without telling the app why
        tb = traceback.format_exc()
        proto.log(tb)
        proto.error("INTERNAL", f"{type(exc).__name__}: {exc}\n{tb[-1500:]}",
                    "Something unexpected went wrong. Please try again; if it keeps happening, "
                    "restart Reel Studio.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
