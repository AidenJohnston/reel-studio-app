# Contributing to Reel Studio

Thanks for helping. Bug reports, fixes and small improvements are welcome.

## Before you start

* Open an issue first for anything bigger than a small fix, so we agree on the direction.
* The product goal is "a non-technical person can make a reel with no manual editing". Every screen should
  have one obvious next action, plain words (no "transcode", "LUFS", "API"), and errors that say what to do.
  UI copy has no em dashes.
* Read [docs/architecture.md](docs/architecture.md). The one rule that matters most: **the AI edits
  `project.json`, the engine renders it.** The engine never calls an LLM; the AI package never touches media.

## Set up

See "Build from source" in the [README](README.md).
Install [uv](https://docs.astral.sh/uv/getting-started/installation/) first.
The engine setup commands work in PowerShell and on macOS without activating the environment.

```
npm ci
npm run build -w ai
cd engine
uv venv --python 3.11
uv pip install --python .venv -c requirements.txt -e ".[dev]"
cd ..
```

## Checks to run

```
npm test                        # app + ai
npm run typecheck
cd engine && uv run --no-project --python .venv python -m pytest tests
```

CI runs Node checks on Ubuntu, macOS, and Windows, plus engine and animation tests on Ubuntu.
Electron e2e tests run locally with `npm run e2e`; CI does not run them.

Tests that read your own videos or music are marked `real` and skip themselves when the files are absent;
put them under a `testdata/` folder (it is git-ignored) or point `REELENGINE_TEST_TAKES` and
`REELENGINE_TEST_MUSIC` at them.

## Pull requests

PRs are squash-merged. The PR title becomes the single commit on main, so use Conventional Commits: `type(scope): subject`.

* Keep a change focused, add a test for a bug you fix, and use the PR template to explain the change and verification.
* Put a `Changelog:` line in the PR description. At release, move those entries into `CHANGELOG.md`.
  Feature PRs must not edit `CHANGELOG.md`, so they do not conflict.
* `project.json` changes are additive only (optional fields). Note them in `docs/schema-changes.md`.
* Never commit your own videos, songs or other media, and never commit API keys or tokens.
* New dependencies need a license that fits the MIT app and, if they ship in the installer, an entry in
  `THIRD_PARTY.md`.

## Agent skills

Repository skills live in `.claude/skills/` as regular files for Windows compatibility.
Use `test-audit` for tests, `deslop` for code review, `unslop` for prose, and `pr-writing` for PR descriptions.

By contributing you agree your work is released under the [MIT License](LICENSE).
