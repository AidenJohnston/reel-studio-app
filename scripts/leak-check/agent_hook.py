#!/usr/bin/env python3
"""Agent hook: run the leak check on the text a gh command is about to publish (docs/leak-check.md).

Claude Code (.claude/settings.json) and Codex (.codex/hooks.json) run it before each shell command, with the tool
call as JSON on stdin. Exit 0 lets the command run; exit 2, with the reason on stderr, blocks it. Both agents read
exit 2 as "block".

It acts only on gh commands that publish text: `gh pr create|edit|comment|review`, `gh issue create|edit|comment`,
and `gh api` calls that send fields or a request body. For those it checks, with check.py's text rules:
  * the whole command, so text inline in a flag, a heredoc or a here-string is covered without parsing the shell;
  * every file the command names as text (--body-file / -F, --input, -F key=@file, $(cat FILE), $(<FILE)).
Text it can't read is not waved through: stdin that isn't a heredoc or here-string, a shell variable or command
substitution, and --fill (which copies commit messages) all block, with what to do instead.

Shell parsing here is deliberately small: only enough to find those flags and their files. A private term anywhere
in the command still blocks it, whatever the parser made of the rest.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check  # noqa: E402  (check.py sits next to this file)

GH = re.compile(r"(?<![\w./\\-])gh(?:\.exe)?\s+(?:(?:-R|--repo)[\s=]\S+\s+)?"
                r"(pr\s+(?:create|edit|comment|review)|issue\s+(?:create|edit|comment)|api)(?![\w-])")
HEREDOC = re.compile(r"<<-?\s*['\"]?[A-Za-z_]|@['\"]\s*$", re.M)   # bash heredoc, PowerShell here-string
CD = re.compile(r"(?:^|[;&|(\n]\s*)(?:cd|pushd|Set-Location|sl|Push-Location)\s+(\"[^\"]*\"|'[^']*'|[^\s;&|)]+)", re.I)
CAT = re.compile(r"^\$\(\s*(?:cat|type|gc|Get-Content)\s+(?:-Raw\s+)?([^\s()$`]+)(?:\s+-Raw)?\s*\)$", re.I)
SLURP = re.compile(r"^\$\(<\s*([^\s()$`]+)\s*\)$")

TEXT_FLAGS = {"-t", "--title", "-b", "--body"}          # pr / issue: inline text
FILE_FLAGS = {"-F", "--body-file"}                      # pr / issue: a file, or - for stdin
FILL_FLAGS = {"-f", "--fill", "--fill-first", "--fill-verbose"}   # pr create only: text from commit messages
API_RAW = {"-f", "--raw-field"}
API_TYPED = {"-F", "--field"}                           # key=@file reads a file
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class Blocked(Exception):
    """The command can't be shown to be clean; the message says what to do."""


def lex(line: str, powershell: bool) -> list[tuple[str, bool]]:
    """Words of one command up to the first unquoted && || ; or |, as (value, dynamic). `dynamic` means the shell
    fills part of the word in at run time ($VAR, $(...), and in PowerShell (...)), so its text can't be read here."""
    esc = "`" if powershell else "\\"
    words: list[tuple[str, bool]] = []
    cur: str | None = None
    dyn = False
    quote = None
    i, n = 0, len(line)

    def expands(j: int) -> bool:
        return line[j] == "$" and j + 1 < n and (line[j + 1].isalpha() or line[j + 1] in "_{(")

    while i < n:
        c = line[i]
        if quote is None:
            if c.isspace():
                if cur is not None:
                    words.append((cur, dyn))
                cur, dyn = None, False
            elif line.startswith(("&&", "||"), i) or c in ";|":
                break
            elif c in "'\"":
                quote, cur = c, cur or ""
            elif c == esc and i + 1 < n:
                cur = (cur or "") + line[i + 1]
                i += 1
            else:
                if expands(i) or (powershell and cur is None and c in "($@"):
                    dyn = True
                cur = (cur or "") + c
        elif quote == "'":
            if c == "'":
                quote = None
            else:
                cur += c
        else:
            if c == '"':
                quote = None
            elif c == esc and i + 1 < n and (powershell or line[i + 1] in '$`"\\\n'):
                cur += line[i + 1]
                i += 1
            else:
                dyn = dyn or expands(i)
                cur += c
        i += 1
    if cur is not None:
        words.append((cur, dyn))
    return words


def flag_value(words: list[tuple[str, bool]], i: int, names: set[str]) -> tuple[tuple[str, bool] | None, int]:
    """If words[i] is one of `names` (as `--name v`, `--name=v`, `-n v`, `-n=v` or `-nv`), return its value and how
    many words it used."""
    word, dyn = words[i]
    for name in names:
        if word == name:
            return (words[i + 1] if i + 1 < len(words) else ("", False)), 2
        if word.startswith(name + "="):
            return (word[len(name) + 1:], dyn), 1
        if len(name) == 2 and word.startswith(name) and not word.startswith("--"):
            return (word[2:], dyn), 1
    return None, 1


def local_path(raw: str, base: Path) -> Path:
    raw = os.path.expanduser(raw)
    if os.name == "nt" and (m := re.match(r"^/([A-Za-z])(/|$)", raw)):   # Git Bash spells C:\ as /c/
        raw = f"{m.group(1)}:/{raw[m.end():]}"
    p = Path(raw)
    return p if p.is_absolute() else base / p


