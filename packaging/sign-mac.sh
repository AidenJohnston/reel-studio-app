#!/usr/bin/env bash
# Sign, notarize and staple Reel Studio for macOS. ONE command, run on the Mac, in a GUI session
# (Screen Sharing / VNC / at the keyboard) because the signing key lives in the login keychain, which is
# locked over plain SSH. Full walk-through: docs/signing-mac.md
#
#   packaging/sign-mac.sh                       # real app: app/release/mac-arm64/Reel Studio.app
#   packaging/sign-mac.sh --spike               # packaging/spike (practice run)
#   packaging/sign-mac.sh --adhoc --skip-notarize   # no certificate: only proves the signing steps + hardened runtime work
#
# Options:
#   --identity "Developer ID Application: Name (TEAMID)"   default: the first Developer ID Application in the keychain
#   --profile NAME      notarytool keychain profile (default reelstudio-notary; created by `xcrun notarytool store-credentials`)
#   --app PATH          the unsigned .app to sign (default: <app-dir>/release/mac-arm64/*.app from build-mac.sh)
#   --app-dir DIR       default <repo>/app
#   --skip-notarize     sign + verify only
#   --adhoc             sign with "-" (no Apple account needed). Implies --skip-notarize. NOT distributable.
#
# What it does, in order (any failure stops the script):
#   1. copy the .app to release/signed/ (the unsigned build is never modified)
#   2. sign every Mach-O file (python, ffmpeg, every .so/.dylib, Electron helpers) deepest first,
#      then the nested bundles (frameworks, helper apps), then the main app: hardened runtime + timestamp, with
#      entitlements by ROLE (least privilege, review finding 24):
#        main app + its executable        entitlements.main.plist     (allow-jit)
#        Electron helper .app bundles     entitlements.inherit.plist  (allow-jit)
#        python, ffmpeg, dylibs, .so, ... NONE
#   3. codesign --verify --deep --strict
#   4. zip -> xcrun notarytool submit --wait -> xcrun stapler staple (the .app)
#   5. build the .dmg from the signed+stapled app (packaging/dmg/make-dmg.sh: the designed Finder window, laid out by
#      Finder itself; without a GUI session or Finder control it builds the plain window and says why), sign it,
#      notarize it, staple it
#   6. final checks: codesign --verify, spctl -a -vv (app and dmg), stapler validate
set -euo pipefail
unset ELECTRON_RUN_AS_NODE

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENT_MAIN="$HERE/entitlements.main.plist"
ENT_INHERIT="$HERE/entitlements.inherit.plist"
ENT_NATIVE=""
IDENTITY=""; PROFILE="reelstudio-notary"; APP_DIR="$REPO/app"; APP=""; SKIP_NOTARIZE=0; ADHOC=0

while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift ;;
    --profile) PROFILE="$2"; shift ;;
    --app) APP="$2"; shift ;;
    --app-dir) APP_DIR="$2"; shift ;;
    --spike) APP_DIR="$HERE/spike" ;;
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --adhoc) ADHOC=1; SKIP_NOTARIZE=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "This script only runs on a Mac."
[ -f "$ENT_MAIN" ] && [ -f "$ENT_INHERIT" ] || die "Missing $ENT_MAIN or $ENT_INHERIT"

# ---------- locate the unsigned app ----------
if [ -z "$APP" ]; then
  APP="$(ls -d "$APP_DIR"/release/mac-arm64/*.app 2>/dev/null | head -1 || true)"
fi
[ -d "$APP" ] || die "No unsigned .app found. Build first:  packaging/build-mac.sh   (looked in $APP_DIR/release/mac-arm64)"
PRODUCT="$(basename "$APP" .app)"
OUT="$(dirname "$(dirname "$APP")")/signed"
DMG_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
# The disk's name is the Finder window title. "Installer" says it is not where the app lives, and a new name per
# version stops Finder showing a cached window from an older disk.
DMG_VOLUME="$PRODUCT $DMG_VER Installer"
# Step 5 lays out the disk window through Finder. Ask for that permission now, while someone is at the keyboard,
# not after notarizing the app. Without it step 5 builds the plain window and says why.
DMG_PLAIN_REASON="$(bash "$HERE/dmg/make-dmg.sh" --why-plain)"
[ -n "$DMG_PLAIN_REASON" ] || [ ! -e "/Volumes/$DMG_VOLUME" ] \
  || die "A disk called \"$DMG_VOLUME\" is open. Eject it in Finder first."

