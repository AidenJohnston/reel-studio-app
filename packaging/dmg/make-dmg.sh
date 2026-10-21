#!/usr/bin/env bash
# Build the install disk image: a 640x432 Finder window with the background art, the app on the left and an
# Applications link on the right, toolbar hidden. sign-mac.sh calls this with the signed app.
#
#   packaging/dmg/make-dmg.sh APP OUT.dmg "VOLUME NAME"
#
# How: put the app, the link and .background/background.tiff in a writable image, open it in Finder and set
# the view with AppleScript (Finder saves it to the volume's .DS_Store), check that .DS_Store with
# check_layout.py, then compress to UDZO and check the final image again.
# Finder must be scriptable: the first run asks "Terminal wants to control Finder". Click OK (or allow it in
# System Settings > Privacy & Security > Automation). That is why this needs a GUI session, like signing does.
set -euo pipefail
APP="${1:?usage: make-dmg.sh APP OUT.dmg VOLUME_NAME}"; OUT="${2:?}"; VOL="${3:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="$(basename "$APP")"
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Finder finds the volume by name, so a second volume with the same name would get the layout instead.
[ ! -e "/Volumes/$VOL" ] || die "A disk called \"$VOL\" is already open. Eject it in Finder, then run this again."

# Under /tmp, not $TMPDIR: Finder's .DS_Store records the path of the writable image, and $TMPDIR is a per-user folder.
WORK="$(mktemp -d /tmp/rsdmg.XXXXXX)"
MNT=""
cleanup() {
  [ -z "$MNT" ] || hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

STAGE="$WORK/stage"
mkdir -p "$STAGE/.background"
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
bash "$HERE/render-background.sh" "$WORK/art"
cp "$WORK/art/background.tiff" "$STAGE/.background/background.tiff"

# Room for Finder's .DS_Store on top of the files; UDZO drops the free space again.
SIZE_KB=$(( $(du -sk "$STAGE" | cut -f1) + 20480 ))
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDRW -size "${SIZE_KB}k" "$WORK/rw.dmg" >/dev/null
rm -rf "$STAGE"
MNT="$(hdiutil attach -readwrite -noverify -noautoopen "$WORK/rw.dmg" | awk -F'\t' '/Apple_HFS/ {print $NF}')"
[ "$MNT" = "/Volumes/$VOL" ] || die "The image mounted at \"$MNT\", expected /Volumes/$VOL"

osascript - "$VOL" "$APP_NAME" <<'APPLESCRIPT' || die "Finder did not lay out the window. If macOS asked to let Terminal control Finder, allow it (System Settings > Privacy & Security > Automation) and run this again."
on run argv
  set volName to item 1 of argv
  set appName to item 2 of argv
  tell application "Finder"
    tell disk volName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 120, 840, 552}
      set opts to the icon view options of container window
      set arrangement of opts to not arranged
      set icon size of opts to 120
      set text size of opts to 12
      set label position of opts to bottom
      set shows item info of opts to false
      set background picture of opts to file ".background:background.tiff"
      -- Icon size and background only take effect after a reopen, and positions set before it are shifted.
      close
      open
      set position of item appName of container window to {166, 214}
      set position of item "Applications" of container window to {474, 214}
      -- Only reachable when this Mac shows hidden files: park them below the window instead of over the headline.
      repeat with hiddenName in {".background", ".DS_Store", ".fseventsd", ".Trashes"}
        try
          set position of item (contents of hiddenName) of container window to {320, 640}
        end try
      end repeat
      update without registering applications
      delay 1
      close
    end tell
  end tell
end run
APPLESCRIPT

# Finder saves .DS_Store a moment after the window closes.
for _ in $(seq 1 20); do python3 "$HERE/check_layout.py" "$MNT" >/dev/null 2>&1 && break; sleep 0.5; done
python3 "$HERE/check_layout.py" "$MNT" >/dev/null || die "Finder did not save the window layout as designed (details above)."
rm -rf "$MNT/.fseventsd" "$MNT/.Trashes"
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
MNT=""

rm -f "$OUT"
hdiutil convert "$WORK/rw.dmg" -format UDZO -o "$OUT" >/dev/null
python3 "$HERE/check_layout.py" "$OUT"
