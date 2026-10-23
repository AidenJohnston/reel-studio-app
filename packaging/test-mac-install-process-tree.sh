#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/test-mac-install.sh"
bash -n "$SCRIPT"

# Load only the cleanup function from the installer script.
eval "$(awk '
  /^stop_started_process_tree\(\)/ { capture = 1 }
  capture {
    print
    opens += gsub(/\{/, "{")
    closes += gsub(/\}/, "}")
    if (opens == closes) exit
  }
' "$SCRIPT")"

# The real timeout path waits five seconds. The process assertions do not need that delay.
sleep() { :; }

TMP="$(mktemp -d /tmp/rs-process-tree-test.XXXXXX)"
cleanup() {
  kill "$UNRELATED" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

FAKE_APP_DIR="$TMP/[abc]"
# This dummy process is unrelated, but its command line matches the old pgrep -f pattern.
bash -c 'while :; do sleep 1; done' bash "$TMP/a/Contents/Resources/python" &
UNRELATED=$!
disown "$UNRELATED" 2>/dev/null || true
pattern="$FAKE_APP_DIR/Contents/Resources/python"
for _ in 1 2 3 4 5; do
  pgrep -f "$pattern" | grep -Fx "$UNRELATED" >/dev/null && break
  sleep 0.1
done
pgrep -f "$pattern" | grep -Fx "$UNRELATED" >/dev/null

# The cleanup function must stop only the process tree rooted at the PID it was given.
command sleep 30 &
started=$!
stop_started_process_tree "$started"
if kill -0 "$started" 2>/dev/null; then
  echo "started process survived cleanup" >&2
  exit 1
fi
if ! kill -0 "$UNRELATED" 2>/dev/null; then
  echo "unrelated matching process was killed" >&2
  exit 1
fi

echo "process-tree cleanup passed"
