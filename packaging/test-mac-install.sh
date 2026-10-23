#!/usr/bin/env bash
# Mount a built .dmg, copy the app into a throw-away folder (path with spaces), check its signature, Gatekeeper
# verdict and stapled ticket, run its --self-test, print every check, unmount. Exits non-zero on any failure.
# Never touches /Applications or the app's saved data: the app runs with a test profile, <copy folder>-profile.
#
#   packaging/test-mac-install.sh <path.dmg> [--fresh] [--unsigned] [--timeout SECONDS]
#     --fresh     empty the test profile first (packaging/spike then downloads its speech model again)
#     --unsigned  a local build: report codesign/spctl/stapler without failing on them
#     --timeout   give up on the self-test after this long (default 300)
#   TEST_APPS_DIR=<dir>  where the copy goes (default ~/reel-studio-build/Applications-test); it is replaced each run.
#                        The test profile <dir>-profile is kept between runs, so a downloaded model is reused.
set -euo pipefail
unset ELECTRON_RUN_AS_NODE
usage() { sed -n '2,11p' "$0" >&2; exit 2; }
[ $# -ge 1 ] || usage
DMG="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; shift
FRESH=0; UNSIGNED=0; TIMEOUT=300
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --unsigned) UNSIGNED=1 ;;
    --timeout)
      [[ "${2-}" =~ ^[0-9]+$ ]] || { echo "--timeout needs a number of seconds" >&2; usage; }
      TIMEOUT="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
DEST="${TEST_APPS_DIR:-$HOME/reel-studio-build/Applications-test}"
PROFILE="$DEST-profile"
MNT="$(mktemp -d /tmp/rsdmg.XXXXXX)"
WORK="$(mktemp -d /tmp/rs-mac-install.XXXXXX)"
RES="$WORK/selftest-result.json"
FAILED=()
cleanup() {
  hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rmdir "$MNT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# check <name> <command...>: run it, print PASS/FAIL with its output, remember failures.
check() {
  local name="$1"; shift
  local out code
  set +e; out="$("$@" 2>&1)"; code=$?; set -e
  if [ "$code" = 0 ]; then
    printf '%-20s PASS\n' "$name"
  elif [ "$UNSIGNED" = 1 ]; then
    printf '%-20s FAIL (not counted: --unsigned)\n' "$name"
  else
    printf '%-20s FAIL (exit %s)\n' "$name" "$code"; FAILED+=("$name")
  fi
  printf '%s\n' "$out" | sed 's/^/    /'
}

hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
APPNAME="$(cd "$MNT" && ls -d *.app | head -1)"
rm -rf "$DEST"; mkdir -p "$DEST"
ditto "$MNT/$APPNAME" "$DEST/$APPNAME"
APP="$DEST/$APPNAME"
echo "copied to: $APP ($(du -sh "$APP" | cut -f1))"

check "codesign verify" codesign --verify --deep --strict --verbose=1 "$APP"
codesign -dv "$APP" 2>&1 | grep -E "flags|Signature|TeamIdentifier" | sed 's/^/    /' || true
check "gatekeeper (spctl)" spctl --assess --type execute --verbose=4 "$APP"
check "stapled ticket" xcrun stapler validate "$APP"

PRODUCT="${APPNAME%.app}"
if [ "$FRESH" = 1 ]; then rm -rf "$PROFILE"; echo "emptied test profile: $PROFILE"; fi
EXE="$APP/Contents/MacOS/$PRODUCT"
# The app's data folders point into the test profile. The app and packaging/spike both read REELSTUDIO_USER_DATA;
# a build without --self-test opens its window instead, and that window must not see the real profile either.
S=$(date +%s)
REELSTUDIO_USER_DATA="$PROFILE/user data" REELSTUDIO_ROOT="$PROFILE/Reel Studio" \
  REELENGINE_CACHE="$PROFILE/engine cache" REELENGINE_CACHE_DIR="$PROFILE/engine cache" \
  "$EXE" --self-test --out "$RES" >"$WORK/app.log" 2>&1 &
PID=$!
CODE=""
while [ $(( $(date +%s) - S )) -lt "$TIMEOUT" ]; do
  if ! kill -0 "$PID" 2>/dev/null; then set +e; wait "$PID"; CODE=$?; set -e; break; fi
  sleep 1
done
if [ -z "$CODE" ]; then
  echo "self-test            FAIL: still running after ${TIMEOUT}s, stopping it"
  kill -TERM "$PID" 2>/dev/null || true; sleep 5; kill -KILL "$PID" 2>/dev/null || true
  # The engine leads its own process group and its ffmpeg and ffprobe children join it, but their command lines do
  # not name python, so kill each engine's whole group.
  for p in $(pgrep -f "$APP/Contents/Resources/python" || true); do kill -KILL -- "-$p" 2>/dev/null || true; done
  tail -n 20 "$WORK/app.log" | sed 's/^/    /'
  FAILED+=("self-test timeout")
else
  echo "self-test exit code $CODE after $(( $(date +%s) - S ))s"
  if [ ! -s "$RES" ]; then
    echo "self-test            FAIL: no result file written"
    tail -n 20 "$WORK/app.log" | sed 's/^/    /'
    FAILED+=("self-test result")
  elif ! python3 -I - "$RES" "$CODE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print("version=%s isPackaged=%s electron=%s %s/%s" % (d.get("version"), d["isPackaged"], d["electron"], d["platform"], d["arch"]))
print("python:", d["locations"]["python"])
if d.get("error"):
    print("error:", d["error"])
for c in (d.get("result") or {}).get("checks", []):
    state = "PASS" if c["ok"] else ("FAIL" if c["required"] else "note")
    t = json.dumps(c["detail"], ensure_ascii=False)
    secs = "%5.1fs" % c["seconds"] if "seconds" in c else ""
    print("  %-34s %-4s %6s  %s" % (c["name"], state, secs, t[:160]))
ok = d["ok"] is True and sys.argv[2] == "0"
if d["ok"] != (sys.argv[2] == "0"):
    print("exit code %s does not match ok=%s" % (sys.argv[2], d["ok"]))
print("self-test", "PASSED" if ok else "FAILED")
sys.exit(0 if ok else 1)
PY
  then FAILED+=("self-test")
  fi
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "INSTALL TEST FAILED: ${FAILED[*]}"
  exit 1
fi
echo "INSTALL TEST PASSED"
