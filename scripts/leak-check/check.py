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

# The public repo slug may appear verbatim (its owner part is a person's name by design).
ALLOW = "AidenJohnston/reel-studio-app"

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

# Not secret, so kept in the clear: a Windows path into a developer's own folders.
PLAIN = [("local path", re.compile(r"c:[\\/]+dev(?![a-z])", re.I))]
BIN_PATH = re.compile(rb"c:[\\/]+dev(?![a-z])", re.I)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}\b")  # "pkg@1.2.3" is not one
EMAIL_OK_VALUES = re.compile(r"^(?:[^@]+@example\.(?:com|org|net)|YOU@icloud\.com|noreply@example\.com)$", re.I)
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

    def line(self, text: str) -> bool:
        low = text.lower()
        words = list(WORD.finditer(low))
        if any(self.word(m.group()) for m in words):
            return True
        for m1, m2 in zip(words, words[1:]):
            gap = low[m1.end():m2.start()]
            if gap and gap.isspace() and self.pair(m1.group(), m2.group()):
                return True
        return False

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
                bare = line.replace(ALLOW, "")
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
    args = ap.parse_args()
    tree = read_tracked(args.root.resolve())
    findings = check_tree(tree, load_terms())
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
