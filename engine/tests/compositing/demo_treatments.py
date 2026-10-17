"""Render every b-roll treatment over a real (or synthetic) take and save one preview frame each.

Not a test: a look-at-it tool for acceptance. Composites the way A1's render does (cut video,
zoom, layers by z) in Python so frames can be checked before or without render.py.

  python engine/tests/compositing/demo_treatments.py [--video PATH] [--out testdata/demo]

Writes <out>/<treatment>.png (clean) and <out>/<treatment>-annotated.png (face box red, caption
band blue, layer bboxes green) and prints the placement check for each.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

import fixtures as fx  # noqa: E402
from reelengine import broll, placement  # noqa: E402
from reelengine.compose_util import output_to_source  # noqa: E402


def layer_frame(L, t, W, H):
    """RGBA image of layer L at output time t, or None."""
    if not (L.t0 <= t < L.t1):
        return None
    if L.kind == "image":
        return Image.open(L.path).convert("RGBA")
    rel = max(0.0, t - L.t0)
    out = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{rel:.3f}", "-i", str(L.path), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True).stdout
    if len(out) < L.w * L.h * 4:
        return None
    return Image.frombuffer("RGBA", (L.w, L.h), out[: L.w * L.h * 4], "raw", "RGBA", 0, 1)


def composite(ctx, layers, zooms, t):
    W, H = ctx.fmt["width"], ctx.fmt["height"]
    sid, st = output_to_source(ctx, t)
    src = fx.Path(ctx.project_dir) / ctx.project["sources"][0]["path"]   # relative to the project (media/...)
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{st:.3f}", "-i", str(src), "-frames:v", "1",
                          "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    base = Image.frombuffer("RGB", (W, H), raw[: W * H * 3], "raw", "RGB", 0, 1).convert("RGBA")
    for z in zooms:
        if z.t0 <= t < z.t1:
            cw, ch = W / z.scale, H / z.scale
            x0, y0 = z.cx - cw / 2, z.cy - ch / 2
            base = base.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch))).resize((W, H), Image.LANCZOS)
    for L in sorted(layers, key=lambda L: L.z):
        im = layer_frame(L, t, W, H)
        if im is not None:
            base.alpha_composite(im.resize((L.w, L.h)) if im.size != (L.w, L.h) else im, (L.x, L.y))
    return base


TREATMENTS = {
    "card-above-head": lambda a: {"asset": str(a["screenshot"]), "params": {"tilt": -2.5}},
    "card-above-head-video": lambda a: {"treatment": "card-above-head", "asset": str(a["clip"]), "params": {}},
    "full-frame": lambda a: {"asset": str(a["clip"]), "params": {}},
    "phone-card": lambda a: {"asset": str(a["portrait"]), "params": {}},
    "side-card": lambda a: {"asset": str(a["portrait"]), "params": {}},
    "text-pop": lambda a: {"asset": None, "params": {"text": "twenty bucks a week"}},
    "post-wall": lambda a: {"asset": str(a["posts"]), "params": {}},
    "icon-wall": lambda a: {"asset": None, "params": {"items": [str(a[k]) for k in
                                                               ("logo-red", "logo-dark", "logo-green", "logo-blue")]}},
    "split-top": lambda a: {"asset": str(a["screenshot"]), "params": {}},
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default=str(fx.real_take() or ""))
    ap.add_argument("--out", default=str(HERE.parents[2] / "testdata" / "demo"))
    ap.add_argument("--only", default=None)
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    video = Path(args.video) if args.video else fx.synth_video(out / "synth.mp4")
    assets = fx.synth_images(out / "assets")
    assets["clip"] = fx.synth_clip(out / "assets" / "clip.mp4")
    report = {}
    for name, mk in TREATMENTS.items():
        if args.only and name != args.only:
            continue
        pdir = out / f"proj-{name}"
        fx.make_project(pdir, video, keep=((2.0, 12.0), (20.0, 30.0)))
        ctx = fx.make_ctx(pdir)
        spec = mk(assets)
        a, b = fx.word_near(ctx, 3.0), fx.word_near(ctx, 6.5)
        item = {"id": "b1", "anchor": {"from": a, "to": b}, "leadIn": 0.13,
                "treatment": spec.pop("treatment", name), **spec}
        fx.set_project(ctx, broll=[item])
        layers = broll.build_layers(ctx)
        recs = json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]
        t = 6.0
        img = composite(ctx, layers, [], t)
        img.convert("RGB").save(out / f"{name}.png")
        ann = img.copy()
        d = ImageDraw.Draw(ann)
        r = recs[0]
        if r.get("face"):
            fx_, fy, fw, fh = r["face"]
            d.rectangle([fx_, fy, fx_ + fw, fy + fh], outline=(255, 0, 0, 255), width=5)
        band = placement.caption_band(broll._frame(ctx))
        d.rectangle([0, band[0], 1079, band[1]], outline=(0, 120, 255, 255), width=5)
        if r.get("bbox"):
            d.rectangle(r["bbox"], outline=(0, 255, 0, 255), width=4)
        ann.convert("RGB").resize((540, 960)).save(out / f"{name}-annotated.png")
        errs = broll.check_layers(ctx, recs)
        report[name] = {"record": r, "layers": len(layers), "problems": errs}
        print(f"{name:24s} zone={r.get('zone')} bbox={r.get('bbox')} fallback={r.get('fallback')} "
              f"problems={errs or 'none'}")
    (out / "report.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
