"""Are captions (and every word anchor) in sync with the rendered video?

Re-transcribes the rendered mp4 with faster-whisper word timestamps and compares each recognised
word's start against where the engine's timeline says that word plays (the times the captions and
b-roll anchors use). Words are paired by sequence alignment of the normalised text.

  python engine/scripts/check_sync.py <project_dir> <render.mp4> [--window a]

Prints JSON: matched words, median / p90 / max |delta| in seconds. Whisper's own word-start jitter
is ~0.05-0.1 s, so a median under ~0.1 s with no drift trend means in sync.
"""
import argparse
import json
import re
import statistics
import sys
import tempfile
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reelengine import audio_env, project as projmod, transcribe  # noqa: E402


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("video")
    ap.add_argument("--offset", type=float, default=0.0, help="output time of the video's first frame")
    ap.add_argument("--model", default="small.en")
    a = ap.parse_args()
    P = Path(a.project)
    proj = projmod.load(P)
    tl = projmod.timeline(P, proj)
    expected = [(norm(w["w"]), w["s"] - a.offset) for w in tl.words_out]
    wav = Path(tempfile.mkdtemp()) / "a.wav"
    transcribe.extract_audio(Path(a.video), wav)
    model, dev, _ = transcribe.load_model(a.model)
    segs, _ = model.transcribe(audio_env.read_wav(wav), language="en", beam_size=5, word_timestamps=True,
                               condition_on_previous_text=False)
    heard = [(norm(w.word), float(w.start)) for s in segs for w in (s.words or [])]
    sm = SequenceMatcher(None, [e[0] for e in expected], [h[0] for h in heard], autojunk=False)
    deltas = []
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            e, h = expected[blk.a + k], heard[blk.b + k]
            if e[0] and e[1] >= 0:
                deltas.append((e[1], h[1] - e[1]))
    ab = sorted(abs(d) for _, d in deltas)
    third = max(1, len(deltas) // 3)
    early = statistics.median(d for _, d in deltas[:third])
    late = statistics.median(d for _, d in deltas[-third:])
    print(json.dumps({
        "expectedWords": len(expected), "heardWords": len(heard), "matched": len(deltas),
        "medianAbs": round(statistics.median(ab), 3), "p90Abs": round(ab[int(0.9 * (len(ab) - 1))], 3),
        "maxAbs": round(ab[-1], 3), "medianSignedFirstThird": round(early, 3),
        "medianSignedLastThird": round(late, 3), "device": dev}, indent=1))


if __name__ == "__main__":
    main()
