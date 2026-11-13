"""Running the engine the way the app does, and keeping the reference engine honest.

The app starts `python -s -E -B -X utf8 -u -m reelengine <command> ...` with the folder holding the
`reelengine` package as its working directory (app/src/main/engine.ts). The harness does the same,
times the child process from outside, and reads the JSON-lines protocol (docs/architecture.md
section 4) for the `done` result.

The reference is the engine source at the commit pinned in config.json, written out of git's object
store blob by blob (no checkout, no line-ending conversion) and re-verified against that commit's
tree before every use, so an edited copy is refused rather than trusted.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

ENGINE_PKG = "engine/reelengine"
# Inherited REELENGINE_* variables would change what is measured (a forced draft encoder, another
# cache); the harness sets the ones it needs and drops the rest.
ENV_PREFIX = "REELENGINE_"


class Refusal(Exception):
    """The harness will not run: a pin does not match. The message says what to fix."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_id(data: bytes) -> str:
    """The id git gives a file with these bytes (`git hash-object`)."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _git(repo: Path, *args: str, stdin: bytes = None) -> bytes:
    p = subprocess.run(["git", "-C", str(repo), *args], input=stdin, capture_output=True)
    if p.returncode != 0:
        raise Refusal(f"git {' '.join(args[:3])} failed: {p.stderr.decode('utf-8', 'replace').strip()}")
    return p.stdout


def reference_tree(repo: Path, commit: str) -> dict:
    """{path relative to engine/: blob id} for the engine package at `commit`."""
    out = _git(repo, "ls-tree", "-r", "-z", commit, "--", ENGINE_PKG)
    tree = {}
    for rec in out.split(b"\0"):
        if not rec:
            continue
        meta, path = rec.split(b"\t", 1)
        _mode, kind, blob = meta.decode().split()
        if kind != "blob":
            continue
        tree[path.decode("utf-8")[len("engine/"):]] = blob
    if not tree:
        raise Refusal(f"commit {commit} has no {ENGINE_PKG}")
    return tree


def verify_reference(repo: Path, commit: str, dest: Path) -> None:
    """Refuse unless `dest` holds exactly the engine package of `commit`, byte for byte."""
    want = reference_tree(repo, commit)
    have = {}
    for f in dest.rglob("*"):
        if f.is_file():
            have[f.relative_to(dest).as_posix()] = git_blob_id(f.read_bytes())
    extra = sorted(set(have) - set(want))
    missing = sorted(set(want) - set(have))
    changed = sorted(p for p in set(want) & set(have) if want[p] != have[p])
    if extra or missing or changed:
        raise Refusal(f"reference engine at {dest} is not commit {commit}: "
                      f"changed {changed[:5]}, missing {missing[:5]}, extra {extra[:5]}. "
                      f"Delete that folder and run setup again.")


def extract_reference(repo: Path, commit: str, dest: Path) -> Path:
    """Write the pinned engine package under dest/reelengine (once), then verify it."""
    if not dest.exists():
        tree = reference_tree(repo, commit)
        tmp = dest.with_name(dest.name + ".part")
        shutil.rmtree(tmp, ignore_errors=True)
        paths = sorted(tree)
        batch = _git(repo, "cat-file", "--batch", stdin="".join(tree[p] + "\n" for p in paths).encode())
        pos = 0
        for p in paths:
            nl = batch.index(b"\n", pos)
            blob, kind, size = batch[pos:nl].decode().split()
            if blob != tree[p] or kind != "blob":
                raise Refusal(f"git cat-file returned {blob} {kind} for {p}")
            start = nl + 1
            data = batch[start:start + int(size)]
            pos = start + int(size) + 1
            out = tmp / p
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
        tmp.rename(dest)
    verify_reference(repo, commit, dest)
    return dest


def check_pins(cfg: dict, platform: str, ffmpeg: Path, ffprobe: Path, repo: Path) -> dict:
    """Refuse when the FFmpeg binaries are not the pinned ones or the reference commit is unknown.
    Returns what was checked, for the report."""
    ref = cfg["reference"]
    commit = ref["engineCommit"]
    _git(repo, "cat-file", "-e", f"{commit}^{{commit}}")
    seen = {}
    for name, exe in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)):
        pinned = (ref.get(f"{name}Sha256") or {}).get(platform)
        got = sha256_file(exe)
        seen[name] = {"path": str(exe), "sha256": got}
        if not pinned:
            raise Refusal(f"no {name} hash pinned for {platform} in config.json; this {name} is {got}. "
                          f"A person pins it (python -m harness pin prints the values).")
        if got != pinned:
            raise Refusal(f"{exe} has sha256 {got}, config.json pins {pinned} for {platform}. "
                          f"Use the pinned FFmpeg ({ref.get('ffmpegBuild')}).")
    return {"engineCommit": commit, **seen}


@dataclass
class Call:
    seconds: float          # wall clock of the child process, spawn to exit
    result: dict            # the `done` event's result
    stderr_tail: str


class Engine:
    """One engine source tree (the candidate's engine/ or the extracted reference)."""

    def __init__(self, pkg_parent: Path, python: str, env: dict):
        self.cwd = Path(pkg_parent)
        self.python = python
        self.env = env

    def check_import(self) -> None:
        """The interpreter must load reelengine from this tree, not an installed copy."""
        p = subprocess.run([self.python, "-s", "-E", "-B", "-c", "import reelengine; print(reelengine.__file__)"],
                           cwd=self.cwd, env=self.env, capture_output=True, text=True)
        loaded = Path(p.stdout.strip()).resolve() if p.returncode == 0 else None
        if loaded is None or (self.cwd.resolve() / "reelengine") not in loaded.parents:
            raise Refusal(f"{self.python} loads reelengine from {loaded or p.stderr.strip()}, "
                          f"not from {self.cwd}")

    def run(self, command: str, args: list, timeout: float = 1800) -> Call:
        cmd = [self.python, "-s", "-E", "-B", "-X", "utf8", "-u", "-m", "reelengine", command, *map(str, args)]
        t0 = time.perf_counter()
        p = subprocess.run(cmd, cwd=self.cwd, env=self.env, capture_output=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
        seconds = time.perf_counter() - t0
        done = err = None
        for line in p.stdout.decode("utf-8", "replace").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("event") == "done":
                done = ev.get("result")
            elif ev.get("event") == "error":
                err = ev
        tail = p.stderr.decode("utf-8", "replace")[-2000:]
        if p.returncode != 0 or done is None:
            raise RuntimeError(f"engine {command} failed (exit {p.returncode}): "
                               f"{(err or {}).get('message') or tail[-800:]}")
        return Call(seconds, done, tail)


def engine_env(ffmpeg: Path, ffprobe: Path, root: Path, machine_cache: Path, run_cache: Path,
               base: Optional[dict] = None) -> dict:
    env = {k: v for k, v in (base if base is not None else os.environ).items() if not k.startswith(ENV_PREFIX)}
    env.update({"REELENGINE_FFMPEG": str(ffmpeg), "REELENGINE_FFPROBE": str(ffprobe),
                "REELENGINE_ROOT": str(root),
                # the encoder probe: once per machine, like the app's (tools.encoder_works)
                "REELENGINE_CACHE": str(machine_cache),
                # song analysis and other per-user caches: fresh for each cold run
                "REELENGINE_CACHE_DIR": str(run_cache)})
    return env
