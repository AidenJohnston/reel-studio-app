"""Runs the packaged app's own engine the way the app does (app/src/main/paths.ts) and fails unless `doctor` passes
every check a fresh install needs. The speech model, the GPU and disk space depend on the machine, not the build.

    python scripts/ci/check-bundle.py <resources dir of the unpacked app>
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

MACHINE_CHECKS = {"speech model", "GPU for listening", "fast preview encoder", "free disk space"}


def main() -> int:
    res = Path(sys.argv[1]).resolve()
    win = os.name == "nt"
    python = res / "python" / ("python.exe" if win else "bin/python3")
    exe = ".exe" if win else ""
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    tmp = tempfile.mkdtemp(prefix="rs bundle ")
    env.update({
        "PYTHONPATH": str(res / "engine"), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONNOUSERSITE": "1",
        "REELENGINE_FFMPEG": str(res / "ffmpeg" / f"ffmpeg{exe}"), "REELENGINE_FFPROBE": str(res / "ffmpeg" / f"ffprobe{exe}"),
        "REELENGINE_FONTS": str(res / "fonts"), "REELENGINE_MODELS": os.path.join(tmp, "models"),
        "REELENGINE_ROOT": os.path.join(tmp, "Reel Studio"),
    })
    out = subprocess.run([str(python), "-s", "-E", "-B", "-X", "utf8", "-m", "reelengine", "doctor"],
                         cwd=res / "engine", env=env, capture_output=True, text=True, encoding="utf-8")
    print(out.stdout)
    if out.stderr:
        print(out.stderr, file=sys.stderr)
    done = next((json.loads(line) for line in reversed(out.stdout.splitlines())
                 if line.startswith("{") and '"event":"done"' in line.replace(" ", "")), None)
    if not done:
        print("The bundled engine did not finish doctor.", file=sys.stderr)
        return 1
    failed = [c for c in done["result"]["checks"] if not c["ok"] and c["name"] not in MACHINE_CHECKS]
    for c in failed:
        print(f"FAILED  {c['name']}: {c['detail']} {c.get('fix', '')}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
