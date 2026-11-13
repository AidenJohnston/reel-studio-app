#!/usr/bin/env bash
# Usage: make-dmg.sh APP OUT.dmg VOLUME_NAME, or --why-plain.
# Finder control needs a GUI login and Automation permission; otherwise the image uses a plain window.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Asking Finder can wait on the "control Finder" question; give a person 60 s to answer it, then treat it as denied.
finder_answers() {
  osascript -e 'tell application "Finder" to get name of startup disk' >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid"; return; }
    sleep 0.5
  done
  kill "$pid" 2>/dev/null || true
  return 1
}
why_plain() {
  if [ "${RS_DMG_PLAIN:-0}" = 1 ]; then echo "RS_DMG_PLAIN=1 is set"
  elif [ "$(launchctl managername 2>/dev/null)" != Aqua ]; then echo "there is no GUI login session (SSH or CI)"
  elif ! finder_answers; then echo "macOS did not let this script control Finder (System Settings > Privacy & Security > Automation)"
  fi
}
if [ "${1:-}" = --why-plain ]; then why_plain; exit 0; fi

APP="${1:?usage: make-dmg.sh APP OUT.dmg VOLUME_NAME}"; OUT="${2:?}"; VOL="${3:?}"
APP_NAME="$(basename "$APP")"
# sign-mac.sh asks once at the start and passes the answer on, so a slow or denied Finder is not asked twice.
PLAIN_REASON="${RS_DMG_PLAIN_REASON-$(why_plain)}"

# Under /tmp, not $TMPDIR: Finder's .DS_Store records the path of the writable image, and $TMPDIR is a per-user folder.
WORK="$(mktemp -d /tmp/rsdmg.XXXXXX)"
MNT=""
cleanup() {
  [ -z "$MNT" ] || hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

STAGE="$WORK/stage"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"

if [ -n "$PLAIN_REASON" ]; then
  echo "Plain disk window, without the art: $PLAIN_REASON."
  rm -f "$OUT"
  hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
  exit 0
fi

# Finder finds the volume by name, so a second volume with the same name would get the layout instead.
[ ! -e "/Volumes/$VOL" ] || die "A disk called \"$VOL\" is already open. Eject it in Finder, then run this again."
bash "$HERE/render-background.sh" "$WORK/art"
mkdir "$STAGE/.background"
cp "$WORK/art/background.tiff" "$STAGE/.background/background.tiff"

# Room for Finder's .DS_Store on top of the files; UDZO drops the free space again.
SIZE_KB=$(( $(du -sk "$STAGE" | cut -f1) + 20480 ))
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDRW -size "${SIZE_KB}k" "$WORK/rw.dmg" >/dev/null
rm -rf "$STAGE"
MNT="$(hdiutil attach -readwrite -noverify -noautoopen "$WORK/rw.dmg" | awk -F'\t' '/Apple_HFS/ {print $NF}')"
[ "$MNT" = "/Volumes/$VOL" ] || die "The image mounted at \"$MNT\", expected /Volumes/$VOL"

osascript - "$MNT" "$APP_NAME" <<'APPLESCRIPT' || die "Finder did not lay out the window. If macOS asked to let Terminal control Finder, allow it (System Settings > Privacy & Security > Automation) and run this again."
on run argv
  -- By mount path, not `disk "<name>"`: Finder's list of disks can lag behind hdiutil (seen as error -1728 when a
  -- same-named disk was ejected seconds before), while an alias resolves through the file system.
  set volAlias to (POSIX file (item 1 of argv)) as alias
  set appName to item 2 of argv
  tell application "Finder"
    tell (item volAlias)
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

# Finder saves .DS_Store after the window closes. Wait up to ten seconds before compressing.
for _ in $(seq 1 20); do [ ! -s "$MNT/.DS_Store" ] || break; sleep 0.5; done
[ -s "$MNT/.DS_Store" ] || die "Finder did not save the window layout."
rm -rf "$MNT/.fseventsd" "$MNT/.Trashes"
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
MNT=""

rm -f "$OUT"
hdiutil convert "$WORK/rw.dmg" -format UDZO -o "$OUT" >/dev/null
