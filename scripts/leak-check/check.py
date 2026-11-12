#!/usr/bin/env python3
"""Leak check: refuse private material in the public repo.

Run from the repo root (or pass --root): python scripts/leak-check/check.py

It reads every tracked file (`git ls-files`) and fails on:
  * a private term (names of people, products and machines that must never ship). The list itself is
    private, so this repo stores only salted SHA-256 fingerprints of it (patterns.json) and checks every
    word against them. A finding names the file and line, never the term;
  * an e-mail address outside license and notice files;
  * a file over 5 MB that is not on the ship list;
  * a path that must never be committed (test footage, media, keys, .env, local agent settings, ...).

Other modes, each run by one layer of docs/leak-check.md:
  --staged               the staged content of the staged paths, not the working tree (the pre-commit hook)
  --text PATH [...]      text that is about to become public, such as a PR title or body; `-` reads stdin.
                         Same term, e-mail and local-path rules. A finding gives line and column, never the
                         term or the line, because this text is not in the repo for anyone to look up.
  --commit-message PATH  a commit message (the commit-msg hook): --text, stopping at git's scissors line, and
                         allowing no-reply addresses in trailers and the address on git's `#` comment lines

The maintainer regenerates patterns.json from the private list. Standard library only, so CI needs no
install step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SALT = "rsleak1"

# Exact phrases that may appear verbatim (case-sensitive); each is cut out of a line before the term check, so
# the same words anywhere else are still caught: the repo's former slug, which older installs still use (its owner
# part is a person's name by design), and the name of the company that owns Reel Studio.
# The company name is split so that main's own checker, which runs on every PR, passes this line too.
ALLOW = ("AidenJohnston/reel-studio-app", "Cur" + "ate Technologies")

NEVER_COMMIT = [re.compile(p, re.I) for p in (
    r"^(status|bakeoff|tools)/",
    r"^grandma\d*/",
    r"(^|/)testdata/",
    r"(^|/)node_modules/",
    r"(^|/)release/",
    r"(^|/)\.env($|\.)",
    r"\.(pem|key|p12|p8|cer|mobileprovision|keychain)$",
    r"(^|/)\.claude/",
    r"\.log$",
    r"\.(mp4|mov|m4v|mkv|avi|webm|mp3|m4a|aac|flac|ogg)$",
)]
NEVER_COMMIT_EXACT = {"SPEC.md", "docs/PUBLISH.md"}
NEVER_COMMIT_PREFIX = ("docs/RELEASE-NOTES",)
# The one .claude/ file that is shared, not local: Claude Code's project settings, which carry the repo's agent
# hook (docs/leak-check.md). Personal settings (.claude/settings.local.json), skills and agents stay refused.
SHARED_AGENT_SETTINGS = {".claude/settings.json"}

# Not secret, so kept in the clear: a Windows path into a developer's own folders.
PLAIN = [("local path", re.compile(r"c:[\\/]+dev(?![a-z])", re.I))]
BIN_PATH = re.compile(rb"c:[\\/]+dev(?![a-z])", re.I)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}\b")  # "pkg@1.2.3" is not one
EMAIL_OK_VALUES = re.compile(r"^(?:[^@]+@example\.(?:com|org|net)|YOU@icloud\.com|noreply@example\.com|support@getreelstudio\.com)$", re.I)
EMAIL_OK_PATHS = re.compile(
    r"^(?:packaging/licenses/|packaging/fonts/.*\.txt$|engine/reelengine/fonts/.*\.txt$|templates/fonts/.*\.txt$|"
    r"THIRD_PARTY\.md$|engine/THIRD_PARTY\.md$|LICENSE$)|(?:^|/)package-lock\.json$")

MAX_BYTES = 5 * 1024 * 1024
BIG_FILE_ALLOW = {
    "packaging/icons/icon.png", "packaging/icons/icon.icns", "packaging/icons/icon.ico",
    "engine/reelengine/models/face_detection_yunet_2023mar.onnx",
    "packaging/licenses/npm-licenses.txt",
}
BIG_FILE_ALLOW_PREFIXES = ("packaging/fonts/", "engine/reelengine/fonts/", "templates/fonts/", "packaging/licenses/")

TEXT_EXT = {
    ".md", ".txt", ".json", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".css", ".html", ".yml", ".yaml",
    ".py", ".sh", ".ps1", ".plist", ".toml", ".cfg", ".ini", ".svg", ".gitignore", ".gitattributes", ".lock",
    ".in", ".mdx",
}
WORD = re.compile(r"[a-z]+")


def fp(kind: str, text: str) -> str:
    return hashlib.sha256(f"{SALT}:{kind}:{text}".encode()).hexdigest()


class Terms:
    """The fingerprints, grouped by how a term matches a word (a run of ASCII letters):
    ex   the whole word                        pre  the start of a word
    sub  anywhere inside a word                pair a word ending in A, whitespace, a word starting with B
    pairx  like pair, but the first word is exactly A
    bpre / bsub  the same as pre / sub, for byte strings inside binary files."""

    def __init__(self, data: dict):
        self.sets: dict[str, set[str]] = {}
        self.lens: dict[str, set] = {}
        for e in data["terms"]:
            k = e["kind"]
            self.sets.setdefault(k, set()).add(e["fp"])
            self.lens.setdefault(k, set()).add(tuple(e["len"]) if isinstance(e["len"], list) else e["len"])
        self._cache: dict[tuple[str, str], bool] = {}

    def _has(self, kind: str, text: str) -> bool:
        return fp(kind, text) in self.sets.get(kind, ())

    def word(self, w: str, binary: bool = False) -> bool:
        key = (w, "b" if binary else "t")
        hit = self._cache.get(key)
        if hit is None:
            ex, pre, sub = ("-", "bpre", "bsub") if binary else ("ex", "pre", "sub")
            hit = (self._has(ex, w)
                   or any(len(w) >= n and self._has(pre, w[:n]) for n in self.lens.get(pre, ()))
                   or any(self._has(sub, w[i:i + n]) for n in self.lens.get(sub, ()) for i in range(len(w) - n + 1)))
            self._cache[key] = hit
        return hit

    def pair(self, a: str, b: str) -> bool:
        for la, lb in self.lens.get("pair", ()):
            if len(a) >= la and len(b) >= lb and self._has("pair", f"{a[-la:]} {b[:lb]}"):
                return True
        for la, lb in self.lens.get("pairx", ()):
            if len(a) == la and len(b) >= lb and self._has("pairx", f"{a} {b[:lb]}"):
                return True
        return False

    def find(self, text: str) -> int | None:
        """Index in `text` of the first word (or word pair) that matches a term, or None."""
        low = text.lower()
        words = list(WORD.finditer(low))
        hits = [m.start() for m in words if self.word(m.group())]
        hits += [m1.start() for m1, m2 in zip(words, words[1:])
                 if (gap := low[m1.end():m2.start()]) and gap.isspace() and self.pair(m1.group(), m2.group())]
        return min(hits, default=None)

    def line(self, text: str) -> bool:
        return self.find(text) is not None

    def blob(self, data: bytes) -> bool:
        low = data.lower()
        texts = [low.decode("latin-1")]
        for start in (0, 1):                       # UTF-16LE strings at either byte alignment
            chunk = low[start:]
            texts.append(chunk[: len(chunk) // 2 * 2].decode("utf-16-le", "ignore").lower())
        return any(self.word(m.group(), binary=True) for t in texts for m in WORD.finditer(t))


def is_text(path: str, data: bytes) -> bool:
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXT or os.path.basename(path) in (".gitignore", ".gitattributes", "LICENSE"):
        return b"\0" not in data[:8192]
    return False


def never_commit(path: str) -> bool:
    if path in SHARED_AGENT_SETTINGS:
        return False
    return path in NEVER_COMMIT_EXACT or path.startswith(NEVER_COMMIT_PREFIX) or any(r.search(path) for r in NEVER_COMMIT)


def check_tree(tree: dict[str, bytes], terms: Terms) -> list[str]:
    out: list[str] = []
    for path, data in sorted(tree.items()):
        if never_commit(path):
            out.append(f"{path}: [path] this kind of file must never be committed to the public repo")
        if terms.line(path) or any(rx.search(path) for _, rx in PLAIN):
            out.append(f"{path}: [private term] in the file NAME")
        if len(data) > MAX_BYTES and path not in BIG_FILE_ALLOW and not path.startswith(BIG_FILE_ALLOW_PREFIXES):
            out.append(f"{path}: [size] {len(data) / 1e6:.1f} MB is over the 5 MB limit and not on the ship list")
        if is_text(path, data):
            text = data.decode("utf-8", "replace")
            for i, line in enumerate(text.splitlines(), 1):
                bare = line
                for phrase in ALLOW:
                    bare = bare.replace(phrase, "")
                if terms.line(bare):
                    out.append(f"{path}:{i}: [private term] {line.strip()[:140]}")
                for label, rx in PLAIN:
                    if rx.search(bare):
                        out.append(f"{path}:{i}: [{label}] {line.strip()[:140]}")
                if not EMAIL_OK_PATHS.search(path):
                    for em in EMAIL_RE.findall(line):
                        if not EMAIL_OK_VALUES.match(em):
                            out.append(f"{path}:{i}: [email] {em}")
        else:
            if terms.blob(data):
                out.append(f"{path}: [private term] inside binary content")
            if BIN_PATH.search(data) or BIN_PATH.search(data.replace(b"\0", b"")):   # ASCII, then UTF-16LE
                out.append(f"{path}: [local path] inside binary content")
    return out


# A trailer such as "Co-authored-by: Name <address>" may carry an address that exists to be public.
TRAILER = re.compile(r"^[A-Za-z][A-Za-z0-9-]*:\s")
NOREPLY = re.compile(r"^(?:[^@]+@users\.noreply\.github\.com|noreply@[^@]+)$", re.I)
SCISSORS = "# ------------------------ >8 ------------------------"


def check_text(label: str, text: str, terms: Terms, commit_message: bool = False) -> list[str]:
    """Findings as `label:line:column: [kind]`. Never the term, the address or the line: unlike a file in a pull
    request, this text is not public yet, and the output may be (a CI log, an agent transcript)."""
    out: list[str] = []
    for i, line in enumerate(text.splitlines(), 1):
        # `#` lines are still checked: `git commit -F` keeps them. Only their e-mail is let through, because git's
        # own "# Author: Name <address>" line carries the address the commit already records.
        comment = commit_message and line.startswith("#")
        if commit_message and line.startswith(SCISSORS):
            break                               # git always cuts here: below is the diff (`commit -v`), not the message
        bare = line
        for phrase in ALLOW:                    # blanked, not removed, so columns still point into the original
            bare = bare.replace(phrase, " " * len(phrase))
        col = terms.find(bare)
        if col is not None:
            out.append(f"{label}:{i}:{col + 1}: [private term]")
        for kind, rx in PLAIN:
            if m := rx.search(bare):
                out.append(f"{label}:{i}:{m.start() + 1}: [{kind}]")
        for m in EMAIL_RE.finditer(line):
            ok = (comment or EMAIL_OK_VALUES.match(m.group())
                  or (commit_message and TRAILER.match(line) and NOREPLY.match(m.group())))
            if not ok:
                out.append(f"{label}:{i}:{m.start() + 1}: [email]")
    return out


def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.buffer.read().decode("utf-8", "replace")
    return Path(path).read_bytes().decode("utf-8", "replace")


def git_out(root: Path, *args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], input=stdin, capture_output=True, check=True).stdout


def read_staged(root: Path) -> dict[str, bytes]:
    """The index's content of every path this commit adds or changes. The working tree is not read: what is
    staged is what gets committed."""
    changed = set(git_out(root, "diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z")
                  .decode("utf-8").split("\0")) - {""}
    blobs: list[tuple[str, str]] = []
    for entry in git_out(root, "ls-files", "--stage", "-z").decode("utf-8").split("\0"):
        if not entry:
            continue
        meta, path = entry.split("\t", 1)
        mode, sha, stage = meta.split()
        if path in changed and stage == "0" and mode != "160000":     # 160000 is a submodule: no blob to read
            blobs.append((path, sha))   # a symlink's blob is its link text, as read_tracked reads it
    batch = git_out(root, "cat-file", "--batch", stdin="".join(f"{sha}\n" for _, sha in blobs).encode())
    tree, pos = {}, 0
    for path, _ in blobs:
        header_end = batch.index(b"\n", pos)
        size = int(batch[pos:header_end].split()[2])
        tree[path] = batch[header_end + 1:header_end + 1 + size]
        pos = header_end + 1 + size + 1
    return tree


def load_terms() -> Terms:
    return Terms(json.loads((HERE / "patterns.json").read_text(encoding="utf-8")))


def read_tracked(root: Path) -> dict[str, bytes]:
    names = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True).stdout
    tree = {}
    for n in names.decode("utf-8").split("\0"):
        p = root / n
        if not n:
            continue
        if p.is_symlink():                      # never follow a link out of the checkout: check its text instead
            tree[n] = os.readlink(p).encode("utf-8", "replace")
        elif p.is_file():                       # a deleted-but-staged file is not there to read
            tree[n] = p.read_bytes()
    return tree


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path("."), help="the checkout to scan (default: here)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="scan what is staged for the next commit")
    mode.add_argument("--text", nargs="+", metavar="PATH", help="scan text files; - reads stdin")
    mode.add_argument("--commit-message", metavar="PATH", help="scan a commit message file")
    args = ap.parse_args()
    terms = load_terms()

    if args.text or args.commit_message:
        paths = args.text or [args.commit_message]
        if paths.count("-") > 1:
            ap.error("stdin (-) can be read only once")
        findings = [f for p in paths
                    for f in check_text("stdin" if p == "-" else p, read_text(p), terms, bool(args.commit_message))]
        for f in findings:
            print("LEAK  " + f)
        if findings and args.commit_message:
            print(f"\nleak check: commit blocked ({len(findings)} finding(s) in the commit message): reword the flagged "
                  "lines and commit again (docs/leak-check.md; --no-verify is for a real hotfix only, and the pull "
                  "request must say so).", file=sys.stderr)
            return 1
        if findings:
            print(f"\nleak check: FAILED ({len(findings)} finding(s) in the text). Remove the private material; "
                  "a finding gives the line and column, never the word.", file=sys.stderr)
            return 1
        if not args.commit_message:             # a hook stays quiet when it passes
            print("leak check: passed (text)")
        return 0

    if args.staged:
        tree = read_staged(args.root.resolve())
        findings = check_tree(tree, terms)
        for f in findings:
            print("LEAK  " + f)
        if findings:
            print(f"\nleak check: commit blocked ({len(findings)} finding(s) in {len(tree)} staged files): remove or "
                  "reword the flagged lines, stage the fix and commit again (docs/leak-check.md; --no-verify is for a "
                  "real hotfix only, and the pull request must say so).", file=sys.stderr)
            return 1
        return 0

    tree = read_tracked(args.root.resolve())
    findings = check_tree(tree, terms)
    for f in findings:
        print("LEAK  " + f)
    if findings:
        print(f"\nleak check: FAILED ({len(findings)} finding(s) in {len(tree)} files). Remove the private material; "
              "a [private term] finding names the line, not the word.", file=sys.stderr)
        return 1
    print(f"leak check: passed ({len(tree)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
