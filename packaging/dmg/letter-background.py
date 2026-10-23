# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools==4.60.1", "uharfbuzz==0.51.1"]
# ///
"""Write the two lines of copy in background.svg as Inter outlines.

sips cannot load a font that is not installed, so the SVG carries the copy as paths. This script makes those paths
from the Inter files in packaging/fonts (SIL OFL 1.1), shaped with HarfBuzz so kerning matches what Inter sets.
The build does not run it; run it after changing the copy or the font, then commit background.svg:

    uv run --script packaging/dmg/letter-background.py           # rewrite background.svg
    uv run --script packaging/dmg/letter-background.py --check   # exit 1 if background.svg is out of date
"""
import argparse, re, sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent / "fonts"
SVG = HERE / "background.svg"

# Coordinates are in the SVG's 640x432 viewBox. Baselines, cap heights and the centre line are the ones the earlier
# SF Pro lettering used, so the window keeps its layout. The tracking makes each line as wide as it was then, to within
# half a pixel in the rendered 2x image; Inter at its default spacing came out 6 px wider (headline) and 7 px narrower.
LINES = [
    dict(id="headline", text="Drag Reel Studio into Applications.", font="Inter-Bold.ttf",
         cap_height=16.21, baseline=104.0, centre=320.0, tracking_em=-0.028),
    dict(id="subline", text="Once copied, open it from Applications.", font="Inter-Regular.ttf",
         cap_height=8.43, baseline=367.0, centre=320.0, tracking_em=0.016),
]


def num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def outline(line: dict) -> str:
    path = FONTS / line["font"]
    tt = TTFont(path)
    upm = tt["head"].unitsPerEm
    size = line["cap_height"] / tt["OS/2"].sCapHeight * upm
    scale = size / upm
    track = line["tracking_em"] * upm

    font = hb.Font(hb.Face(path.read_bytes()))
    buf = hb.Buffer()
    buf.add_str(line["text"])
    buf.guess_segment_properties()
    hb.shape(font, buf)

    names = tt.getGlyphOrder()
    placed, x = [], 0.0
    for i, (info, pos) in enumerate(zip(buf.glyph_infos, buf.glyph_positions)):
        placed.append((names[info.codepoint], x + pos.x_offset, pos.y_offset))
        x += pos.x_advance + (track if i < len(buf.glyph_infos) - 1 else 0)
    left = line["centre"] - x * scale / 2  # centre the advance width, as text-anchor="middle" would

    glyphs = tt.getGlyphSet()
    pen = SVGPathPen(glyphs, ntos=num)
    for name, gx, gy in placed:
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, left + gx * scale, line["baseline"] - gy * scale)))
    return pen.getCommands()


def letter(svg: str) -> str:
    for line in LINES:
        pattern = re.compile(rf'(<path id="{line["id"]}" d=")[^"]*(")')
        if len(pattern.findall(svg)) != 1:
            sys.exit(f'letter-background: background.svg needs exactly one <path id="{line["id"]}" d="...">')
        svg = pattern.sub(lambda m: m.group(1) + outline(line) + m.group(2), svg)
    return svg


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="exit 1 if background.svg differs from a fresh run")
    args = ap.parse_args()
    old = SVG.read_text()
    new = letter(old)
    if args.check:
        if new != old:
            sys.exit("letter-background: background.svg is out of date; run: uv run --script packaging/dmg/letter-background.py")
        return
    SVG.write_text(new)


if __name__ == "__main__":
    main()
