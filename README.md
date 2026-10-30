# Reel Studio

A desktop app for **macOS (Apple silicon)** and **Windows 10/11 (64-bit)** that turns a raw talking-head take into a
finished 9:16 reel: it picks the best take of every line, cuts the pauses, adds captions, music, b-roll and a cover,
and takes edit notes in plain English.

This is the developer README: how the code is laid out and how to set up, build and test it. Customers get the
installers from [getreelstudio.com](https://getreelstudio.com/) after purchase; the app checks there for updates.

## How it fits together

The one rule that matters most: **the AI edits `project.json`, the engine renders it.** The AI never writes code or
ffmpeg commands; it reads the transcript and the project and changes the project file through a fixed list of
actions. The engine is deterministic: the same project in always gives the same video out. The engine never calls
an LLM, and the AI package never touches media. Details: [docs/architecture.md](docs/architecture.md).

The AI is optional. Without it the app still transcribes, cuts pauses and repeated starts, adds captions, mixes in
the chosen song and makes a cover. With it, the user connects their own Claude Code or Codex app (the vendor's own
sign-in; Reel Studio never sees it) or pastes an Anthropic API key (stored with the OS's secure storage).

Ground rules the code has to keep true: no account, no analytics, no crash reporting. Videos and songs never leave
the computer. A connected AI receives only the transcript, the project file, a few preview stills, the user's notes
and style rules, and one small still per attached picture. Every other network request happens only when the user
uses the feature (speech model download, image and logo search, page screenshots, pasted links), except the update
check: at most once a day, a GET of `dl.getreelstudio.com/latest.json` with a generic `User-Agent` and no ID. It can
be turned off in Settings.

## Project layout

| Path | What |
|---|---|
| `app/` | Electron + React + Vite desktop app |
| `ai/` | Providers, prompts, editor tools and the agent loop (TypeScript) |
| `engine/` | The media engine: transcribe, cut, captions, b-roll, music, render (Python) |
| `templates/` | HTML animation templates and fonts |
| `packaging/` | Installer config, runtime fetch scripts, signing, licence texts |
| `scripts/leak-check/` | The check every pull request must pass (no private names, paths, media or keys) |
| `docs/` | Architecture, schema changes, signing, install guides, design notes |

## Set up

You need Node.js 22 or newer and Python 3.11. For development on a machine without the bundled runtime, put
`ffmpeg` and `ffprobe` (7.1 recommended) on your PATH.

From a clone of the repository:

```
npm install
npm run build -w ai          # the app loads the built AI package
```

Set up the engine (the app uses `engine/.venv` automatically when it exists):

```
cd engine
python -m venv .venv
# Windows:  .venv\Scripts\pip install -e ".[dev]"      macOS:  .venv/bin/pip install -e ".[dev]"
cd ..
```

## Run and test

```
npm run dev                  # the app, with hot reload
npm test                     # app + ai unit tests
npm run typecheck
cd engine && python -m pytest tests          # engine tests (the compositing suite takes a few minutes)
npm run e2e                  # Electron end-to-end tests (slower; needs the engine venv)
python scripts/leak-check/check.py           # also runs on every pull request
```

Tests that read your own videos or music are marked `real` and skip themselves when the files are absent; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Build the installers

The installers bundle Python, ffmpeg and fonts (about 250 MB of downloads the first time):

```
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1

# macOS (Apple silicon)
packaging/build-mac.sh
```

Packaging details and signing: [packaging/README.md](packaging/README.md) and
[docs/signing-mac.md](docs/signing-mac.md).

## Licence and third-party notices

Reel Studio is proprietary software, copyright Curate Technologies LLC. See [LICENSE](LICENSE). Versions up to and
including 0.1.3 were released under the MIT License; that text is kept in [LICENSE](LICENSE).

The installers also contain other programs, each under its own licence: FFmpeg and FFprobe (GPL v3, run as separate
programs), Python and its libraries, Electron, npm packages, fonts (SIL OFL and Apache 2.0), and the YuNet face
detector (MIT). Full list and licence texts: [THIRD_PARTY.md](THIRD_PARTY.md) and
[engine/THIRD_PARTY.md](engine/THIRD_PARTY.md). They ship in the installer's `licenses` folder.

## Credits

The editing method follows the Minimum Viable Editing Strategy as described by **Mino Lee**, credited here with
Mino's permission.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
