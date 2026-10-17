"""Placement proof over real close-up takes: how often does b-roll fall back to the split view, and
does what's placed keep the eyes-to-chin zone and the caption band clear?

Not a test: a look-at-it tool (like demo_treatments.py). Per take it places 10 b-roll items
(6 card-above-head, 4 side-card: screenshot, article, square, 4:5 post, logo, clip, portrait...)
in separate 4 s windows across the take, renders each, composites one frame per item and writes:

  <out>/<take>/<nn>-<item>.png             the frame as the viewer sees it (1080x1920)
  <out>/<take>/<nn>-<item>-annotated.png   face box red, eyes-to-chin zone magenta, caption band
                                           blue, the placed graphic's bbox green (540x960)
  <out>/<take>/sheet.png                   all annotated frames side by side
  <out>/summary.json                       per item: zone, fallback, card width, overlaps

The eyes-to-chin zone is measured HERE from YuNet landmarks on the composited frame's source, not
taken from the engine, so an older engine (the "before" run, `--engine <path>`) is judged the same.

  python engine/tests/compositing/placement_proof.py --takes <a.mp4> <b.mp4> ... --out testdata/proof

`--photos above-x=<img> side-y=<img> ...` swaps the synthetic set for REAL images (photos, logos,
posters, product shots): `above-*` labels go through card-above-head, `side-*` through side-card.
Assets are linked into each project's media/ folder (the engine refuses paths outside it).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _setup(engine: Path | None):
    if engine:
        sys.path.insert(0, str(engine))
        sys.path.insert(0, str(engine / "tests" / "compositing"))
    else:
        sys.path.insert(0, str(HERE.parents[1]))
        sys.path.insert(0, str(HERE))


def _assets(d: Path, fx) -> dict:
    """The synthetic set plus a 4:3 article, a square and a 4:5 post (all with text on them)."""
    from PIL import Image, ImageDraw
    from reelengine.compose_util import load_font
    a = fx.synth_images(d)
    a["clip"] = fx.synth_clip(d / "clip.mp4")
    for name, (w, h), col in (("article", (1200, 900), (252, 252, 250)), ("square", (1080, 1080), (30, 30, 36)),
                              ("post45", (1080, 1350), (238, 226, 210))):
        p = d / f"{name}.png"
        if not p.exists():
            im = Image.new("RGB", (w, h), col)
            dr = ImageDraw.Draw(im)
            ink = (20, 20, 20) if sum(col) > 380 else (245, 245, 245)
            dr.text((50, 40), "THE MORNING POST", font=load_font(56), fill=ink)
            dr.text((50, 160), "Students build", font=load_font(110), fill=ink)
            dr.text((50, 290), "a new app", font=load_font(110), fill=ink)
            dr.text((50, 460), "Published Oct 16, 2026 - 4 min read", font=load_font(44, "semibold"), fill=ink)
            dr.rectangle([50, 560, w - 50, h - 50], fill=(200, 120, 60))
            im.save(p)
        a[name] = p
    return a


ITEMS = [   # (label, treatment, asset key, params)
    ("above-screenshot", "card-above-head", "screenshot", {}),
    ("above-article", "card-above-head", "article", {}),
    ("above-square", "card-above-head", "square", {}),
    ("above-post45", "card-above-head", "post45", {}),
    ("above-logo", "card-above-head", "logo-red", {}),
    ("above-clip", "card-above-head", "clip", {}),
    ("side-portrait", "side-card", "portrait", {}),
    ("side-square", "side-card", "square", {}),
    ("side-logo", "side-card", "logo-blue", {"side": "left"}),
    ("side-screenshot", "side-card", "screenshot", {"side": "right"}),
]


def photo_items(specs: list[str]) -> list[tuple]:
    """`label=path` -> ITEMS rows for real images (label above-* -> card-above-head, side-* -> side-card;
    side-*-left / side-*-right pin the side)."""
    out = []
    for spec in specs:
        label, _, path = spec.partition("=")
        tname = "side-card" if label.startswith("side") else "card-above-head"
        params = {"side": label.rsplit("-", 1)[1]} if label.endswith(("-left", "-right")) else {}
        out.append((label, tname, Path(path), params))
    return out


def _link_into(media: Path, src: Path) -> Path:
    import os
    import shutil
    media.mkdir(parents=True, exist_ok=True)
    dst = media / src.name
    if not dst.exists():
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
    return dst


def protected_zone(bgr):
    """(x0, y0, x1, y1) eyes-to-chin from YuNet landmarks, face box, or None."""
    from reelengine import placement
    r = placement.detect_in_frame(bgr)
    if not r:
        return None, None
    x, y, w, h = r["box"]
    lm = r.get("landmarks")
    if lm:
        exl, exr = min(lm[0], lm[2]), max(lm[0], lm[2])
        ey = (lm[1] + lm[3]) / 2
        iod = max(1.0, exr - exl)
        core = (exl - 0.4 * iod, ey - 0.5 * iod, exr + 0.4 * iod, y + h)
    else:
        core = (x + 0.06 * w, y + 0.22 * h, x + 0.94 * w, y + h)
    return core, (x, y, x + w, y + h)


def opaque_hits(layers, t, rect) -> bool:
    """Does any OPAQUE pixel (alpha > 128) of a still layer showing at t fall inside rect
    (x0, y0, x1, y1)? Video layers count by their box. A tilted card's bbox corners are transparent,
    so this is the honest test (the bbox one is kept too)."""
    import numpy as np
    from PIL import Image
    x0, y0, x1, y1 = [int(round(v)) for v in rect]
    for L in layers:
        if not (L.t0 <= t < L.t1):
            continue
        if L.kind != "image":
            if _overlap((L.x, L.y, L.x + L.w, L.y + L.h), rect):
                return True
            continue
        a = np.asarray(Image.open(L.path).convert("RGBA").getchannel("A"))
        ax0, ay0 = max(0, x0 - L.x), max(0, y0 - L.y)
        ax1, ay1 = min(a.shape[1], x1 - L.x), min(a.shape[0], y1 - L.y)
        if ax1 > ax0 and ay1 > ay0 and (a[ay0:ay1, ax0:ax1] > 128).any():
            return True
    return False


def _overlap(a, b) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def source_frame(fx, src, t, W, H):
    import numpy as np
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
                          "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True).stdout
    return np.frombuffer(raw[: W * H * 3], np.uint8).reshape(H, W, 3)


def run_take(take: Path, out: Path, fx, broll, placement, demo, items_spec=None) -> list[dict]:
    from PIL import Image, ImageDraw
    from reelengine.compose_util import output_to_source
    out.mkdir(parents=True, exist_ok=True)
    ITEMS = items_spec or globals()["ITEMS"]
    assets = _assets(out.parent / "assets", fx) if not items_spec else {}
    dur = float(subprocess.run([fx.FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(take)], capture_output=True, text=True).stdout)
    step = min(4.0, (dur - 2.0) / len(ITEMS))
    pdir = out / "proj"
    fx.make_project(pdir, take, keep=((1.0, 1.0 + step * len(ITEMS) + 0.5),))
    ctx = fx.make_ctx(pdir)
    items = []
    for k, (label, tname, key, params) in enumerate(ITEMS):
        src = key if isinstance(key, Path) else assets[key]
        asset = _link_into(pdir / "media" / "assets", src)
        a, b = fx.word_near(ctx, 0.3 + k * step), fx.word_near(ctx, 0.3 + k * step + step * 0.55)
        items.append({"id": f"b{k + 1}", "anchor": {"from": a, "to": b}, "leadIn": 0.13, "treatment": tname,
                      "asset": str(asset), "params": dict(params)})
    fx.set_project(ctx, broll=items)
    layers = broll.build_layers(ctx)
    recs = {r["id"]: r for r in json.loads((ctx.work / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]}
    W, H = ctx.fmt["width"], ctx.fmt["height"]
    band = placement.caption_band(broll._frame(ctx))
    rows, thumbs = [], []
    for k, (label, tname, key, params) in enumerate(ITEMS):
        r = recs.get(f"b{k + 1}", {})
        t = (r.get("t0", k * step) + min(r.get("t1", k * step + 1.5), r.get("t0", k * step) + 2.0)) / 2
        img = demo.composite(ctx, layers, [], t)
        stem = f"{k + 1:02d}-{label}"
        img.convert("RGB").save(out / f"{stem}.png")
        _sid, st = output_to_source(ctx, t)
        core, fbox = protected_zone(source_frame(fx, take, st, W, H))
        ann = img.copy()
        d = ImageDraw.Draw(ann)
        if fbox:
            d.rectangle(fbox, outline=(255, 0, 0, 255), width=4)
        if core:
            d.rectangle(core, outline=(255, 0, 255, 255), width=6)
        d.rectangle([0, band[0], W - 1, band[1]], outline=(0, 120, 255, 255), width=5)
        split = r.get("zone") == "split-top"
        bbox = r.get("bbox")
        if bbox and not split:
            d.rectangle(bbox, outline=(0, 255, 0, 255), width=5)
        d.rectangle([0, 0, W, 70], fill=(0, 0, 0, 200))
        d.text((16, 8), f"{stem}  zone={r.get('zone')}", font=_font(44), fill=(255, 255, 255, 255))
        small = ann.convert("RGB").resize((540, 960))
        small.save(out / f"{stem}-annotated.png")
        thumbs.append(small)
        row = {"take": take.name, "item": label, "treatment": tname, "zone": r.get("zone"),
               "split": split or r.get("fallbackTreatment") == "split-top",
               "fallback": r.get("fallback"), "skipped": r.get("skipped"), "content": r.get("content"),
               "note": r.get("note"),
               "frame": str(out / f"{stem}.png"), "t": round(t, 2)}
        if bbox and not split and not r.get("faceHiding"):
            bw = bbox[2] - bbox[0]
            row.update({"cardWidthFrac": round(bw / W, 3),
                        "coversEyesToChin": bool(core and opaque_hits(layers, t, core)),
                        "bboxCoversEyesToChin": bool(core and _overlap(bbox, core)),
                        "coversCaptions": bool(band and opaque_hits(layers, t, (0, band[0], W, band[1])))})
        rows.append(row)
    sheet = Image.new("RGB", (540 * 5, 960 * 2), (0, 0, 0))
    for i, th in enumerate(thumbs):
        sheet.paste(th, ((i % 5) * 540, (i // 5) * 960))
    sheet.resize((540 * 5 // 2, 960)).save(out / "sheet.png")
    return rows


_FONTS = {}


def _font(size):
    from reelengine.compose_util import load_font
    if size not in _FONTS:
        _FONTS[size] = load_font(size)
    return _FONTS[size]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--takes", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", default=None, help="engine folder to import (default: this checkout)")
    ap.add_argument("--photos", nargs="*", default=None, help="label=path real images instead of the synthetic set")
    args = ap.parse_args()
    _setup(Path(args.engine).resolve() if args.engine else None)
    import fixtures as fx
    import demo_treatments as demo
    from reelengine import broll, placement
    out = Path(args.out).resolve()
    rows = []
    for take in args.takes:
        take = Path(take)
        rows += run_take(take, out / take.stem[:40], fx, broll, placement, demo,
                         photo_items(args.photos) if args.photos else None)
    by_take = {}
    for r in rows:
        s = by_take.setdefault(r["take"], {"items": 0, "split": 0, "coversEyesToChin": 0, "coversCaptions": 0})
        s["items"] += 1
        s["split"] += int(bool(r["split"]))
        s["coversEyesToChin"] += int(bool(r.get("coversEyesToChin")))
        s["coversCaptions"] += int(bool(r.get("coversCaptions")))
    (out / "summary.json").write_text(json.dumps({"byTake": by_take, "rows": rows}, indent=1), encoding="utf-8")
    for r in rows:
        print(f"{r['take'][:34]:34s} {r['item']:17s} zone={str(r['zone']):12s} split={int(bool(r['split']))} "
              f"w={r.get('cardWidthFrac', '-')} content={r.get('content') or '-'} eyes-chin={r.get('coversEyesToChin', '-')} "
              f"captions={r.get('coversCaptions', '-')}")
    for k, s in by_take.items():
        print(f"TOTAL {k[:40]:40s} split {s['split']}/{s['items']}  covers eyes-to-chin {s['coversEyesToChin']}"
              f"  covers captions {s['coversCaptions']}")


if __name__ == "__main__":
    main()
