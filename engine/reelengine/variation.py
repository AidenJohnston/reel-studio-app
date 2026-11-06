"""Repeatable choices within a cut style, and edits for one-variable trials."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import random
import secrets
from pathlib import Path

from . import project as projects
from .cut import MATCH_HOLD
from .cut_style import CUT_STYLES
from .proto import EngineError

VARIABLES = ("seed", "hook", "cover", "caption", "brightness")


def resolve(project: dict, timeline) -> tuple[dict, dict | None]:
    p = copy.deepcopy(project)
    style = p.get("cutStyle")
    if not style:
        return p, None
    settings = CUT_STYLES[style["preset"]]
    rng = random.Random(style["seed"])
    pair = [settings["framingPair"][0], round(settings["framingPair"][1] + rng.uniform(-.03, .03), 6)]
    start = rng.randrange(2)
    lead = round(rng.uniform(.10, .16), 6)
    phase = round(rng.uniform(-.5, .5), 6)
    choices, offsets = {}, []
    groups, grouped = {}, set()
    for i, z in enumerate(p.get("zooms") or []):
        group = z.get("accentGroup")
        if isinstance(group, str) and group:
            grouped.add(i)
            anchor = z.get("anchor") or {}
            if timeline.is_kept(anchor.get("from")) and timeline.is_kept(anchor.get("to")):
                groups.setdefault(group, []).append(i)
    for group, indices in groups.items():
        choices[group] = rng.choice(indices)
    selected = set(choices.values())
    p["zooms"] = [z for i, z in enumerate(p.get("zooms") or []) if i not in grouped or i in selected]
    ramps = []
    for z in p["zooms"]:
        z["scale"] = pair[1]
        # All variation draws share this local generator in a fixed order.
        frames = max(1, round(.22 * p["format"]["fps"]) + rng.randint(-2, 2))
        z["resolvedRampFrames"] = frames
        ramps.append(frames)
    for b in p.get("broll") or []:
        b["leadIn"] = lead
    for i, keep in enumerate((p.get("cut") or {}).get("keep") or []):
        join = keep.get("join")
        if isinstance(join, dict) and join.get("transition") in ("j", "l"):
            join["frames"] = rng.randint(6, 12)
            offsets.append({"join": i, "frames": join["frames"]})
    band = settings["secondsPerVisualChange"]
    framing = []
    if timeline.duration > 0:
        changes = [0.0]
        if band:
            cadence = sum(band) / 2
            target = cadence + phase
            # a framing switch on a match cut would show its two sides differently
            held = [s.out_start for s in timeline.segments if s.join_transition == "match"]
            boundaries = sorted({float(w["s"]) for w in timeline.words_out
                                 if w["s"] > 0 and all(abs(w["s"] - h) >= MATCH_HOLD for h in held)})
            # A cut already changes the picture. On a real take (harness/pace_survey.py, Windows 11) every pace
            # added its switches on top of the cut's own, so Calm changed the picture more often than no pace at
            # all: a switch closer to a cut than the band's shortest hold is left out.
            cuts = [float(s.out_start) for s in list(timeline.segments)[1:]]
            while target < timeline.duration:
                candidates = [t for t in boundaries if t > changes[-1] and abs(t - target) <= .5]
                if candidates:
                    pick = min(candidates, key=lambda t: (abs(t - target), t))
                    if not any(abs(c - pick) < band[0] for c in cuts):
                        changes.append(pick)
                target += cadence
        for i, t0 in enumerate(changes):
            framing.append({"t0": t0, "t1": changes[i + 1] if i + 1 < len(changes) else timeline.duration,
                            "scale": pair[(start + i) % 2]})
    return p, {"seed": style["seed"], "framingPair": pair, "startFraming": start,
               "cardLead": lead, "cadencePhase": phase, "accentChoices": choices,
               "jlOffsets": offsets, "zoomRamps": ramps, "framing": framing}


def _bad(message):
    raise EngineError("BAD_VARIANT", message, message)


def _value(p, variable):
    if variable == "seed":
        return (p.get("cutStyle") or {}).get("seed")
    if variable == "hook":
        return ((p.get("cut") or {}).get("keep") or [None])[0]
    if variable == "cover":
        return p.get("cover")
    if variable == "caption":
        return (p.get("post") or {}).get("caption", "")
    return p.get("exposure", 1.0)


def make_variant(project: dict, variable: str, *, value=None) -> dict:
    """Return a copy changing one edit variable; the editor supplies semantic alternatives."""
    if variable not in VARIABLES:
        _bad("variable must be seed, hook, cover, caption, or brightness")
    p = copy.deepcopy(project)
    before = _value(p, variable)
    if variable == "seed":
        if not p.get("cutStyle"):
            _bad("Choose a cut style before making a seed trial.")
        if value is not None:
            _bad("Seed trials generate their own seed; omit value.")
        seed = secrets.randbelow(2 ** 31)
        while seed == before:
            seed = secrets.randbelow(2 ** 31)
        p["cutStyle"]["seed"] = seed
    elif variable == "hook":
        if not before or not isinstance(value, dict) or set(value) != {"from", "to"} or not all(isinstance(v, str) and v for v in value.values()):
            _bad("A hook trial needs the editor's different opening candidate.")
        p["cut"]["keep"][0] = {**before, **value}
    elif variable == "cover":
        if not isinstance(value, dict) or set(value) - {"atSourceTime", "source", "text", "exact"}:
            _bad("A cover trial needs a source time and source.")
        p["cover"] = {**(before or {}), **value}
        src = next((s for s in p.get("sources", []) if s["id"] == p["cover"].get("source")), None)
        at = p["cover"].get("atSourceTime")
        if not src or type(at) not in (int, float) or not math.isfinite(at) or at < 0 or (src.get("duration") and at >= src["duration"]):
            _bad("The cover time must be inside the source.")
    elif variable == "caption":
        if not isinstance(value, str) or not value.strip():
            _bad("A caption trial needs a non-empty caption.")
        p.setdefault("post", {})["caption"] = value
    else:
        if value is None:
            value = 8
        if type(value) not in (int, float) or value not in (-8, 8):
            _bad("Brightness trials need +8 or -8 percent exposure.")
        p["exposure"] = round(before * (1 + value / 100), 8)
    if _value(p, variable) == before:
        _bad("The alternative must differ from the current edit.")
    problems = projects.validate(p)
    if problems:
        _bad("Invalid variant: " + "; ".join(problems[:8]))
    return p


def recover_transaction(project_dir: Path) -> None:
    """Finish a durable trial intent before another engine read or write proceeds.

    Call with the project owner lock held. Only the two recorded states are safe
    to replay; an unrelated edit must never be replaced during crash recovery.
    """
    folder = Path(project_dir)
    journal = folder / '.trial-transaction.json'
    if not journal.exists():
        return
    transaction = projects.read_json(journal)
    required = {'before_project', 'after_project', 'before_trials', 'after_trials'}
    if (not isinstance(transaction, dict) or transaction.get('version') != 1
            or not required <= transaction.keys()
            or not all(isinstance(transaction[k], dict) for k in ('before_project', 'after_project'))
            or not all(isinstance(transaction[k], list) for k in ('before_trials', 'after_trials'))):
        _bad('The pending trial transaction is invalid. Preserve it for recovery.')
    project_path, trial_path = folder / 'project.json', folder / 'trials.json'
    current = projects.read_json(project_path)
    trials = projects.read_json(trial_path) if trial_path.exists() else []
    if (current not in (transaction['before_project'], transaction['after_project'])
            or trials not in (transaction['before_trials'], transaction['after_trials'])):
        raise EngineError('TRIAL_CONFLICT', 'The project or trials changed during trial recovery.',
                          'The pending trial conflicts with a newer edit. Preserve both for recovery.')
    if current != transaction['after_project']:
        projects.write_json(project_path, transaction['after_project'])
    if trials != transaction['after_trials']:
        projects.write_json(trial_path, transaction['after_trials'])
    journal.unlink()
    projects._fsync_dir(folder)


def create_variant(project_dir: Path, variable: str, *, value=None, project_file: Path | None = None) -> dict:
    """Commit one trial and retain its exact parent independently of rendered versions.

    With `project_file` (a note's private copy of project.json) the trial changes that copy and
    leaves project.json alone: the note replaces project.json itself when it finishes, and refuses
    to when project.json changed under it.
    """
    project_dir = Path(project_dir)
    with projects.owner_lock(project_dir):
        if project_file is not None:
            # project.json is not read below, so finish any trial left half-written in it first
            recover_transaction(project_dir)
        parent = projects.load(project_dir, file=project_file)
        variant = make_variant(parent, variable, value=value)
        if variable == "hook":
            words = projects.load_transcript(project_dir, parent)["words"]
            index = {w["id"]: i for i, w in enumerate(words)}
            seen = set()
            for keep in variant["cut"]["keep"]:
                a, b = index.get(keep["from"]), index.get(keep["to"])
                if a is None or b is None or b < a or seen.intersection(range(a, b + 1)):
                    _bad("The hook must use real, forward word IDs without repeating the body.")
                seen.update(range(a, b + 1))
        # Check the revision even under the lock: a caller may have changed the
        # project while constructing the alternative, before the intent exists.
        if projects.load(project_dir, file=project_file) != parent:
            raise EngineError('TRIAL_CONFLICT', 'The project changed while making the trial.',
                              'The edit changed. Read it again before making a trial.')
        trial_path = project_dir / "trials.json"
        trials = projects.read_json(trial_path) if trial_path.exists() else []
        if not isinstance(trials, list):
            _bad("trials.json must contain a list of trials.")
        encoded = json.dumps(parent, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        parent_id = hashlib.sha256(encoded).hexdigest()
        snapshot = f'trials/parents/{parent_id}.json'
        snapshot_path = project_dir / snapshot
        if snapshot_path.exists():
            if projects.read_json(snapshot_path) != parent:
                _bad('The saved trial parent does not match its identity.')
        else:
            projects.write_json(snapshot_path, parent)
        trial = {"parent_version": parent.get("version", 0), "variable": variable,
                 "from": _value(parent, variable), "to": _value(variant, variable),
                 "parent_id": parent_id, "parent_snapshot": snapshot}
        if project_file is not None:
            # The copy is private to the note and discarded if the note fails, so it needs no journal;
            # the log is one atomic write after it. An entry whose note never lands is skipped by
            # comparison readers, which check the next version's edit against it (ai/src/learning.ts).
            projects.write_json(project_file, variant)
            projects.write_json(trial_path, [*trials, trial])
            return {"project": variant, "trial": trial}
        # Intent is durable before either public file changes. A restart completes
        # it once under the owner lock, including exits between the two replacements.
        projects.write_json(project_dir / '.trial-transaction.json', {
            'version': 1, 'before_project': parent, 'after_project': variant,
            'before_trials': trials, 'after_trials': [*trials, trial]})
        recover_transaction(project_dir)
        return {"project": variant, "trial": trial}
