import json
import subprocess
import sys
import time

# A new session puts the grandchild outside the engine's process group, so a group kill misses it. It inherits
# stdout, so the engine's pipe stays open and Node never emits `close` for the engine.
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
print(json.dumps({"event": "progress", "stage": "hold", "pct": 1, "message": f"{child.pid}"}), flush=True)
time.sleep(120)
