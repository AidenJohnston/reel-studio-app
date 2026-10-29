#!/usr/bin/env bash
# Build the Reel Studio macOS installer (dmg, arm64, hardened runtime, UNSIGNED).
# Run on a Mac. Signing/notarizing is a separate step: packaging/sign-mac.sh.
#
#   packaging/build-mac.sh [--spike] [--app-dir DIR] [--skip-fetch] [--skip-ui-build] [--compression normal|maximum|store]
#
#   --spike     build packaging/spike (the packaging proof) instead of app/
#   --no-adhoc  skip the final ad-hoc sealing step (see below)
# Output: <app-dir>/release/mac-arm64/<Product>.app and release/Reel-Studio-<version>-arm64.dmg (electron-builder's,
#         NOT sealed: its signature is broken by electron-builder's edits, so a downloaded copy can show "damaged").
#         <app-dir>/release/signed/Reel-Studio-<version>-arm64.dmg  <- THE ONE TO HAND OUT while we have no Apple
#         certificate: the same app with a valid ad-hoc seal + hardened runtime, so a downloaded copy shows the normal
#         "Open Anyway" path (docs/install-mac.md). With a certificate, run sign-mac.sh instead and hand out its dmg.
set -euo pipefail
unset ELECTRON_RUN_AS_NODE   # set by Electron-based shells; would make electron-builder tools run as plain node

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP_DIR=""; SPIKE=0; SKIP_FETCH=0; SKIP_UI=0; COMPRESSION=normal; ADHOC=1
while [ $# -gt 0 ]; do
  case "$1" in
    --spike) SPIKE=1 ;;
    --app-dir) APP_DIR="$2"; shift ;;
    --skip-fetch) SKIP_FETCH=1 ;;
    --skip-ui-build) SKIP_UI=1 ;;
    --compression) COMPRESSION="$2"; shift ;;
    --no-adhoc) ADHOC=0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
START=$(date +%s)

if [ "$SPIKE" = 1 ]; then APP_DIR="$HERE/spike"; elif [ -z "$APP_DIR" ]; then APP_DIR="$REPO/app"; fi
APP_DIR="$(cd "$APP_DIR" && pwd)"
[ -f "$APP_DIR/package.json" ] || { echo "No package.json in $APP_DIR" >&2; exit 1; }

# 1. runtime (python + deps + ffmpeg) -> packaging/runtime/mac-arm64
if [ "$SKIP_FETCH" = 0 ]; then
  PY="$(command -v python3)"
  "$PY" "$HERE/fetch_runtime.py"
fi
RUNTIME="$HERE/runtime/mac-arm64"
[ -x "$RUNTIME/python/bin/python3" ] || { echo "Runtime missing: run packaging/fetch_runtime.py" >&2; exit 1; }

# 2. the app's own JS
if [ "$SPIKE" = 1 ]; then
  (cd "$APP_DIR" && { [ -d node_modules/electron-builder ] || npm install --no-audit --no-fund; } && node prep.js)
  export RS_ENGINE_DIR="$HERE/spike/engine-stub"
  export RS_TEMPLATES_DIR="$HERE/spike/templates-stub"
  mkdir -p "$RS_TEMPLATES_DIR"; [ -f "$RS_TEMPLATES_DIR/README.txt" ] || echo placeholder > "$RS_TEMPLATES_DIR/README.txt"
  EXTRA=(-c.appId=dev.reelstudio.spike "-c.productName=Reel Studio Spike" -c.extraMetadata.name=reel-studio-spike)
else
  if [ "$SKIP_UI" = 0 ]; then
    (cd "$REPO" && npm install --no-audit --no-fund       && { [ ! -f ai/package.json ] || npm run build --workspace ai; }       && npm run build --workspace app)
  fi
  if [ -f "$REPO/ai/package.json" ]; then
    # guard: a packaged app without @reelstudio/ai in its dependencies silently runs the mock AI
    node -e "const a=require(process.argv[1]);if(!(a.dependencies&&a.dependencies['@reelstudio/ai'])){console.error('app/package.json must list @reelstudio/ai under dependencies (for example the version *): the app loads it at run time, and without it the packaged app silently falls back to the mock AI.');process.exit(3)}" "$APP_DIR/package.json"
  fi
  export RS_ENGINE_DIR="$REPO/engine"
  export RS_TEMPLATES_DIR="$REPO/templates"
  EXTRA=()
fi
export RS_REPO_ROOT="$REPO" RS_RUNTIME_DIR="$RUNTIME" RS_APP_DIR="$APP_DIR"

# 3. package (unsigned dmg + the unpacked .app that sign-mac.sh signs)
CFG="$(node "$HERE/make-config.js")"
cd "$APP_DIR"
# electron-builder cannot always resolve a range like "^44.8.0" inside an npm workspace: hand it the installed version.
EV="$(node -e "try{console.log(require(require.resolve('electron/package.json',{paths:[process.cwd()]})).version)}catch(e){}")"
[ -n "$EV" ] && EXTRA+=("-c.electronVersion=$EV")
npx --yes electron-builder@26.15.3 --config "$CFG" --projectDir "$APP_DIR" \
  --mac dmg --arm64 --publish never "-c.compression=$COMPRESSION" ${EXTRA[@]+"${EXTRA[@]}"}

echo
ls -lh "$APP_DIR"/release/*.dmg
if [ "$ADHOC" = 1 ]; then
  echo; echo "Sealing with an ad-hoc signature (no certificate needed) ..."
  "$HERE/sign-mac.sh" --adhoc --app-dir "$APP_DIR"
fi
echo "build-mac done in $(( $(date +%s) - START ))s"
