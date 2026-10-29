"""project.json: create, load, validate, save, and the word-anchor -> output-time mapping.

project.json is the only file the AI edits; the engine renders it deterministically. Saves are
atomic (write a temp file, then replace) so a crash mid-save can never leave half a project.
"""
from __future__ import annotations

import copy
import datetime as _dt
import json
import os
import re
import unicodedata
import uuid
from pathlib import Path
from typing import Optional

from . import cut as cutmod
from . import safepath
from .proto import EngineError

SCHEMA_PATH = Path(__file__).resolve().parent / "schema" / "project.schema.json"
SCHEMA_VERSION = 1

# The proven default look (80+ reels): Montserrat SemiBold 105 px on 1080x1920, max 3 words on one
# line, white with a solid black outline and no translucent shadow. position 0.75 centres the line at
# y 1440, so its bottom sits at ~y 1495 = his 425 px bottom margin, clear of the chin.
DEFAULT_CAPTION_STYLE = {"preset": "bold-lower", "font": "Montserrat SemiBold", "size": 105,
                         "maxWords": 3, "case": "upper", "color": "#FFFFFF", "outline": 8,
                         "outlineColor": "#000000", "shadow": 0, "position": 0.75}


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def slugify(text: str, fallback: str = "video") -> str:
    norm = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", norm).strip("-").lower()
    return slug[:60].strip("-") or fallback


def read_json(path: Path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data, indent: int = 2) -> None:
    """Atomic utf-8 JSON write with LF newlines."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=indent, ensure_ascii=False)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())        # power loss right after the rename must not leave an empty file
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def _fsync_dir(d: Path) -> None:
    """Make the rename itself durable (POSIX). Windows cannot fsync a directory handle: no-op."""
    if os.name == "nt":
        return
    try:
        fd = os.open(str(d), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def new_project(title: str, slug: Optional[str] = None) -> dict:
    t = now_iso()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": str(uuid.uuid4()),
        "title": title or "My video",
        "slug": slug or slugify(title),
        "createdAt": t, "updatedAt": t, "version": 0,
        "format": {"width": 1080, "height": 1920, "fps": 30},
        "sources": [],
        "transcript": None,
        "cut": {"keep": [], "gapCap": cutmod.GAP_CAP, "minSaving": cutmod.MIN_SAVING},
        "captions": {"enabled": True, "style": dict(DEFAULT_CAPTION_STYLE), "corrections": []},
        "music": {"enabled": False, "track": None, "startAt": 0.0, "level": "under-voice",
                  "automation": [], "fadeOut": 1.5},
        "broll": [],
        "zooms": [],
        "cover": {"atSourceTime": None, "source": None, "text": None},
        "post": {"caption": "", "hashtags": [], "keywords": []},
        "notes": [],
    }


_VALIDATOR = None


def _validator():
    global _VALIDATOR
    if _VALIDATOR is None:
        try:
            import jsonschema
        except ImportError:
            _VALIDATOR = False
            return None
        schema = read_json(SCHEMA_PATH)
        cls = jsonschema.validators.validator_for(schema)
        _VALIDATOR = cls(schema)
    return _VALIDATOR or None


def validate(proj: dict) -> list:
    """List of human-readable schema problems (empty = valid)."""
    v = _validator()
    problems = []
    if v is None:
        for key in ("schemaVersion", "id", "slug", "format", "sources", "cut"):
            if key not in proj:
                problems.append(f"missing required field {key!r}")
        return problems
    for err in sorted(v.iter_errors(proj), key=lambda e: list(e.absolute_path)):
        where = "/".join(str(p) for p in err.absolute_path) or "(root)"
        problems.append(f"{where}: {err.message}")
    return problems


def project_file(project_dir: Path) -> Path:
    return Path(project_dir) / "project.json"


def load(project_dir: Path, check: bool = True) -> dict:
    pf = project_file(project_dir)
    if not pf.exists():
        raise EngineError("NO_PROJECT", f"no project.json in {project_dir}",
                          "I couldn't find this video's project. It may have been moved.")
    try:
        proj = read_json(pf)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise EngineError("BAD_PROJECT", f"project.json is not valid JSON: {exc}",
                          "This video's project file is damaged. Try opening an earlier version.")
    if check:
        problems = validate(proj)
        if problems:
            raise EngineError("BAD_PROJECT", "project.json failed validation: " + "; ".join(problems[:8]),
                              "This video's edit has a mistake in it. Try undoing the last change.")
    return proj


def save(project_dir: Path, proj: dict, touch: bool = True) -> None:
    if touch:
        proj["updatedAt"] = now_iso()
    problems = validate(proj)
    if problems:
        raise EngineError("BAD_PROJECT", "refusing to save an invalid project: " + "; ".join(problems[:8]),
                          "Something went wrong saving your edit. Please try again.")
    write_json(project_file(project_dir), proj)


def edit_signature(proj: dict) -> str:
    """The parts of a project that change the rendered video (not bookkeeping fields)."""
    p = copy.deepcopy(proj)
    for key in ("updatedAt", "version", "notes", "post", "createdAt"):
        p.pop(key, None)
    return json.dumps(p, sort_keys=True, ensure_ascii=False)


def net_changes(before: dict, after: dict) -> list:
    """What an edit changed, as facts: `kind` is the project.json path, with `field` for one caption
    style key and `id` for one b-roll item or take. Compares end states, so a change made and then
    undone in the same edit is no fact (docs/schema-changes.md, notes[].receipt)."""
    facts = []

    def add(kind, a, b, **key):
        if a != b:
            facts.append({"kind": kind, **key, "before": a, "after": b})

    for section in ("cut", "captions", "music", "cover", "post"):
        a, b = before.get(section) or {}, after.get(section) or {}
        for k in sorted((a.keys() | b.keys()) - {"style"}):
            add(f"{section}.{k}", a.get(k), b.get(k))
    a = (before.get("captions") or {}).get("style") or {}
    b = (after.get("captions") or {}).get("style") or {}
    for k in sorted(a.keys() | b.keys()):
        add("captions.style", a.get(k), b.get(k), field=k)
    add("zooms", before.get("zooms") or [], after.get("zooms") or [])
    for kind, key in (("broll", "broll"), ("source", "sources")):
        a = {x["id"]: x for x in before.get(key) or []}
        b = {x["id"]: x for x in after.get(key) or []}
        for i in [*a, *(i for i in b if i not in a)]:
            add(kind, a.get(i), b.get(i), id=i)
    return facts


# --- transcript ---------------------------------------------------------------------------------

TRANSCRIPT_REL = "work/transcript.json"


def transcript_path(project_dir: Path, proj: Optional[dict] = None) -> Path:
    """Always <project>/work/transcript.json. `transcript.file` in project.json is informational:
    it used to be joined unchecked and then WRITTEN by transcribe."""
    return Path(project_dir) / "work" / "transcript.json"


def load_transcript(project_dir: Path, proj: dict) -> dict:
    tp = transcript_path(project_dir, proj)
    if not tp.exists():
        raise EngineError("NO_TRANSCRIPT", f"missing {tp}",
                          "I need to listen to your video first. Run the transcription step.")
    data = read_json(tp)
    if not data.get("words"):
        raise EngineError("NO_SPEECH", "transcript has no words",
                          "I couldn't hear anyone talking in this video. Try a different take.")
    return data


def source_meta(proj: dict) -> dict:
    return {s["id"]: {"duration": s.get("duration") or 0.0, "fps": s.get("fps") or 30.0,
                      "path": s["path"]} for s in proj.get("sources", [])}


def source_path(project_dir: Path, src: dict, root: Optional[Path] = None) -> Path:
    """A source's real path; must be inside the project's media/ or work/ (or root/Library)."""
    return safepath.safe_resolve(project_dir, src["path"], root=root, what=f"source {src.get('id')}")


def timeline(project_dir: Path, proj: dict, words: Optional[list] = None) -> cutmod.Timeline:
    """The project's cut on the output clock. Every word anchor maps through this."""
    if words is None:
        words = load_transcript(project_dir, proj)["words"]
    c = proj.get("cut") or {}
    keep = c.get("keep") or []
    if not keep:
        raise EngineError("EMPTY_CUT", "cut.keep is empty",
                          "There's nothing in the edit yet. Let me pick your takes first.")
    return cutmod.build_timeline(words, keep, source_meta(proj),
                                 gap_cap=float(c.get("gapCap", cutmod.GAP_CAP)),
                                 min_saving=float(c.get("minSaving", cutmod.MIN_SAVING)))


