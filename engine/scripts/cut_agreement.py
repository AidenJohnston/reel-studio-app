"""Word-level agreement between the engine's cut and a reference cut given as SOURCE time spans.

  python engine/scripts/cut_agreement.py <project_dir> <reference.json> [--source s1]

reference.json: [{"start": s, "end": e}, ...] (source seconds). A word counts as kept by the reference
when its midpoint lies inside a reference span. Reports agreement, and which words disagree.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reelengine import cut as cutmod, project as projmod  # noqa: E402


def main():
    proj_dir, ref_path = Path(sys.argv[1]), Path(sys.argv[2])
    proj = projmod.load(proj_dir)
    words = projmod.load_transcript(proj_dir, proj)["words"]
    ref = json.loads(ref_path.read_text(encoding="utf-8"))
    spans = [(float(r["start"]), float(r["end"])) for r in ref]
    mine = set(cutmod.positions_from_keep(words, proj["cut"]["keep"]))
    agree = 0
    fp, fn = [], []
    for i, w in enumerate(words):
        m = (w["s"] + w["e"]) / 2
        r = any(a - 0.03 <= m <= b + 0.03 for a, b in spans)
        k = i in mine
        agree += r == k
        if k and not r:
            fp.append(w["w"])
        if r and not k:
            fn.append(w["w"])
    n = len(words)
    print(json.dumps({"words": n, "agreement": round(agree / n, 4),
                      "keptByEngineNotRef": len(fp), "keptByRefNotEngine": len(fn),
                      "extraKept": " ".join(fp)[:600], "missing": " ".join(fn)[:600]}, indent=1))


if __name__ == "__main__":
    main()