# ---------- signing identity ----------
if [ "$ADHOC" = 1 ]; then
  IDENTITY="-"
  TS_FLAG=()
  echo "Ad-hoc signing (no certificate). The result runs on this Mac only; it is for testing the steps."
  # An ad-hoc signature has no Team ID, so under the hardened runtime macOS refuses to load ANY ad-hoc signed library
  # ("code signature ... different Team IDs": the main app cannot load Electron Framework, python cannot load numpy's .so).
  # `disable-library-validation` is the only way past that for a test seal. It is granted ONLY here, from temporary
  # copies of the plists; a Developer ID build (same Team ID on every file) never gets it. Ad-hoc output is not distributable.
  ADHOC_DIR="$(mktemp -d -t rsadhoc)"
  DLV='<key>com.apple.security.cs.disable-library-validation</key><true/>'
  for n in main inherit; do
    sed "s#</dict>#  $DLV</dict>#" "$HERE/entitlements.$n.plist" > "$ADHOC_DIR/$n.plist"
  done
  printf '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>%s</dict></plist>
' "$DLV" > "$ADHOC_DIR/native.plist"
  ENT_MAIN="$ADHOC_DIR/main.plist"; ENT_INHERIT="$ADHOC_DIR/inherit.plist"; ENT_NATIVE="$ADHOC_DIR/native.plist"
else
  # The login keychain is locked in SSH sessions. A locked keychain makes codesign fail with
  # "errSecInternalComponent" or hang on a password dialog nobody can see.
  if ! security show-keychain-info ~/Library/Keychains/login.keychain-db >/dev/null 2>&1; then
    die "The login keychain is locked or unreadable. Run this in a GUI session (Screen Sharing), or first run:  security unlock-keychain ~/Library/Keychains/login.keychain-db"
  fi
  if [ -z "$IDENTITY" ]; then
    IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
  fi
  [ -n "$IDENTITY" ] || die "No 'Developer ID Application' certificate found in your keychain. Create one first (docs/signing-mac.md, step 1). 'Apple Development' certificates do NOT work for distribution."
  TS_FLAG=(--timestamp)
  echo "Signing as: $IDENTITY"
  if [ "$SKIP_NOTARIZE" = 0 ]; then
    xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
      || die "notarytool profile '$PROFILE' not found or not accepted. Create it (docs/signing-mac.md, step 2):  xcrun notarytool store-credentials $PROFILE --apple-id YOU@icloud.com --team-id TEAMID"
  fi
fi

# ---------- 1. copy ----------
say "1/6 Copy $PRODUCT.app to $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
SIGNED="$OUT/$PRODUCT.app"
ditto "$APP" "$SIGNED"
xattr -cr "$SIGNED"

