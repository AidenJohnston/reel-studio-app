#!/usr/bin/env python3
"""Agent hook: run the leak check on the text a gh command is about to publish (docs/leak-check.md).

Claude Code (.claude/settings.json) and Codex (.codex/hooks.json) run it before each shell command, with the tool
call as JSON on stdin. Exit 0 lets the command run; exit 2, with the reason on stderr, blocks it. Both agents read
exit 2 as "block".

It acts only on gh commands that publish text: `gh pr create|edit|comment|review`, `gh issue create|edit|comment`,
and `gh api` calls that send fields or a request body, also through a gh alias or a full path to gh. For those it
checks, with check.py's text rules:
  * the whole command, so text inline in a flag, a heredoc or a here-string is covered without parsing the shell;
  * every file the command names as text (--body-file / -F, --input, -F key=@file, $(cat FILE), $(<FILE)).
Text it can't read is not waved through: stdin that isn't a heredoc or here-string, a shell variable or command
substitution, a device such as /dev/stdin, a flag whose value is on another line, and --fill (which copies commit
messages) all block, with what to do instead.

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

# `gh` as a command: bare, a full path ending in gh or gh.exe (quoted or not), in any case, since Windows ignores it.
EXE = r"(?:^|(?<=[\s;&|(`'\"/\\]))gh(?:\.exe)?['\"]?\s+(?:(?:-R|--repo)[\s=]\S+\s+)?"
GH = re.compile(EXE + r"(pr\s+(?:create|edit|comment|review)|issue\s+(?:create|edit|comment)|api)(?![\w-])", re.I)
GH_WORD = re.compile(EXE + r"([A-Za-z][\w-]*)", re.I)
BUILTIN = {"accessibility", "agent-task", "alias", "api", "attestation", "auth", "browse", "cache", "co", "codespace",
           "completion", "config", "copilot", "extension", "gist", "gpg-key", "help", "issue", "label", "licenses",
           "org", "pr", "preview", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key",
           "status", "variable", "version", "workflow"}
CAT_HEREDOC = re.compile(r"^\$\(\s*cat\s+<<-?\s*['\"]?[A-Za-z_]")   # --body "$(cat <<'EOF' ... EOF)"
HERESTRING = re.compile(r"^\s*['\"]@\s*\|\s*$")                     # a PowerShell here-string's last line, piped
DEVICE = re.compile(r"^(?:/dev/|/proc/)")   # /dev/stdin and friends: the hook's own stdin, not the command's
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


def lex(line: str, powershell: bool) -> tuple[list[tuple[str, bool]], int, bool]:
    """Words of one command up to the first unquoted && || ; | or # comment, as (value, dynamic); where that command
    ends in `line`; and whether the command redirects a heredoc (<<) or here-string (<<<) into its stdin, outside
    quotes and comments. `dynamic` means the shell fills part of the word in at run time ($VAR, $(...), and in
    PowerShell (...)), so its text can't be read here."""
    esc = "`" if powershell else "\\"
    words: list[tuple[str, bool]] = []
    cur: str | None = None
    dyn = False
    quote = None
    heredoc = False
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
            elif line.startswith(("&&", "||"), i) or c in ";|" or (c == "#" and cur is None):
                break
            elif c in "'\"":
                quote, cur = c, cur or ""
            elif c == esc and i + 1 < n:
                cur = (cur or "") + line[i + 1]
                i += 1
            else:
                if expands(i) or (powershell and cur is None and c in "($@"):
                    dyn = True
                if not powershell and line.startswith("<<", i):    # unquoted, so a redirect wherever it sits
                    heredoc = True
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
    return words, i, heredoc


def flag_value(words: list[tuple[str, bool]], i: int, names: set[str]) -> tuple[tuple[str, bool] | None, int]:
    """If words[i] is one of `names` (as `--name v`, `--name=v`, `-n v`, `-n=v` or `-nv`), return its value and how
    many words it used."""
    word, dyn = words[i]
    for name in names:
        if word == name:
            if i + 1 == len(words):
                raise Blocked(f"`{name}` has no value on its line, so this hook can't tell what it sends; put the "
                              "value on the same line")
            return words[i + 1], 2
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


def gh_aliases() -> dict[str, str]:
    """gh's own aliases (`gh alias set`), read from the config.yml where gh keeps them."""
    if os.environ.get("GH_CONFIG_DIR"):
        base = Path(os.environ["GH_CONFIG_DIR"])
    elif os.name == "nt" and os.environ.get("APPDATA"):
        base = Path(os.environ["APPDATA"]) / "GitHub CLI"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "gh"
    try:
        lines = (base / "config.yml").read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    aliases: dict[str, str] = {}
    inside = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            inside = line.split("#")[0].strip() == "aliases:"
        elif inside and (m := re.match(r"\s+([\w-]+):\s*(.*)$", line)):
            aliases[m.group(1)] = unquote(m.group(2).strip())
    return aliases


