"""Test engine: starts a grandchild process and reports its pid, then sleeps until killed, or with
`crash` dies at once and leaves the grandchild running (as a crashed render leaves its ffmpeg)."""
import json
import os
import subprocess
import sys
import time

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(json.dumps({"event": "progress", "stage": "sleep", "pct": 1, "message": f"{child.pid}"}), flush=True)
if sys.argv[1] == "crash":
    os._exit(1)
time.sleep(120)
