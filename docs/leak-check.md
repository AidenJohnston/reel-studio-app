# Leak check

This repo is public. The leak check refuses private names, personal paths, e-mail addresses, media files, big
files and never-commit paths before they reach it. The private terms are stored only as salted fingerprints in
`scripts/leak-check/patterns.json`, so a finding names the place, never the word. One checker,
`scripts/leak-check/check.py`, runs at every layer below, so a rule changes in one place.

## Where it runs

| Layer | When | What it checks | Set up by |
|---|---|---|---|
| `pre-commit` hook | `git commit` | the staged content of the files the commit adds or changes (`check.py --staged`) | `npm install` |
| `commit-msg` hook | `git commit` | the commit message (`check.py --commit-message`) | `npm install` |
| Agent hook | before Claude Code or Codex runs a shell command | the text a `gh` command would publish (`agent_hook.py`) | opening the repo in the agent |
| CI, the required **Leak check** | every pull request, and pushes to `main` | every file in the pull request, plus its title and body | nothing |

The first three stop a leak before it is public. CI is the backstop. For a pull request's title and body it can
only report, because the text is already posted by the time it runs, so the local layers matter most for PR text.

## The git hooks

`npm install` runs `scripts/leak-check/install-hooks.mjs`, which sets one value in this clone's `.git/config`:

```
git config core.hooksPath .githooks
```

It prints a line when it does. If the clone already has its own `core.hooksPath`, it leaves it alone and tells
you the leak-check hooks are not active. A global `core.hooksPath` stops running in this repo once the local one
is set; the install line says so.

- Check: `git config core.hooksPath` prints `.githooks`.
- Undo: `git config --unset core.hooksPath`.
- Set up without npm: run the `git config` line above.

The hooks need Python 3.8 or later on `PATH` as `python3`, `python` or `py`. On Windows, the Microsoft Store's
`python3` shortcut is skipped, because it opens the Store instead of running. Without Python the commit stops and
says so.

### When a commit is blocked

The hook lists each finding as `path:line: [kind]`. Remove or reword the flagged line, stage the fix and commit
again. A `[private term]` finding names the line, not the word; if a finding looks wrong, reword the line and say
so in the pull request.

`git commit --no-verify` skips both hooks. Use it only for a real hotfix, and say in the pull request that you
did. CI still checks the files.

## The agent hook

`.claude/settings.json` (Claude Code) and `.codex/hooks.json` (Codex) run `scripts/leak-check/agent_hook.py`
before each shell command. It does nothing unless the command publishes text with `gh`:

- `gh pr create|edit|comment|review` and `gh issue create|edit|comment`
- `gh api` calls that send fields or a request body (`-f`, `-F`, `--field`, `--raw-field`, `--input`, or a
  `POST`, `PUT`, `PATCH` or `DELETE` method, or a method set at run time)

It finds them however gh is named: a full path to `gh.exe`, any letter case, `-R owner/repo` before the
subcommand, or a gh alias from `gh alias set`, which it reads from gh's `config.yml`.

For those, it checks the whole command (so text in a flag, a heredoc or a here-string is covered) and every file
the command reads text from: `--body-file` / `-F`, `--input`, `-F key=@file`, `$(cat file)` and `$(<file)`.
Relative paths resolve from the agent's folder, or from a `cd` earlier in the same command.

It blocks, with the reason, when it finds private material, and also when it can't see the text: a shell
variable or command substitution (`--body "$BODY"`), stdin that isn't a heredoc or here-string feeding that same
`gh` call, a device such as `/dev/stdin`, a flag whose value is on the next line, a gh shell alias that publishes,
`gh pr create --fill`, or a command that would ask for its text in a prompt or an editor (`gh pr create` without
both `--title` and `--body`, `gh pr comment` without `--body`, `gh pr review` without `--approve`,
`--request-changes` or `--comment`). The fix is to put the text in a file and pass `--body-file FILE`.

Without Python 3, the hook can't check anything, so it blocks every command whose text has `gh` as a word and lets
the rest run. Installing Python fixes it.

Claude Code runs the hook through `sh`, which on Windows comes with Git for Windows. If the hook can't start at
all (no `sh`), `"onFailure": "continue"` lets the command run rather than blocking every shell command; CI still
checks the pull request.

As of November 2026, Codex supports the same kind of `PreToolUse` hook (its hooks documentation, and the
`codex-rs/hooks` source on `main`). Two differences:

- Codex loads project hooks only after you trust the project and review the hook with `/hooks`. Until then it
  does not run.
- On Windows, Codex runs hooks with `cmd.exe`, so `commandWindows` calls `py -3` (the Python launcher) directly.
  Without `py` the hook can't start, and Codex's documentation doesn't say whether that blocks the command.

Other agents get no local check for PR text; CI is their only layer.

## What it does not catch

- A word pair split across two lines. Markdown renders `First` and `Last` on consecutive lines as one line, but
  the checker looks for pairs within a line, in files as well as in text.
- Text the agent hook can't read is blocked, not checked, so a `gh` command that builds its body at run time
  must be rewritten to use a file.
- The author and committer e-mail on each commit. Set `git config user.email` to your GitHub no-reply address
  before your first commit.
- Commits made with `--no-verify`, in a clone without the hooks, or by tools that write commits without running
  git's hooks. CI checks their files, not their messages.