def _anchor_slots(proj: dict):
    """Every (container, key, role) in a project that holds a word id. role: 'from' | 'to'."""
    for r in (proj.get("cut") or {}).get("keep") or []:
        yield r, "from", "from"
        yield r, "to", "to"
    for b in proj.get("broll") or []:
        if isinstance(b.get("anchor"), dict):
            yield b["anchor"], "from", "from"
            yield b["anchor"], "to", "to"
    for z in proj.get("zooms") or []:
        if isinstance(z.get("anchor"), dict):
            yield z["anchor"], "from", "from"
            yield z["anchor"], "to", "to"
    for a in ((proj.get("music") or {}).get("automation") or []):
        yield a, "fromWord", "from"
        yield a, "toWord", "to"
    for h in ((proj.get("captions") or {}).get("hidden") or []):
        yield h, "from", "from"
        yield h, "to", "to"


def remap_anchors(proj: dict, old_words: list, new_words: list) -> int:
    """After a re-transcription, point any anchor whose word id vanished at the nearest new word in
    time (same source): a range start moves to the first word starting at/after it, a range end to
    the last word ending at/before it. Returns how many anchors moved."""
    new_ids = {w["id"] for w in new_words}
    old = {w["id"]: w for w in old_words}
    by_src: dict = {}
    for w in new_words:
        by_src.setdefault(w["source"], []).append(w)
    moved = 0
    for holder, key, role in _anchor_slots(proj):
        wid = holder.get(key)
        if not wid or wid in new_ids or wid not in old:
            continue
        o = old[wid]
        cands = by_src.get(o["source"]) or new_words
        if role == "from":
            after = [w for w in cands if w["s"] >= o["s"] - 0.05]
            pick = after[0] if after else cands[-1]
        else:
            before = [w for w in cands if w["e"] <= o["e"] + 0.05]
            pick = before[-1] if before else cands[0]
        holder[key] = pick["id"]
        moved += 1
    return moved


def anchor_span(tl: cutmod.Timeline, anchor: dict, lead_in: float = 0.0):
    """{from,to} word anchor -> (t0, t1) output seconds."""
    t0 = tl.word_out_time(anchor["from"]) - (lead_in or 0.0)
    t1 = tl.word_out_end(anchor["to"])
    t0 = max(0.0, min(t0, tl.duration))
    t1 = max(t0, min(t1, tl.duration))
    return t0, t1
