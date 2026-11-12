#!/bin/sh
# Run a leak-check script with the first real Python 3 on PATH (docs/leak-check.md).
#   sh scripts/leak-check/with-python.sh [--agent-hook] SCRIPT [ARGS...]
#
# Tries python3, python and py, keeping the first that runs Python 3.8 or later. Asking each one for its version
# matters on Windows, where python3 is often a Store shortcut that prints a message and exits instead of running.
#
# Without Python the git hooks fail closed: the commit stops. --agent-hook is for the agent hook, which sees every
# shell command an agent runs: it then blocks every command that may call gh (it can't tell which ones publish),
# and lets everything else run.

agent=
if [ "$1" = "--agent-hook" ]; then
  agent=1
  shift
fi

for py in python3 python py; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
    exec "$py" "$@"
  fi
done

if [ -n "$agent" ]; then
  input=$(cat)
  case $input in
    *[!A-Za-z0-9_-][Gg][Hh][!A-Za-z0-9_-]*)       # gh as a word, as in the JSON's command text
      echo "Leak check: this command may call gh, and checking what gh publishes needs Python 3 on PATH (python3, python or py). Install Python 3 and run the command again." >&2
      exit 2 ;;
  esac
  exit 0
fi
echo "leak check: commit blocked: the check needs Python 3 on PATH (python3, python or py); install it and commit again (docs/leak-check.md)." >&2
exit 1
