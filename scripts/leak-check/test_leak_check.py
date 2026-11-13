"""Tests for the leak check's local layers (docs/leak-check.md): text mode, the git hooks and the agent hook.

Run: python scripts/leak-check/test_leak_check.py

Each test copies the real scripts into a temp folder next to a patterns.json of made-up terms, fingerprinted here
with the real salt, so no private term is needed and the shipped scripts run unchanged.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import check  # noqa: E402

PLANTED = "zorblax"                       # an "ex" term: the whole word
PAIR = ("quimby", "fennick")              # a "pair" term: two words on one line
# Split so this file passes the repo's own e-mail and local-path rules.
SECRET_MAIL = "someone" + "@personal-mail.net"
NOREPLY_MAIL = "1+a" + "@users.noreply.github.com"
LOCAL = "c:" + "\\dev\\project"
CLEAN = "Adds a caption preset.\nTested with example@example.com on Windows 11.\n"


def planted_patterns() -> dict:
    a, b = PAIR
    return {"salt": check.SALT, "terms": [
        {"kind": "ex", "len": len(PLANTED), "fp": check.fp("ex", PLANTED)},
        {"kind": "pair", "len": [len(a), len(b)], "fp": check.fp("pair", f"{a} {b}")},
    ]}


def find_git_bash() -> str | None:
    """bash for running shell-form hook commands. On Windows, Git's own bash, never WSL's bash.exe."""
    if os.name != "nt":
        return shutil.which("bash")
    exec_path = subprocess.run(["git", "--exec-path"], capture_output=True, text=True).stdout.strip()
    bash = Path(exec_path).parents[2] / "bin" / "bash.exe"          # <git>/mingw64/libexec/git-core
    return str(bash) if bash.is_file() else None


def remove_tree(path: Path) -> None:
    """Delete a temp repo. git makes its object files read-only, which Windows refuses to delete as they are."""
    def writable_then_retry(func, p, _exc):
        os.chmod(p, 0o700)
        func(p)
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=writable_then_retry)
    else:
        shutil.rmtree(path, onerror=writable_then_retry)


class Kit(unittest.TestCase):
    """A temp git repo holding copies of the shipped hooks and scripts, with planted patterns."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="leakcheck-"))
        self.addCleanup(remove_tree, self.root)
        kit = self.root / "scripts" / "leak-check"
        kit.mkdir(parents=True)
        for name in ("check.py", "agent_hook.py", "with-python.sh"):
            shutil.copy2(HERE / name, kit / name)
        (kit / "patterns.json").write_text(json.dumps(planted_patterns()), encoding="utf-8")
        shutil.copytree(REPO / ".githooks", self.root / ".githooks")
        self.git("init", "-q")
        self.git("config", "core.hooksPath", ".githooks")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")

    def git(self, *args, check_ok=True, **kw) -> subprocess.CompletedProcess:
        r = subprocess.run(["git", *args], cwd=self.root, capture_output=True, text=True, **kw)
        if check_ok:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def write(self, rel: str, text: str) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text.encode())

    def commit(self, *args) -> subprocess.CompletedProcess:
        return self.git("commit", "-q", *args, check_ok=False)

    def head(self) -> str:
        return self.git("rev-parse", "-q", "--verify", "HEAD", check_ok=False).stdout.strip()


class TextMode(Kit):
    def run_text(self, *args, stdin=""):
        return subprocess.run([sys.executable, "scripts/leak-check/check.py", *args], cwd=self.root,
                              input=stdin.encode(), capture_output=True)

    def test_flags_each_rule_at_its_line_and_column_without_echoing_it(self):
        # fails if text mode misses a term, a word pair, an e-mail or a local path, points at the wrong place,
        # or prints what it found
        self.write("body.md", f"Intro\nSee {SECRET_MAIL} or {LOCAL}\n")
        r = self.run_text("--text", "-", "body.md", stdin=f"Title\nfix {PLANTED} bug\nthe {PAIR[0]} {PAIR[1]} case\n")
        out = (r.stdout + r.stderr).decode()
        self.assertEqual(r.returncode, 1, out)
        for finding in ("stdin:2:5: [private term]", "stdin:3:5: [private term]",
                        "body.md:2:5: [email]", f"body.md:2:{9 + len(SECRET_MAIL)}: [local path]"):
            self.assertIn(finding, out)
        for leaked in (PLANTED, PAIR[0], SECRET_MAIL, LOCAL):
            self.assertNotIn(leaked, out)

    def test_passes_clean_text(self):
        # fails if ordinary text, an allowed example address or the company name is flagged
        r = self.run_text("--text", "-", stdin=CLEAN + "Owned by " + check.ALLOW[1] + ".\n")
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr).decode())


