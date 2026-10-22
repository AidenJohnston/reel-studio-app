import json
import sys
import time

if sys.argv[1] == "done":
    result = {"event": "done", "result": {"imported": ["song.mp3"]}}
else:
    result = {"event": "error", "code": "CLASSIFY_FAILED", "userMessage": "Try another file.", "message": "fixture classification error"}

print(json.dumps(result), flush=True)
print(json.dumps({"event": "progress", "stage": "shutdown", "pct": 100, "message": "Waiting to exit"}), flush=True)
time.sleep(120)
