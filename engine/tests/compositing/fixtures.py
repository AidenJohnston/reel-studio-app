"""Fixtures shared by the compositing tests and the demo script: a project around a video,
generated test images/clips, and a RenderCtx built the way A1's render builds it."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from reelengine.render_ctx import RenderCtx, Segment

# Real raw takes / songs are read IN PLACE from these folders (never copied into the repo).
# Default: <repo>/testdata/takes and <repo>/testdata/music (gitignored).
_REPO = Path(__file__).resolve().parents[3]
REAL_TAKES = Path(os.environ.get("REELENGINE_TEST_TAKES") or _REPO / "testdata" / "takes")
REAL_MUSIC = Path(os.environ.get("REELENGINE_TEST_MUSIC") or _REPO / "testdata" / "music")
FFMPEG = os.environ.get("REELENGINE_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("REELENGINE_FFPROBE") or shutil.which("ffprobe") or "ffprobe"


def real_take(name: str = "2026-09-02_talkinghead_day-38-ci-contractors.mp4"):
    p = REAL_TAKES / name
    return p if p.exists() else None


def real_song(name: str = "2026-07-29_music_ref_bliss-lofi-hip-hop-beat-free-for-profit-use.mp3"):
    p = REAL_MUSIC / name
    return p if p.exists() else None


def synth_video(path: Path, dur: float = 12.0, w: int = 1080, h: int = 1920, tone: bool = True) -> Path:
    """A test 'talking head': grey frame with a skin-toned box, plus a gated tone as 'speech'."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path
    vf = (f"color=c=0x6a6560:s={w}x{h}:r=30:d={dur},"
          f"drawbox=x={w * 0.3:.0f}:y={h * 0.3:.0f}:w={w * 0.4:.0f}:h={h * 0.3:.0f}:color=0xd9a98c:t=fill")
    af = f"sine=f=220:d={dur}:sample_rate=48000,volume='if(lt(mod(t,1.2),0.8),0.3,0.0)':eval=frame"
    cmd = [FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf]
    if tone:
        cmd += ["-f", "lavfi", "-i", af]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if tone:
        cmd += ["-c:a", "aac", "-shortest"]
    cmd += [str(path)]
    subprocess.run(cmd, check=True)
    return path