class GitHooks(Kit):
    def test_pre_commit_blocks_a_planted_term_however_it_is_staged(self):
        # fails if the hook isn't wired, lets a finding through, or misses `commit -a`'s temporary index
        self.write("README.md", CLEAN)
        self.git("add", "README.md")
        self.assertEqual(self.commit("-m", "docs: start").returncode, 0)
        start = self.head()

        self.write("notes.md", f"ship the {PLANTED} build\n")
        self.git("add", "notes.md")
        r = self.commit("-m", "docs: notes")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("notes.md:1: [private term]", r.stderr)   # git sends hook output to stderr
        self.assertIn("commit blocked", r.stderr)
        self.git("rm", "-q", "--cached", "notes.md")

        self.write("README.md", CLEAN + PLANTED + "\n")
        self.assertNotEqual(self.commit("-am", "docs: more").returncode, 0)
        self.assertEqual(self.head(), start)

    def test_pre_commit_checks_the_staged_content_not_the_working_tree(self):
        # fails if --staged reads files from disk instead of the index
        self.write("a.md", CLEAN)
        self.git("add", "a.md")
        self.write("a.md", CLEAN + PLANTED + "\n")          # dirty, but not staged
        self.assertEqual(self.commit("-m", "docs: a").returncode, 0, "clean index was refused")

        self.git("add", "a.md")
        self.write("a.md", CLEAN)                            # staged leak, clean working tree
        self.assertNotEqual(self.commit("-m", "docs: b").returncode, 0, "staged leak got through")

    def test_pre_commit_allows_the_shared_claude_settings_only(self):
        # fails if .claude/settings.json is refused, or the exception lets local agent files through
        self.write(".claude/settings.json", "{}\n")
        self.git("add", ".claude/settings.json")
        self.assertEqual(self.commit("-m", "chore: agent hook").returncode, 0)
        self.write(".claude/settings.local.json", "{}\n")
        self.git("add", "-f", ".claude/settings.local.json")
        r = self.commit("-m", "chore: local")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(".claude/settings.local.json: [path]", r.stderr)

    def test_commit_msg_blocks_a_planted_term_and_allows_noreply_trailers(self):
        # fails if commit messages go unchecked, or the standard co-author trailers are refused
        self.write("a.md", CLEAN)
        self.git("add", "a.md")
        r = self.commit("-m", f"fix: the {PLANTED} crash")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("[private term]", r.stderr)
        self.assertNotIn(PLANTED, r.stderr)

        self.write("msg.txt", f"fix: crash\n\nCo-authored-by: Someone <{SECRET_MAIL}>\n")
        self.assertNotEqual(self.commit("-F", str(self.root / "msg.txt")).returncode, 0, "personal trailer address")
        self.write("msg.txt", f"fix: crash\n\nCo-authored-by: A <{NOREPLY_MAIL}>\n"
                              "Co-Authored-By: B <noreply@example.org>\n")
        r = self.commit("-F", str(self.root / "msg.txt"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    @unittest.skipUnless(os.name == "nt", "the Store shortcut exists only on Windows")
    def test_hook_skips_a_python_that_is_not_python_and_blocks_without_one(self):
        # fails if the hook runs the Windows Store's python3 shortcut, or commits when no Python 3 is found
        fake = self.root / "fakebin"
        fake.mkdir()
        (fake / "python3").write_text("#!/bin/sh\necho 'Python was not found' >&2\nexit 49\n")
        os.chmod(fake / "python3", 0o755)
        git_root = Path(subprocess.run(["git", "--exec-path"], capture_output=True, text=True).stdout.strip()).parents[2]
        env = {**os.environ, "PATH": os.pathsep.join([str(fake), str(git_root / "cmd"), str(git_root / "usr" / "bin")])}
        self.write("a.md", CLEAN)
        self.git("add", "a.md")
        r = self.git("commit", "-q", "-m", "docs: a", check_ok=False, env=env)
        self.assertNotEqual(r.returncode, 0, "committed without a real Python")
        self.assertIn("needs Python 3", r.stderr)


class AgentHook(Kit):
    def call(self, command: str, tool: str = "Bash") -> subprocess.CompletedProcess:
        payload = {"tool_name": tool, "tool_input": {"command": command}, "cwd": str(self.root)}
        return subprocess.run([sys.executable, "scripts/leak-check/agent_hook.py"], cwd=self.root,
                              input=json.dumps(payload).encode(), capture_output=True,
                              env={**os.environ, "GH_CONFIG_DIR": str(self.root / "ghconfig")})

    def assertBlocked(self, r, why: str = "private material"):
        err = r.stderr.decode()
        self.assertEqual(r.returncode, 2, err)
        self.assertIn(why, err)
        self.assertNotIn(PLANTED, err)

    def assertAllowed(self, r):
        self.assertEqual(r.returncode, 0, r.stderr.decode())

    def test_blocks_inline_text_in_bash_and_powershell(self):
        # fails if a planted term in --body, a PowerShell comment or a heredoc body gets through
        self.assertBlocked(self.call(f'gh pr create --title "Fix" --body "Fixes the {PLANTED} crash"'))
        self.assertBlocked(self.call(f"gh pr comment 5 --body 'see {PLANTED}'", tool="PowerShell"))
        self.assertBlocked(self.call(f"gh pr create --title Fix --body \"$(cat <<'EOF'\nBody\n{PLANTED}\nEOF\n)\""))

    def test_blocks_gh_however_it_is_named(self):
        # fails if a full path to gh, Windows' any-case GH, a repo flag or a gh alias hides a publishing command
        self.write("ghconfig/config.yml", "git_protocol: https\naliases:\n    submit: pr create\n"
                                          "    say: '!gh pr comment \"$1\" --body hi'\n")
        for command in (f'"C:\\Program Files\\GitHub CLI\\gh.exe" pr create -t x --body {PLANTED}',
                        f"GH pr create -t x --body {PLANTED}",
                        f"gh -R o/r pr create -t x --body {PLANTED}",
                        f"gh submit -t x --body {PLANTED}"):
            self.assertBlocked(self.call(command))
        self.assertBlocked(self.call("gh say 5"), why="alias")

    def test_blocks_a_body_file_with_a_planted_term(self):
        # fails if --body-file / -F contents go unchecked, or a path after `cd` resolves against the wrong folder
        self.write("sub/body.md", f"## Why\nThe {PLANTED} build.\n")
        self.assertBlocked(self.call("cd sub && gh pr create --title Fix --body-file body.md"))
        self.assertBlocked(self.call("gh pr edit 7 \\\n  -F sub/body.md"))
        self.write("sub/body.md", CLEAN)
        self.assertAllowed(self.call("cd sub && gh pr create --title Fix --body-file body.md"))

    def test_blocks_gh_api_writes(self):
        # fails if `gh api` fields or --input bodies that post a comment go unchecked
        self.write("payload.json", json.dumps({"body": PLANTED}))
        self.assertBlocked(self.call(f"gh api repos/o/r/issues/1/comments -f body='{PLANTED}'"))
        self.assertBlocked(self.call("gh api -X PATCH repos/o/r/pulls/1 --input payload.json"))
        self.assertBlocked(self.call(f'gh api repos/o/r/issues/1/comments -X "$METHOD" -f body={PLANTED}'))

    def test_blocks_text_it_cannot_see(self):
        # fails if text the hook can't read is waved through: a variable, a piped or device stdin, --fill, a flag
        # whose value is on the next line, a pipe hiding behind another command's heredoc, or a command that would
        # ask for its text in a prompt
        for command in ('gh pr create --title Fix --body "$BODY"',
                        "cat notes.md | gh pr create --title Fix --body-file -",
                        "gh pr create --title Fix --body-file /dev/stdin",
                        'gh pr create --title Fix --body "$(cat /dev/stdin)"',
                        "gh pr create --fill",
                        "gh pr create -t x --body-file - <<EOF\nclean\nEOF\ncat notes.md | gh pr create -t x --body-file -",
                        "cat notes.md | gh pr create -t x -F -; gh pr create -t x -F - <<EOF\nclean\nEOF",
                        "gh pr create -t 'title <<EOF' -F -", "gh pr create -t x -F - # <<EOF",
                        "gh pr create --title clean", "gh issue comment 5", "gh pr review 5"):
            self.assertBlocked(self.call(command), why="can't")
        for command in ("gh pr comment 3 --body $body", "gh pr create -t x --body `\r\n$body"):
            self.assertBlocked(self.call(command, tool="PowerShell"), why="can't")

    def test_allows_clean_text_and_commands_that_publish_nothing(self):
        # fails if the hook blocks clean PR text, or blocks commands other than publishing gh calls
        self.assertAllowed(self.call("gh pr create --title 'feat: presets' --body \"$(cat <<'EOF'\nAdds presets.\nEOF\n)\""))
        self.assertAllowed(self.call(f"grep -rn {PLANTED} docs && gh pr view 5 && gh api repos/o/r/pulls/5"))
        self.assertAllowed(self.call("gh pr review 5 --approve && gh pr edit 5 --add-label docs"))


class Fallbacks(Kit):
    def test_agent_hook_without_python_blocks_only_gh(self):
        # fails if, with no Python, a gh command runs unchecked, or a command that only mentions gh in its folder
        # or description is blocked
        if os.name == "nt":
            exec_path = subprocess.run(["git", "--exec-path"], capture_output=True, text=True).stdout.strip()
            usr_bin = Path(exec_path).parents[2] / "usr" / "bin"     # Git's own tools, with no Python among them
            sh, path = str(usr_bin / "sh.exe"), str(usr_bin)
        else:
            bin_dir = self.root / "bin"
            bin_dir.mkdir()
            for tool in ("cat", "sed"):
                os.symlink(shutil.which(tool), bin_dir / tool)
            sh, path = "/bin/sh", str(bin_dir)

        def run(command: str, path: str, description: str = "push to gh") -> int:
            payload = {"tool_name": "Bash", "tool_input": {"command": command, "description": description},
                       "cwd": str(self.root / "gh")}
            return subprocess.run([sh, "scripts/leak-check/with-python.sh", "--agent-hook",
                                   "scripts/leak-check/agent_hook.py"], cwd=self.root,
                                  input=json.dumps(payload).encode(), capture_output=True,
                                  env={**os.environ, "PATH": path}).returncode

        self.assertEqual(run("gh -R o/r pr create -t x -b y", path), 2)
        self.assertEqual(run("git push fork HEAD", path), 0)
        # With not even cat or sed, it still reads the call and blocks gh.
        nothing = self.root / "empty-bin"
        nothing.mkdir()
        self.assertEqual(run("gh -R o/r pr create -t x -b y", str(nothing), "push"), 2)

    def test_npm_install_step_sets_up_hooks_without_overriding_or_failing(self):
        # fails if the prepare script breaks `npm install` outside a git checkout, doesn't set core.hooksPath in a
        # fresh clone, or overwrites a hooksPath the contributor chose
        node = shutil.which("node")
        if not node:
            self.skipTest("no node")
        script = str(HERE / "install-hooks.mjs")
        plain = self.root / "not-a-repo"
        plain.mkdir()
        outside = {**os.environ, "GIT_CEILING_DIRECTORIES": str(self.root)}
        self.assertEqual(subprocess.run([node, script], cwd=plain, env=outside, capture_output=True).returncode, 0)

        self.git("config", "--unset", "core.hooksPath")
        self.assertEqual(subprocess.run([node, script], cwd=self.root, capture_output=True).returncode, 0)
        self.assertEqual(self.git("config", "--local", "core.hooksPath").stdout.strip(), ".githooks")

        self.git("config", "core.hooksPath", "custom-hooks")
        r = subprocess.run([node, script], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("not active", r.stderr)
        self.assertEqual(self.git("config", "--local", "core.hooksPath").stdout.strip(), "custom-hooks")


class HookConfigs(Kit):
    """The command strings in .claude/settings.json and .codex/hooks.json, run the way each agent runs them."""

    def configured(self, rel: str, key: str = "command") -> str:
        data = json.loads((REPO / rel).read_text(encoding="utf-8"))
        return data["hooks"]["PreToolUse"][0]["hooks"][0][key]

    def run_both(self, run) -> None:
        bad = {"tool_name": "Bash", "tool_input": {"command": f"gh pr create -t x -b {PLANTED}"}, "cwd": str(self.root)}
        good = {"tool_name": "Bash", "tool_input": {"command": "gh pr create -t x -b fine"}, "cwd": str(self.root)}
        r = run(json.dumps(bad).encode())
        self.assertEqual(r.returncode, 2, r.stderr.decode(errors="replace"))
        r = run(json.dumps(good).encode())
        self.assertEqual(r.returncode, 0, r.stderr.decode(errors="replace"))

    def test_claude_code_command_runs_the_hook(self):
        # fails if the Claude Code hook command can't find its script or a Python 3 on this system
        bash = find_git_bash()
        if not bash:
            self.skipTest("no bash to run a shell-form hook")
        command = self.configured(".claude/settings.json").replace("${CLAUDE_PROJECT_DIR}", str(self.root))
        self.run_both(lambda stdin: subprocess.run([bash, "-c", command], cwd=self.root, input=stdin,
                                                   capture_output=True))

    def test_codex_command_runs_the_hook(self):
        # fails if the Codex hook command can't find the repo root, its script or a Python 3 on this system
        if os.name == "nt":
            # Codex runs commandWindows as `cmd.exe /C "<command>"`, passing the quotes through as written.
            line = f'cmd.exe /C "{self.configured(".codex/hooks.json", "commandWindows")}"'
            self.run_both(lambda stdin: subprocess.run(line, cwd=self.root, input=stdin, capture_output=True))
        else:
            command = self.configured(".codex/hooks.json")
            self.run_both(lambda stdin: subprocess.run(["/bin/sh", "-c", command], cwd=self.root, input=stdin,
                                                       capture_output=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
