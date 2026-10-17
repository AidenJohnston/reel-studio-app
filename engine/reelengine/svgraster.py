"""Rasterise a small, flat, path-only SVG (a Simple Icons brand mark) to a transparent PNG.

Why this exists (decision, 2026-10-17): the engine has no SVG renderer. cairosvg needs the cairo
DLLs, Pillow cannot read SVG, and the bundled ffmpeg is an "essentials" build without librsvg
(`ffmpeg -codecs` lists svg with no decoder). Simple Icons marks are one `<path d=...>` on a
24x24 viewBox, so a ~150-line path parser + a numpy scanline fill (nonzero or even-odd winding,
4x4 supersampled for anti-aliasing) draws them exactly, with no new dependency.

Deliberately NOT a general SVG renderer: only <svg>, <g>, <path>, <title>, <desc>, <metadata>
with plain `fill` / `fill-rule` attributes. Any transform, style, gradient, stroke, <use>,
shape element or DOCTYPE raises ValueError, and the caller refuses the file as before.

  render(svg_bytes, size=1024, color="#FF6B6B") -> PIL RGBA image, cropped to the mark + margin
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET

import numpy as np

SUPERSAMPLE = 4
MAX_SVG_BYTES = 512 * 1024
_CMDS = "MmLlHhVvCcSsQqTtAaZz"
_NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_ALLOWED = {"svg", "g", "path", "title", "desc", "metadata"}
_NAMED = {"black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000", "blue": "#0000ff"}


class _Reader:
    def __init__(self, d: str):
        self.d, self.i = d, 0

    def _skip(self):
        while self.i < len(self.d) and self.d[self.i] in " \t\r\n,":
            self.i += 1

    def command(self):
        self._skip()
        if self.i < len(self.d) and self.d[self.i] in _CMDS:
            self.i += 1
            return self.d[self.i - 1]
        return None

    def has_number(self) -> bool:
        self._skip()
        return self.i < len(self.d) and self.d[self.i] not in _CMDS

    def num(self) -> float:
        self._skip()
        m = _NUM.match(self.d, self.i)
        if not m:
            raise ValueError(f"bad path data near {self.d[self.i:self.i + 12]!r}")
        self.i = m.end()
        return float(m.group())

    def flag(self) -> bool:                    # arc flags may be written with no separator: "a1 1 0 011 1"
        self._skip()
        if self.i >= len(self.d) or self.d[self.i] not in "01":
            raise ValueError("bad arc flag")
        self.i += 1
        return self.d[self.i - 1] == "1"


def _nseg(length_px: float) -> int:
    return int(min(256, max(2, length_px / 2.5)))


def _cubic(p0, p1, p2, p3, scale):
    n = _nseg(scale * (math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)))
    t = np.linspace(0, 1, n + 1)[1:, None]
    a, b, c, d = (np.array(p) for p in (p0, p1, p2, p3))
    pts = (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
    return [tuple(p) for p in pts]


def _quad(p0, p1, p2, scale):
    n = _nseg(scale * (math.dist(p0, p1) + math.dist(p1, p2)))
    t = np.linspace(0, 1, n + 1)[1:, None]
    a, b, c = (np.array(p) for p in (p0, p1, p2))
    pts = (1 - t) ** 2 * a + 2 * (1 - t) * t * b + t ** 2 * c
    return [tuple(p) for p in pts]


def _arc(p1, rx, ry, phi, fa, fs, p2, scale):
    """SVG 1.1 implementation notes F.6.5: endpoint -> centre parameterisation, then sampled."""
    (x1, y1), (x2, y2) = p1, p2
    if (x1, y1) == (x2, y2):
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return [p2]
    c, s = math.cos(math.radians(phi)), math.sin(math.radians(phi))
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = c * dx + s * dy, -s * dx + c * dy
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    coef = math.sqrt(max(0.0, num / den)) if den else 0.0
    if fa == fs:
        coef = -coef
    cxp, cyp = coef * rx * y1p / ry, -coef * ry * x1p / rx
    cx, cy = c * cxp - s * cyp + (x1 + x2) / 2, s * cxp + c * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        return math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    ux, uy = (x1p - cxp) / rx, (y1p - cyp) / ry
    th1 = ang(1, 0, ux, uy)
    dth = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dth > 0:
        dth -= 2 * math.pi
    elif fs and dth < 0:
        dth += 2 * math.pi
    n = _nseg(scale * max(rx, ry) * abs(dth))
    out = []
    for k in range(1, n + 1):
        th = th1 + dth * k / n
        out.append((c * rx * math.cos(th) - s * ry * math.sin(th) + cx,
                    s * rx * math.cos(th) + c * ry * math.sin(th) + cy))
    out[-1] = (x2, y2)
    return out


def parse_path(d: str, scale: float = 1.0) -> list[list[tuple[float, float]]]:
    """Path data -> flattened subpaths (lists of points, user units). `scale` = pixels per user
    unit, used only to pick how finely curves are cut."""
    r = _Reader(d or "")
    subs: list[list[tuple[float, float]]] = []
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    pts: list[tuple[float, float]] = []
    last_ctrl = None            # (kind, point): reflected by S/T
    cmd = None

    def flush():
        nonlocal pts
        if len(pts) > 1:
            subs.append(pts)
        pts = []

    while True:
        c = r.command()
        if c is None:
            if not r.has_number():
                break
            if cmd is None:
                raise ValueError("path data must start with a command")
            c = {"M": "L", "m": "l"}.get(cmd, cmd)   # implicit repeat (after M it means L)
            if c in "Zz":
                raise ValueError("numbers after Z")
        cmd = c
        rel = c.islower()
        C = c.upper()
        ox, oy = cur if rel else (0.0, 0.0)
        if C == "M":
            flush()
            cur = (ox + r.num(), oy + r.num())
            start = cur
            pts = [cur]
            last_ctrl = None
            continue
        if C == "Z":
            if pts:
                pts.append(start)
            flush()
            cur = start
            pts = [cur]
            last_ctrl = None
            continue
        if not pts:
            pts = [cur]
        if C == "L":
            cur = (ox + r.num(), oy + r.num())
            pts.append(cur)
            last_ctrl = None
        elif C == "H":
            cur = (ox + r.num() if rel else r.num(), cur[1])
            pts.append(cur)
            last_ctrl = None
        elif C == "V":
            cur = (cur[0], oy + r.num() if rel else r.num())
            pts.append(cur)
            last_ctrl = None
        elif C in "CS":
            if C == "C":
                p1 = (ox + r.num(), oy + r.num())
            else:
                p1 = (2 * cur[0] - last_ctrl[1][0], 2 * cur[1] - last_ctrl[1][1]) \
                    if last_ctrl and last_ctrl[0] == "C" else cur
            p2 = (ox + r.num(), oy + r.num())
            p3 = (ox + r.num(), oy + r.num())
            pts.extend(_cubic(cur, p1, p2, p3, scale))
            cur, last_ctrl = p3, ("C", p2)
        elif C in "QT":
            if C == "Q":
                p1 = (ox + r.num(), oy + r.num())
            else:
                p1 = (2 * cur[0] - last_ctrl[1][0], 2 * cur[1] - last_ctrl[1][1]) \
                    if last_ctrl and last_ctrl[0] == "Q" else cur
            p2 = (ox + r.num(), oy + r.num())
            pts.extend(_quad(cur, p1, p2, scale))
            cur, last_ctrl = p2, ("Q", p1)
        elif C == "A":
            rx, ry, phi = r.num(), r.num(), r.num()
            fa, fs = r.flag(), r.flag()
            p2 = (ox + r.num(), oy + r.num())
            pts.extend(_arc(cur, rx, ry, phi, fa, fs, p2, scale))
            cur, last_ctrl = p2, None
    flush()
    return subs


def fill_mask(subpaths, width: int, height: int, evenodd: bool = False) -> np.ndarray:
    """Boolean coverage of closed polygons (pixel space) sampled at pixel centres. Fully
    vectorised scanline: every (edge, row) crossing at once, sorted by (row, x); because each
    closed polygon's crossings sum to zero per row, a single global cumsum is each row's winding."""
    segs = []
    for sp in subpaths:
        a = np.asarray(sp, dtype=np.float64)
        if len(a) < 2:
            continue
        b = np.roll(a, -1, axis=0)                  # implicit close back to the first point
        segs.append(np.hstack([a, b]))
    mask = np.zeros((height, width), dtype=bool)
    if not segs:
        return mask
    e = np.vstack(segs)
    e = e[e[:, 1] != e[:, 3]]                       # horizontal edges never cross a row centre
    if not len(e):
        return mask
    x0, y0, x1, y1 = e.T
    ymin, ymax = np.minimum(y0, y1), np.maximum(y0, y1)
    r0 = np.clip(np.ceil(ymin - 0.5), 0, height).astype(np.int64)
    r1 = np.clip(np.ceil(ymax - 0.5), 0, height).astype(np.int64)  # exclusive
    cnt = np.maximum(r1 - r0, 0)
    if not cnt.sum():
        return mask
    idx = np.repeat(np.arange(len(e)), cnt)
    rows = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt) + np.repeat(r0, cnt)
    yc = rows + 0.5
    xs = x0[idx] + (yc - y0[idx]) * (x1[idx] - x0[idx]) / (y1[idx] - y0[idx])
    dirs = np.where(y1[idx] > y0[idx], 1, -1)
    order = np.lexsort((xs, rows))
    rows, xs, dirs = rows[order], xs[order], dirs[order]
    wind = np.cumsum(dirs)
    inside = (wind % 2 != 0) if evenodd else (wind != 0)
    span = inside[:-1] & (rows[:-1] == rows[1:])
    if not span.any():
        return mask
    rr = rows[:-1][span]
    c0 = np.clip(np.ceil(xs[:-1][span] - 0.5), 0, width).astype(np.int64)
    c1 = np.clip(np.ceil(xs[1:][span] - 0.5), 0, width).astype(np.int64)
    diff = np.zeros(height * (width + 1), dtype=np.int32)
    np.add.at(diff, rr * (width + 1) + c0, 1)
    np.add.at(diff, rr * (width + 1) + c1, -1)
    return np.cumsum(diff.reshape(height, width + 1), axis=1)[:, :width] > 0


def _hex(c):
    if c is None:
        return None
    c = c.strip().lower()
    c = _NAMED.get(c, c)
    if re.fullmatch(r"#?[0-9a-f]{6}", c):
        c = c.lstrip("#")
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    if re.fullmatch(r"#?[0-9a-f]{3}", c):
        c = c.lstrip("#")
        return tuple(int(ch * 2, 16) for ch in c)
    return None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_svg(data: bytes):
    """-> (viewBox (x, y, w, h), [(d, fill-or-None, evenodd)]). ValueError if outside the subset."""
    if len(data) > MAX_SVG_BYTES:
        raise ValueError("svg too large")
    low = data[:4096].lower()
    if b"<!doctype" in low or b"<!entity" in low:
        raise ValueError("svg with a DOCTYPE/entities")
    root = ET.fromstring(data)
    if _local(root.tag) != "svg":
        raise ValueError("not an svg document")
    vb = root.get("viewBox")
    if vb:
        box = [float(v) for v in re.split(r"[\s,]+", vb.strip())]
    else:
        box = [0.0, 0.0, float(re.sub(r"px$", "", root.get("width", ""))),
               float(re.sub(r"px$", "", root.get("height", "")))]
    if len(box) != 4 or box[2] <= 0 or box[3] <= 0:
        raise ValueError("bad viewBox")
    paths = []

    def walk(el, fill, rule):
        tag = _local(el.tag)
        if tag not in _ALLOWED:
            raise ValueError(f"unsupported svg element <{tag}>")
        if tag in ("title", "desc", "metadata"):
            return
        for bad in ("transform", "style", "stroke", "clip-path", "mask", "filter", "opacity", "fill-opacity"):
            if el.get(bad) not in (None, "", "none") or (bad == "transform" and el.get(bad)):
                raise ValueError(f"unsupported svg attribute {bad}")
        f = el.get("fill", fill)
        if f not in (None, "none", "currentColor") and _hex(f) is None:
            raise ValueError(f"unsupported fill {f!r}")
        rr = el.get("fill-rule", rule)
        if tag == "path":
            if f != "none":
                paths.append((el.get("d", ""), None if f in (None, "currentColor") else f, rr == "evenodd"))
            return
        for ch in el:
            walk(ch, f, rr)
    walk(root, None, "nonzero")
    if not paths:
        raise ValueError("svg has no paths")
    return tuple(box), paths


def render(data: bytes, size: int = 1024, color=None, margin: float = 0.03):
    """SVG bytes -> RGBA PIL image whose longer side is ~`size` px, cropped to the drawn mark
    plus `margin` (fraction of the longer side). `color` fills paths with no fill of their own."""
    from PIL import Image
    (vx, vy, vw, vh), paths = parse_svg(data)
    ss = SUPERSAMPLE
    scale = size * ss / max(vw, vh)
    W, H = max(1, math.ceil(vw * scale)), max(1, math.ceil(vh * scale))
    W += (-W) % ss
    H += (-H) % ss
    default = _hex(color) or (0, 0, 0)
    canvas = Image.new("RGBA", (W // ss, H // ss), (0, 0, 0, 0))
    for d, fill, evenodd in paths:
        subs = [[((x - vx) * scale, (y - vy) * scale) for x, y in sp] for sp in parse_path(d, scale)]
        m = fill_mask(subs, W, H, evenodd)
        a = m.reshape(H // ss, ss, W // ss, ss).mean(axis=(1, 3))          # exact box filter
        alpha = Image.fromarray(np.round(a * 255).astype(np.uint8), "L")
        layer = Image.new("RGBA", canvas.size, (*(_hex(fill) or default), 0))
        layer.putalpha(alpha)
        canvas = Image.alpha_composite(canvas, layer)
    bbox = canvas.getchannel("A").getbbox()
    if not bbox:
        raise ValueError("svg drew nothing")
    pad = int(round(margin * max(canvas.size)))
    l, t, r_, b = bbox
    return canvas.crop((max(0, l - pad), max(0, t - pad), min(canvas.width, r_ + pad), min(canvas.height, b + pad)))
