#!/usr/bin/env bash
# Mount a built .dmg, copy the app into a throw-away folder (path with spaces), run its --self-test, print every
# check, unmount. Never touches /Applications. Works on any Mac.
#
#   packaging/test-mac-install.sh <path.dmg> [--fresh]      --fresh = wipe the app's saved data first (forces the model download)
set -euo pipefail
unset ELECTRON_RUN_AS_NODE
DMG="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; FRESH=0; [ "${2:-}" = "--fresh" ] && FRESH=1
DEST="${TEST_APPS_DIR:-$HOME/reel-studio-build/Applications-test}"
MNT="$(mktemp -d /tmp/rsdmg.XXXXXX)"
RES="$(mktemp -t rs-selftest).json"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT

hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
APPNAME="$(cd "$MNT" && ls -d *.app | head -1)"
rm -rf "$DEST"; mkdir -p "$DEST"
ditto "$MNT/$APPNAME" "$DEST/$APPNAME"
echo "copied to: $DEST/$APPNAME ($(du -sh "$DEST/$APPNAME" | cut -f1))"
codesign --verify --deep --strict "$DEST/$APPNAME" && echo "codesign verify: OK" || echo "codesign verify: FAILED (expected for the electron-builder dmg; hand out release/signed/*.dmg)"
codesign -dv "$DEST/$APPNAME" 2>&1 | grep -E "flags|Signature|TeamIdentifier" || true
PRODUCT="${APPNAME%.app}"
if [ "$FRESH" = 1 ]; then rm -rf "$HOME/Library/Application Support/$PRODUCT"; echo "wiped app data"; fi
EXE="$DEST/$APPNAME/Contents/MacOS/$PRODUCT"
S=$(date +%s)
set +e; "$EXE" --self-test --out "$RES"; CODE=$?; set -e
echo "self-test exit code $CODE after $(( $(date +%s) - S ))s"
python3 - "$RES" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print("isPackaged=%s electron=%s %s/%s" % (d["isPackaged"], d["electron"], d["platform"], d["arch"]))
print("python:", d["locations"]["python"])
for c in d["result"]["checks"]:
    t = json.dumps(c["detail"], ensure_ascii=False)
    print("%-24s %-5s %6ss  %s" % (c["name"], "PASS" if c["ok"] else "FAIL", c["seconds"], t[:200]))
print("SELF-TEST", "PASSED" if d["ok"] else "FAILED")
PY
exit $CODE