# Which entitlement set a path gets. Entitlements only mean something on an EXECUTABLE (a dylib, .so or framework
# binary inherits nothing from them), so everything that is not the main app or an Electron helper gets none.
ent_for() { # ent_for <path>  -> prints the plist path, or nothing
  case "$1" in
    "$SIGNED"|"$SIGNED/Contents/MacOS/"*) echo "$ENT_MAIN" ;;
    "$SIGNED/Contents/Frameworks/"*.app|"$SIGNED/Contents/Frameworks/"*.app/Contents/MacOS/*) echo "$ENT_INHERIT" ;;
    *) echo "$ENT_NATIVE" ;;   # empty for a real signature; see the --adhoc block below
  esac
}

sign() { # sign <path>
  local ent; ent="$(ent_for "$1")"
  codesign --force --sign "$IDENTITY" --options runtime ${TS_FLAG[@]+"${TS_FLAG[@]}"} ${ent:+--entitlements "$ent"} "$1"
}

# ---------- 2. sign inside-out ----------
say "2/6 Find and sign every binary, deepest first"
LIST="$(mktemp -t signlist)"; trap 'rm -f "$LIST" "$LIST.macho" "$LIST.bundles" "$LIST.err"; [ -z "${ADHOC_DIR:-}" ] || rm -rf "$ADHOC_DIR"' EXIT
# (a) Mach-O files anywhere inside the app (executables, .dylib, .so, .node, python, ffmpeg...)
find "$SIGNED" -type f -print0 | xargs -0 file -- 2>/dev/null | grep -E ': +Mach-O' | sed -E 's/: +Mach-O.*$//' > "$LIST.macho" || true
# (b) nested bundles that need their own seal (frameworks, helper apps, XPC services), excluding the main app
find "$SIGNED" -mindepth 2 \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -type d > "$LIST.bundles"
echo "  $(wc -l < "$LIST.macho" | tr -d ' ') Mach-O files, $(wc -l < "$LIST.bundles" | tr -d ' ') nested bundles"
# deepest path first. files before bundles at equal depth is not needed: a bundle path is always shorter than its contents.
{ while IFS= read -r p; do echo "$p"; done < "$LIST.macho"
  while IFS= read -r p; do echo "$p"; done < "$LIST.bundles"; } \
  | awk '{ n = gsub("/", "/"); print n "\t" $0 }' | sort -t$'\t' -k1,1nr > "$LIST"
COUNT=0
while IFS=$'\t' read -r _depth path; do
  [ -e "$path" ] || continue
  sign "$path" 2> "$LIST.err" || { cat "$LIST.err" >&2; die "codesign failed on: $path"; }
  COUNT=$((COUNT + 1))
done < "$LIST"
echo "  signed $COUNT items"
sign "$SIGNED" 2> "$LIST.err" || { cat "$LIST.err" >&2; die "codesign failed on the app itself"; }

# ---------- 3. verify ----------
say "3/6 Verify signature"
codesign --verify --deep --strict --verbose=2 "$SIGNED"
codesign -dv --verbose=2 "$SIGNED" 2>&1 | grep -E 'Authority|Identifier|flags|TeamIdentifier|Timestamp' || true

notarize() { # notarize <file-to-submit> <what>
  local f="$1" out
  say "Notarizing $2 (Apple usually answers in 1-10 minutes)"
  out="$(xcrun notarytool submit "$f" --keychain-profile "$PROFILE" --wait 2>&1)" || { echo "$out"; die "notarytool submit failed"; }
  echo "$out"
  if ! echo "$out" | grep -q 'status: Accepted'; then
    local id; id="$(echo "$out" | sed -n 's/^ *id: //p' | head -1)"
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" || true
    die "Apple rejected $2 (log above lists the offending files)"
  fi
}

DMG="$OUT/Reel-Studio-$DMG_VER-arm64.dmg"
if [ "$SKIP_NOTARIZE" = 1 ]; then
  say "4/6 Notarize: SKIPPED"
else
  say "4/6 Notarize the app"
  ZIP="$OUT/$PRODUCT.zip"
  ditto -c -k --keepParent "$SIGNED" "$ZIP"
  notarize "$ZIP" "the app"
  xcrun stapler staple "$SIGNED"
  rm -f "$ZIP"
fi

# ---------- 5. dmg ----------
say "5/6 Build the .dmg from the signed app"
RS_DMG_PLAIN_REASON="$DMG_PLAIN_REASON" bash "$HERE/dmg/make-dmg.sh" "$SIGNED" "$DMG" "$DMG_VOLUME"
if [ "$ADHOC" = 0 ]; then
  codesign --force --sign "$IDENTITY" ${TS_FLAG[@]+"${TS_FLAG[@]}"} "$DMG"
  if [ "$SKIP_NOTARIZE" = 0 ]; then
    notarize "$DMG" "the disk image"
    xcrun stapler staple "$DMG"
  fi
fi

# ---------- 6. final checks ----------
say "6/6 Final checks"
codesign --verify --deep --strict --verbose=2 "$SIGNED"
if [ "$ADHOC" = 1 ]; then
  echo "(ad-hoc: spctl would reject it by design, skipping Gatekeeper check)"
else
  spctl -a -vv --type exec "$SIGNED"
  if [ "$SKIP_NOTARIZE" = 0 ]; then
    xcrun stapler validate "$SIGNED"
    xcrun stapler validate "$DMG"
    spctl -a -vv --type open --context context:primary-signature "$DMG"
  fi
fi
echo
echo "DONE."
echo "  Signed app : $SIGNED"
echo "  Installer  : $DMG   ($(du -h "$DMG" | cut -f1))"