def normalize(command: str, powershell: bool) -> str:
    """The command with line continuations joined and gh aliases expanded, for finding gh calls and their flags."""
    command = command.replace("\r\n", "\n")
    command = command.replace("`\n", " ") if powershell else command.replace("\\\n", " ")
    aliases: dict[str, str] | None = None

    def expand(m: re.Match) -> str:
        nonlocal aliases
        word = m.group(1)
        if word.lower() in BUILTIN:
            return m.group(0)
        if aliases is None:
            aliases = gh_aliases()
        expansion = aliases.get(word)
        if expansion is None:
            return m.group(0)                               # an extension, or not a gh command at all
        if expansion.startswith("!"):                       # a shell alias: gh runs it with sh
            if GH.search(expansion[1:]):
                raise Blocked(f"`gh {word}` is a gh shell alias that publishes text, which this hook can't "
                              "follow; run the gh command it stands for")
            return m.group(0)
        return m.group(0)[:m.start(1) - m.start()] + expansion

    return GH_WORD.sub(expand, command)


def interactive(sub: str, verb: str, words: list[str]) -> None:
    """Block a pr or issue command that would ask for its text in a prompt or an editor. Without a terminal gh
    refuses to ask, but an agent shell that runs commands in a terminal (Codex can) would type the answer later,
    where this hook never sees it."""
    def has(*names: str) -> bool:
        return any(w == n or w.startswith(n + "=") or (len(n) == 2 and w.startswith(n) and not w.startswith("--"))
                   for w in words for n in names)

    if has("-w", "--web"):
        return                                              # the browser shows the text; nothing is sent from here
    if has("-e", "--editor"):
        raise Blocked(f"`gh {sub} {verb} --editor` takes the text in an editor, which this hook can't see; pass "
                      "--body or --body-file FILE")
    title, body = has("-t", "--title"), has("-b", "--body", "-F", "--body-file")
    if verb == "create" and not (title and body):
        raise Blocked(f"`gh {sub} {verb}` without both --title and --body asks for the rest interactively, which "
                      "this hook can't see; pass both (the body can be --body-file FILE)")
    if verb == "comment" and not (body or has("--delete-last")):
        raise Blocked(f"`gh {sub} comment` without --body asks for the text interactively, which this hook can't "
                      "see; pass --body or --body-file FILE")
    if verb == "review" and not has("-a", "--approve", "-r", "--request-changes", "-c", "--comment"):
        raise Blocked("`gh pr review` without --approve, --request-changes or --comment asks for the review "
                      "interactively, which this hook can't see; pass one of them, with --body or --body-file")


def inputs(command: str, powershell: bool, cwd: Path) -> tuple[list[tuple[str, Path]], list[str]] | None:
    """The files each publishing gh command reads its text from, and the raw spellings of their paths. None when
    the command publishes nothing."""
    joined = normalize(command, powershell)
    files: list[tuple[str, Path]] = []
    spellings: list[str] = []
    found = False
    for m in GH.finditer(joined):
        sub, verb = m.group(1).lower().split()[0], m.group(1).lower().split()[-1]
        is_api, is_create = sub == "api", sub == "pr" and verb == "create"
        base = cwd
        for cd in CD.finditer(joined, 0, m.start()):
            base = local_path(unquote(cd.group(1)), base)
        line_start = joined.rfind("\n", 0, m.start()) + 1
        line_end = joined.find("\n", m.end())
        line_end = len(joined) if line_end < 0 else line_end
        words, _, redirected = lex(joined[m.end():line_end], powershell)
        # Text on stdin is visible only when it is written in the command for this gh call: a heredoc or here-string
        # redirected into it, or a PowerShell here-string whose closing line pipes straight into it.
        heredoc = redirected or bool(powershell and HERESTRING.search(joined[line_start:m.start()]))
        if not is_api:
            interactive(sub, verb, [w for w, _ in words])
        sources: list[tuple[str, str, bool, bool]] = []      # (flag, value, dynamic, value is a file)
        method = None
        i = 0
        while i < len(words):
            word = words[i][0]
            if is_api:
                value, used = flag_value(words, i, {"-X", "--method"})
                if value is not None:
                    method = "POST" if value[1] else value[0].upper()     # a method set at run time may write
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
            if dyn and not CAT_HEREDOC.match(text):        # $(cat <<EOF ...): the body is in the command
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
                path = local_path(text, base)
                if DEVICE.match(text.replace("\\", "/")) or (path.exists() and not path.is_file()):
                    raise Blocked(f"`{word}` reads {text}, which is not a regular file, so this hook can't see the "
                                  "text; pass --body-file FILE")
                files.append((text, path))
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
        powershell = call.get("tool_name") == "PowerShell"
        if not isinstance(command, str) or not GH.search(normalize(command, powershell)):
            return 0
        findings = scan(command, powershell, Path(call.get("cwd") or "."), check.load_terms())
    except Blocked as e:
        print(f"Leak check blocked this gh command: {e}. See docs/leak-check.md.", file=sys.stderr)
        return 2
    except Exception as e:                      # a broken check must not let a publishing command through
        if b"gh" not in raw.lower():
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
