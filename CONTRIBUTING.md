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

See "Build from source" in the [README](README.md). The short version:

```
npm install && npm run build -w ai
cd engine && python -m venv .venv && .venv/bin/pip install -e ".[dev]"    # Windows: .venv\Scripts\pip
```

## Checks to run

```
npm test                        # app + ai
npm run typecheck
cd engine && python -m pytest tests
python scripts/leak-check/check.py   # also runs on every pull request
```

CI runs on Linux (Node checks, engine and animation tests). Run the tests on macOS and Windows yourself
when your change touches platform-specific code.
Electron e2e tests run locally with `npm run e2e`; CI does not run them.

The leak check refuses private names, personal paths, e-mail addresses, media files and anything over 5 MB.
Its list of private terms is stored only as fingerprints, so a finding names the line, not the word. If it
flags something that is not private, say so in the pull request.

Tests that read your own videos or music are marked `real` and skip themselves when the files are absent;
put them under a `testdata/` folder (it is git-ignored) or point `REELENGINE_TEST_TAKES` and
`REELENGINE_TEST_MUSIC` at them.

## Pull requests

PRs are squash-merged. The PR title becomes the single commit on main, so use Conventional Commits: `type(scope): subject`.

* Keep a change focused, add a test for a bug you fix, and use the PR template to explain the change and verification.
* Put a `Changelog:` line in the PR description. At the next release, create `CHANGELOG.md` from the PRs' `Changelog:` lines.
  Feature PRs must not edit `CHANGELOG.md`, so they do not conflict.
* `project.json` changes are additive only (optional fields). Note them in `docs/schema-changes.md`.
* Never commit your own videos, songs or other media, and never commit API keys or tokens.
* New dependencies need a license that fits the MIT app and, if they ship in the installer, an entry in
  `THIRD_PARTY.md`.

By contributing you agree your work is released under the [MIT License](LICENSE).
