"""Pick the default whisper model by measurement: quality (WER vs a large-v3 GPU reference) vs
CPU speed (int8, the path a Mac without CUDA takes).

  python engine/scripts/bench_models.py --models base.en,small,small.en,medium.en take1.mp4 take2.mp4

Writes a JSON report to stdout. Needs REELENGINE_MODELS to hold every model named (and large-v3).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reelengine import audio_env, transcribe  # noqa: E402


def norm(text: str) -> list:
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return [t for t in text.split() if t not in {"um", "uh", "erm", "hmm", "mm"}]


def wer(ref: list, hyp: list) -> float:
    # Levenshtein over tokens
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
            prev, d[j] = d[j], cur
    return d[len(hyp)] / max(1, len(ref))


def run_model(name, device, wavs):
    from faster_whisper import WhisperModel
    if device == "cuda":
        transcribe.add_cuda_dll_dirs()
    t = time.time()
    model = WhisperModel(str(transcribe.model_dir(name)), device=device,
                         compute_type="float16" if device == "cuda" else "int8",
                         cpu_threads=0 if device == "cuda" else min(8, os.cpu_count() or 4))
    load = time.time() - t
    out = {}
    for wav in wavs:
        samples = audio_env.read_wav(wav)
        t = time.time()
        segs, _ = model.transcribe(samples, language="en", beam_size=5, word_timestamps=True,
                                   vad_filter=True, condition_on_previous_text=False,
                                   vad_parameters={"min_silence_duration_ms": 700, "speech_pad_ms": 250})
        words = [w.word for s in segs for w in (s.words or [])]
        out[str(wav)] = {"secs": time.time() - t, "dur": len(samples) / 16000, "text": " ".join(words)}
    return load, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="base.en,small,small.en,medium.en")
    ap.add_argument("--reference", default="large-v3")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="bench_"))
    wavs = []
    for i, f in enumerate(a.files):
        wavs.append(transcribe.extract_audio(Path(f), tmp / f"a{i}.wav"))
    report = {"files": a.files, "cpu_count": os.cpu_count(), "models": {}}
    _, ref = run_model(a.reference, "cuda", wavs)
    report["reference"] = {k: v["secs"] for k, v in ref.items()}
    for name in a.models.split(","):
        for device in ("cpu", "cuda"):
            load, got = run_model(name, device, wavs)
            total = sum(v["secs"] for v in got.values())
            dur = sum(v["dur"] for v in got.values())
            wers = [wer(norm(ref[k]["text"]), norm(v["text"])) for k, v in got.items()]
            report["models"][f"{name}/{device}"] = {
                "load": round(load, 2), "asr_secs": round(total, 2), "audio_secs": round(dur, 1),
                "rtf": round(total / dur, 3), "wer_vs_ref": [round(x, 4) for x in wers],
                "wer_mean": round(sum(wers) / len(wers), 4)}
            print(json.dumps({name + "/" + device: report["models"][f"{name}/{device}"]}), file=sys.stderr, flush=True)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
