"""Test engine: completes abnormally or starts a grandchild and sleeps until killed."""
import json
import subprocess
import sys
import time

if sys.argv[1] == "done-then-crash":
    print(json.dumps({"event": "done", "result": {"version": 2}}), flush=True)
    sys.exit(7)
if sys.argv[1] == "done-then-sleep":
    print(json.dumps({"event": "done", "result": {"version": 2}}), flush=True)

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
print(json.dumps({"event": "progress", "stage": "sleep", "pct": 1, "message": f"{child.pid}"}), flush=True)
time.sleep(120)
