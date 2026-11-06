"""Stand-in words over a real take, for the match and pace surveys when transcription can't run (test code only).

    python -m harness.grid_words <project folder> [--word 0.3] [--gap 0.1] [--phrase 8] [--pause 0.6]

Writes work/transcript.json with evenly spaced words: `--phrase` words of `--word` seconds `--gap` apart,
the last ending a sentence, then a `--pause` of silence. The surveys cut between these phrases, so the
cuts don't sit in the speaker's real pauses, but every frame they compare is the take's own. Refuses to
overwrite a transcript that is already there.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from reelengine import project as projmod


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="harness.grid_words")
    ap.add_argument("project")
    ap.add_argument("--word", type=float, default=0.3)
    ap.add_argument("--gap", type=float, default=0.1)
    ap.add_argument("--phrase", type=int, default=8)
    ap.add_argument("--pause", type=float, default=0.6)
    a = ap.parse_args(argv)
    pdir = Path(a.project)
    proj = projmod.load(pdir)
    out = projmod.transcript_path(pdir, proj)
    if out.exists():
        raise SystemExit(f"{out} already exists; this only stands in for a missing transcript")
    words, n = [], 0
    for src in proj["sources"]:
        t, end = 0.2, float(src.get("duration") or 0) - 0.5
        while t + a.word < end:
            last = (n + 1) % a.phrase == 0
            words.append({"id": f"w{n}", "source": src["id"], "s": round(t, 3), "e": round(t + a.word, 3),
                          "w": f"word{n}{'.' if last else ''}"})
            n += 1
            t += a.word + (a.pause if last else a.gap)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"words": words, "standIn": "harness.grid_words"}), encoding="utf-8")
    print(json.dumps({"words": len(words), "file": str(out)}))


if __name__ == "__main__":
    main()
