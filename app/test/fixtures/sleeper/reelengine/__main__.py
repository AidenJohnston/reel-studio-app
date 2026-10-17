"""Test engine: starts a grandchild process, reports both pids, then sleeps until killed."""
import json
import subprocess
import sys
import time

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
print(json.dumps({"event": "progress", "stage": "sleep", "pct": 1, "message": f"{child.pid}"}), flush=True)
time.sleep(120)