def synth_clip(path: Path, dur: float = 5.0, w: int = 1280, h: int = 720) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r=30:d={dur}",
                        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def synth_tone_song(path: Path, dur: float = 40.0) -> Path:
    """A generated 'song': a 120 bpm kick pulse over a chord pad (no copyrighted audio needed)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        expr = ("0.25*sin(2*PI*220*t)+0.2*sin(2*PI*277*t)+0.2*sin(2*PI*330*t)"
                "+0.8*sin(2*PI*60*t)*exp(-30*mod(t,0.5))")
        subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                        f"aevalsrc='{expr}':s=48000:d={dur}", "-ac", "2", str(path)], check=True)
    return path


def synth_images(d: Path) -> dict:
    """Generated test images: a landscape screenshot, a portrait post, transparent logos, posts."""
    from PIL import Image, ImageDraw
    from reelengine.compose_util import load_font
    d.mkdir(parents=True, exist_ok=True)
    out = {}
    p = d / "screenshot.png"
    if not p.exists():
        im = Image.new("RGB", (1600, 900), (246, 246, 248))
        dr = ImageDraw.Draw(im)
        dr.rectangle([0, 0, 1600, 110], fill=(40, 90, 200))
        dr.text((40, 22), "Example Pricing Page", font=load_font(64), fill="white")
        dr.text((60, 200), "Premium plan", font=load_font(90), fill=(20, 20, 20))
        dr.text((60, 360), "$19.99 / week", font=load_font(150), fill=(200, 40, 40))
        dr.text((60, 620), "Billed weekly. Cancel anytime.", font=load_font(60, "semibold"), fill=(90, 90, 90))
        im.save(p)
    out["screenshot"] = p
    p = d / "portrait-post.png"
    if not p.exists():
        im = Image.new("RGB", (1080, 1920), (250, 214, 120))
        dr = ImageDraw.Draw(im)
        dr.ellipse([240, 500, 840, 1100], fill=(230, 120, 60))
        dr.text((120, 1300), "POST", font=load_font(200), fill=(30, 30, 30))
        im.save(p)
    out["portrait"] = p
    for col, name in [((230, 60, 90), "logo-red"), ((20, 20, 20), "logo-dark"), ((40, 160, 90), "logo-green"),
                      ((60, 90, 220), "logo-blue"), ((240, 170, 30), "logo-gold"), ((140, 60, 200), "logo-purple")]:
        p = d / f"{name}.png"
        if not p.exists():
            im = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
            dr = ImageDraw.Draw(im)
            dr.rounded_rectangle([40, 40, 472, 472], 110, fill=col + (255,))
            dr.text((150, 150), name[5].upper(), font=load_font(220), fill=(255, 255, 255, 255))
            im.save(p)
        out[name] = p
    posts = d / "posts"
    posts.mkdir(exist_ok=True)
    for k in range(6):
        p = posts / f"post{k}.png"
        if not p.exists():
            im = Image.new("RGB", (540, 960), (40 + 35 * k, 90 + 20 * k, 160 - 15 * k))
            ImageDraw.Draw(im).text((60, 400), f"#{k + 1}", font=load_font(200), fill="white")
            im.save(p)
    out["posts"] = posts
    return out


def make_project(pdir: Path, video: Path, keep=((1.0, 9.0), (12.0, 20.0)), word_step: float = 0.4,
                 extra: dict | None = None) -> dict:
    """project.json + work/transcript.json with synthetic evenly spaced words w0..wN over the video."""
    (pdir / "work").mkdir(parents=True, exist_ok=True)
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True).stdout.strip()
    vdur = float(out)
    words, t, i = [], 0.05, 0
    while t + 0.3 < vdur:
        words.append({"id": f"w{i}", "source": "s1", "s": round(t, 3), "e": round(t + 0.3, 3), "w": f"word{i}"})
        t += word_step
        i += 1
    (pdir / "work" / "transcript.json").write_text(json.dumps({"words": words}), encoding="utf-8")

    def wid_at(sec):
        return min(words, key=lambda w: abs(w["s"] - sec))["id"]
    kept = [{"from": wid_at(a), "to": wid_at(b)} for a, b in keep]
    # like `init`: the take lives in <project>/media (absolute source paths are refused)
    media = pdir / "media"
    media.mkdir(parents=True, exist_ok=True)
    linked = media / Path(video).name
    if not linked.exists():
        try:
            os.link(video, linked)
        except OSError:
            shutil.copy2(video, linked)
    proj = {"schemaVersion": 1, "id": "test", "title": "Test", "slug": "test", "version": 0,
            "format": {"width": 1080, "height": 1920, "fps": 30},
            "sources": [{"id": "s1", "path": f"media/{linked.name}", "duration": vdur, "fps": 30, "width": 1080, "height": 1920,
                         "rotation": 0}],
            "transcript": {"file": "work/transcript.json", "language": "en"},
            "cut": {"keep": kept, "gapCap": 0.25, "minSaving": 0.08},
            "captions": {"enabled": True, "style": {"position": 0.70, "size": 76}},
            "music": {"enabled": False, "track": None, "startAt": 0.0, "level": "under-voice", "automation": [],
                      "fadeOut": 1.5},
            "broll": [], "zooms": [], "cover": {"atSourceTime": 3.0, "source": "s1", "text": None},
            "post": {"caption": "", "hashtags": [], "keywords": []}, "notes": []}
    if extra:
        proj.update(extra)
    (pdir / "project.json").write_text(json.dumps(proj, indent=1), encoding="utf-8")
    return proj


def make_ctx(pdir: Path, root: Path | None = None, draft: bool = True) -> RenderCtx:
    """A RenderCtx the way A1's render builds it: segments from cut.keep, word -> output time."""
    proj = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    words = json.loads((pdir / proj["transcript"]["file"]).read_text(encoding="utf-8"))["words"]
    idx = {w["id"]: k for k, w in enumerate(words)}
    segs, t = [], 0.0
    for r in proj["cut"]["keep"]:
        a, b = words[idx[r["from"]]], words[idx[r["to"]]]
        segs.append(Segment("s1", a["s"], b["e"], t, r["from"], r["to"]))
        t += b["e"] - a["s"]
    by = {w["id"]: w for w in words}

    def wout(wid):
        w = by[wid]
        for s in segs:
            if s.source == w["source"] and s.src_start - 1e-6 <= w["s"] <= s.src_end:
                return s.out_start + w["s"] - s.src_start
        raise KeyError(wid)

    def wend(wid):
        return wout(wid) + by[wid]["e"] - by[wid]["s"]
    return RenderCtx(project=proj, project_dir=pdir, root=root or pdir, out_timeline=segs, word_out_time=wout,
                     duration=t, fmt=proj["format"], draft=draft, work=pdir / "work", ffmpeg=FFMPEG, ffprobe=FFPROBE,
                     progress=lambda *a: None, word_out_end=wend, words=words)


def set_project(ctx, **fields) -> None:
    ctx.project.update(fields)
    (ctx.project_dir / "project.json").write_text(json.dumps(ctx.project, indent=1), encoding="utf-8")


def word_near(ctx, out_t: float) -> str:
    """Kept word id whose output start is nearest out_t."""
    best = None
    for w in ctx.words:
        try:
            t = ctx.word_out_time(w["id"])
        except KeyError:
            continue
        if best is None or abs(t - out_t) < best[0]:
            best = (abs(t - out_t), w["id"])
    return best[1]


def cut_voice(ctx, out: Path) -> Path:
    """The cut's voice track (what A1's render hands to music.build_audio)."""
    if out.exists():
        return out
    src = str(Path(ctx.project_dir) / ctx.project["sources"][0]["path"])
    parts = "".join(f"[0:a]atrim={s.src_start:.3f}:{s.src_end:.3f},asetpts=PTS-STARTPTS[a{i}];"
                    for i, s in enumerate(ctx.out_timeline))
    fc = parts + "".join(f"[a{i}]" for i in range(len(ctx.out_timeline))) + \
        f"concat=n={len(ctx.out_timeline)}:v=0:a=1[a]"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(src), "-filter_complex", fc, "-map", "[a]",
                    "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(out)], check=True)
    return out