def unquote(s: str) -> str:
    return s[1:-1] if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"" else s


def inputs(command: str, powershell: bool, cwd: Path) -> tuple[list[tuple[str, Path]], list[str]] | None:
    """The files each publishing gh command reads its text from, and the raw spellings of their paths. None when
    the command publishes nothing."""
    joined = command.replace("`\n", " ") if powershell else command.replace("\\\n", " ")   # line continuations
    heredoc = bool(HEREDOC.search(command))
    files: list[tuple[str, Path]] = []
    spellings: list[str] = []
    found = False
    for m in GH.finditer(joined):
        sub = m.group(1).split()[0]
        is_api, is_create = sub == "api", m.group(1).split()[-1] == "create" and sub == "pr"
        base = cwd
        for cd in CD.finditer(joined, 0, m.start()):
            base = local_path(unquote(cd.group(1)), base)
        line_end = joined.find("\n", m.end())
        words = lex(joined[m.end():] if line_end < 0 else joined[m.end():line_end], powershell)
        sources: list[tuple[str, str, bool, bool]] = []      # (flag, value, dynamic, value is a file)
        method = None
        i = 0
        while i < len(words):
            word = words[i][0]
            if is_api:
                value, used = flag_value(words, i, {"-X", "--method"})
                if value is not None:
                    method = value[0].upper()
                    i += used
                    continue
                for names, kind in ((API_RAW, "raw"), (API_TYPED, "typed"), ({"--input"}, "file")):
                    value, used = flag_value(words, i, names)
                    if value is not None:
                        text, dyn = value
                        if kind == "typed" and "=@" in text:
                            sources.append((word, text.split("=@", 1)[1], dyn, True))
                        else:
                            sources.append((word, text, dyn, kind == "file"))
                        break
            else:
                if is_create and word in FILL_FLAGS:
                    raise Blocked("--fill takes the title and body from commit messages, which this hook can't "
                                  "see; pass --title and --body (or --body-file FILE) instead")
                value, used = flag_value(words, i, TEXT_FLAGS)
                if value is not None:
                    sources.append((word, *value, False))
                else:
                    value, used = flag_value(words, i, FILE_FLAGS)
                    if value is not None:
                        sources.append((word, *value, True))
            i += used
        if is_api and (method or ("POST" if sources else "GET")) not in WRITE_METHODS:
            continue                                         # a read: nothing is published
        found = True
        for word, text, dyn, is_file in sources:
            if not is_file and dyn and (cat := CAT.match(text) or SLURP.match(text)):
                text, dyn, is_file = cat.group(1), False, True
            if dyn and not (heredoc and "<<" in text):
                raise Blocked(f"`{word}` gets its text from a shell variable or command substitution, which this "
                              "hook can't read; inline the text or pass --body-file FILE")
            if not is_file:
                continue
            if text == "-":
                if not heredoc:
                    raise Blocked(f"`{word} -` reads the text from stdin, which this hook can't see unless it is a "
                                  "heredoc or here-string in the same command; pass --body-file FILE")
            elif text.startswith("<("):
                raise Blocked(f"`{word}` reads a process substitution, which this hook can't see; pass a file")
            else:
                files.append((text, local_path(text, base)))
                spellings.append(text)
    return (files, spellings) if found else None


def scan(command: str, powershell: bool, cwd: Path, terms: check.Terms) -> list[str]:
    got = inputs(command, powershell, cwd)
    if got is None:
        return []
    files, spellings = got
    # Paths the command only reads from (cd targets, input files) are not published, so they are blanked before
    # the command's own text is checked; the files themselves are checked below.
    visible = command
    for m in CD.finditer(command):
        visible = visible[:m.start(1)] + " " * len(m.group(1)) + visible[m.end(1):]
    for raw in spellings:
        visible = visible.replace(raw, " " * len(raw))
    findings = check.check_text("command", visible, terms)
    for raw, path in files:
        try:
            text = path.read_bytes().decode("utf-8", "replace")
        except OSError as e:
            raise Blocked(f"can't read {raw} ({e.strerror or e}); check the path and run the command again")
        findings += check.check_text(raw, text, terms)
    return findings


def main() -> int:
    raw = sys.stdin.buffer.read()
    try:
        call = json.loads(raw.decode("utf-8"))
        command = call.get("tool_input", {}).get("command", "")
        if isinstance(command, list):
            command = " ".join(command)
        if not isinstance(command, str) or not GH.search(command.replace("\\\n", " ").replace("`\n", " ")):
            return 0
        findings = scan(command, call.get("tool_name") == "PowerShell", Path(call.get("cwd") or "."),
                        check.load_terms())
    except Blocked as e:
        print(f"Leak check blocked this gh command: {e}. See docs/leak-check.md.", file=sys.stderr)
        return 2
    except Exception as e:                      # a broken check must not let a publishing command through
        if b"gh" not in raw:
            return 0
        print(f"Leak check blocked this gh command because the check itself failed ({type(e).__name__}: {e}).",
              file=sys.stderr)
        return 2
    if not findings:
        return 0
    print("Leak check blocked this gh command, because the text it would publish has private material:\n  "
          + "\n  ".join(findings)
          + "\nRemove it and run the command again. A finding gives the line and column, never the word. If a "
            "finding is wrong, reword that line; don't send the text another way. See docs/leak-check.md.",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
