#!/usr/bin/env bash
# Render packaging/dmg/background.svg into the disk image window background.
#
#   packaging/dmg/render-background.sh OUT_DIR
#   -> OUT_DIR/background.png (640x432), background@2x.png (1280x864), background.tiff (both, for Retina)
#
# Finder takes ONE background file, so the shipped window uses the TIFF: tiffutil stores the 1x and 2x images
# together and Finder picks the sharp one on a Retina screen. electron-builder gets the same TIFF.
set -euo pipefail
OUT="${1:?usage: render-background.sh OUT_DIR}"
SVG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/background.svg"
mkdir -p "$OUT"
sips -s format png -z 432 640 "$SVG" --out "$OUT/background.png" >/dev/null
sips -s format png -z 864 1280 "$SVG" --out "$OUT/background@2x.png" >/dev/null
# tiffutil only pairs the images as 1x/2x when the big one says 144 dpi.
sips -s dpiWidth 144 -s dpiHeight 144 "$OUT/background@2x.png" >/dev/null
tiffutil -cathidpicheck "$OUT/background.png" "$OUT/background@2x.png" -out "$OUT/background.tiff" >/dev/null 2>&1
[ -s "$OUT/background.tiff" ] || { echo "render-background: tiffutil wrote no $OUT/background.tiff" >&2; exit 1; }
