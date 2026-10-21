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
```

CI: `.github/workflows/ci.yml` runs Node on Ubuntu, macOS, and Windows, Engine / Python 3.11, and Animation rendering.

Tests that read your own videos or music are marked `real` and skip themselves when the files are absent;
put them under a `testdata/` folder (it is git-ignored) or point `REELENGINE_TEST_TAKES` and
`REELENGINE_TEST_MUSIC` at them.

## Pull requests

* Keep a change focused, and add a test for a bug you fix.
* `project.json` changes are additive only (optional fields). Note them in `docs/schema-changes.md`.
* Never commit your own videos, songs or other media, and never commit API keys or tokens.
* New dependencies need a license that fits the MIT app and, if they ship in the installer, an entry in
  `THIRD_PARTY.md`.

By contributing you agree your work is released under the [MIT License](LICENSE).
