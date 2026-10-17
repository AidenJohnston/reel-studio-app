"""Measure what the vocabulary hints (transcribe.build_hints) do to accuracy on real takes.

    python engine/scripts/asr_hints_eval.py --spec takes.json --model <small.en dir> --out testdata/asr-eval

takes.json: [{"name", "take": "<raw .mp4>", "ref": "<words.json | words.fixed.json>",
              "title", "script": "<file>|null", "scriptSection": "<heading prefix>|null",
              "refFix": {"wrong": "right", ...}}, ...]
plus "corrections": [<corrections.json files from OTHER reels>] at the top level (the library).

Conditions per take: A = no hints (the old behaviour), B = title + the library's corrected words,
C = B + the take's script. Metrics against the reference text (which skips retakes, so extra words in
the raw take are NOT counted against it):
  * refErr: share of reference words NOT matched in order by the transcript (deletions +
    substitutions, a recall-side WER);
  * glossary: share of the reference's NAME/JARGON words (capitalised mid-sentence, or split into 2+
    pieces by whisper's tokenizer) that the transcript got exactly right.
Reads media only; writes transcripts + summary.json under --out.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reelengine import audio_env, transcribe  # noqa: E402


def norm(w: str) -> str:
    return re.sub(r"[^\w'+-]", "", w.lower().replace("’", "'")).strip("'-")


def ref_words(path: Path, fix: dict) -> list:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for x in data:
        for w in str(x["w"]).split():
            c = transcribe._clean_word(w)
            c = fix.get(c, fix.get(c.lower(), c))
            if norm(c):
                out.append((c, w))
    return out


def script_text(path, section):
    if not path:
        return ""
    t = Path(path).read_text(encoding="utf-8")
    if section:
        m = re.search(r"^##\s*" + re.escape(section) + r".*?$(.*?)(?=^##\s|\Z)", t, re.S | re.M)
        t = m.group(1) if m else t
    return t


def corrections(files) -> list:
    words = []
    for f in files:
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        cs = [{"from": k, "to": v} for k, v in (d.get("single") or {}).items()]
        cs += [{"from": " ".join(s["from"]), "to": " ".join(s["to"])} for s in d.get("spans") or []]
        words += transcribe._correction_targets(cs)
    return words


def is_gloss(ref, i, tok) -> bool:
    c, _ = ref[i]
    if len(c) < 2 or c.lower() in transcribe._COMMON or c.isdigit():
        return False
    initial = i == 0 or ref[i - 1][1][-1:] in ".!?"
    if any(ch.isupper() for ch in c[1:]) or (c[:1].isupper() and not initial):
        return True
    return len(tok(" " + c.lower())) >= 2


def score(ref: list, hyp: list, tok) -> dict:
    r = [norm(w) for w, _ in ref]
    h = [norm(w) for w in hyp]
    sm = difflib.SequenceMatcher(None, r, h, autojunk=False)
    matched = set()
    for b in sm.get_matching_blocks():
        matched.update(range(b.a, b.a + b.size))
    gloss = [i for i in range(len(ref)) if is_gloss(ref, i, tok)]
    missed = sorted({ref[i][0] for i in gloss if i not in matched})
    return {"refWords": len(r), "refErr": round(1 - len(matched) / max(1, len(r)), 4),
            "glossWords": len(gloss), "glossOk": round(sum(i in matched for i in gloss) / max(1, len(gloss)), 4),
            "glossMissed": missed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    a = ap.parse_args()
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    from faster_whisper import WhisperModel
    model = WhisperModel(a.model, device="cpu", compute_type="int8")
    tok = transcribe._tokenizer_fn(model)
    library = corrections(spec.get("corrections") or [])
    summary = []
    for t in spec["takes"]:
        wav = out / f"{t['name']}.wav"
        if not wav.exists():
            subprocess.run([a.ffmpeg, "-v", "error", "-y", "-i", t["take"], "-vn", "-ac", "1", "-ar", "16000",
                            "-c:a", "pcm_s16le", str(wav)], check=True)
        ref = ref_words(Path(t["ref"]), t.get("refFix") or {})
        script = script_text(t.get("script"), t.get("scriptSection"))
        conds = {"A": None,
                 "B": transcribe.build_hints({"title": t["title"], "library": library}, tok),
                 "C": transcribe.build_hints({"title": t["title"], "script": script, "library": library}, tok)}
        if not script:
            conds.pop("C")
        dur = len(audio_env.read_wav(wav)) / audio_env.SR
        for cname, hints in conds.items():
            t0 = time.time()
            words, _, _ = transcribe._transcribe_one(
                model, wav, "en", (hints or {}).get("initialPrompt"), dur, 0, 100,
                hotwords=(hints or {}).get("hotwords"))
            el = time.time() - t0
            hyp = [w["w"] for w in words]
            (out / f"{t['name']}.{cname}.txt").write_text(" ".join(hyp), encoding="utf-8")
            s = score(ref, hyp, tok)
            row = {"take": t["name"], "cond": cname, "seconds": round(el, 1), "hintWords": len((hints or {}).get("words") or []), **s}
            summary.append(row)
            print(json.dumps(row), flush=True)
        (out / f"{t['name']}.hints.json").write_text(json.dumps({k: v for k, v in conds.items()}, indent=1), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
