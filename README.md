# Reel Studio

Turn a raw talking-head video into a finished, postable 9:16 Reel. Drop in your takes, retakes and
fumbles included. Reel Studio listens, picks your best take of every line, cuts the pauses, adds captions,
puts your own music under your voice, adds b-roll and a cover, and writes the post caption. Then you type
notes in plain English ("music too loud at the start") and get a new version.

It is a free, open source desktop app for **macOS (Apple silicon)** and **Windows 10/11 (64-bit)**.
No accounts, no telemetry, no subscription.

<p align="center">
  <img src="docs/images/reel.png" alt="The Reel screen: a finished reel in a phone preview, a list of what Reel Studio did, and a box for notes" width="760">
</p>

*The Reel screen. A raw take became a finished reel with subtitles, music, pictures, text cards and a cover. Type a
note ("music too loud at the start") and a new version appears next to the old one.*

<p align="center">
  <img src="docs/images/home.png" alt="Your videos: the finished reel as a card with its cover" width="560">
</p>

*Your videos. Drop in a raw video and it shows up here with its cover when it is ready.*

### Change anything yourself

"Edit it myself" opens a drawer with one tab for each part of the reel. Change what you like, then make a new
version, or leave it as it is.

| | |
|---|---|
| <img src="docs/images/drawer-cut.png" alt="The Cut tab: your words, with the cut ones crossed out" width="400"><br>*Cut: your words, the cut ones crossed out. Click to bring one back.* | <img src="docs/images/drawer-subtitles.png" alt="The Subtitles tab: size, position and style" width="400"><br>*Subtitles: size, position and style, previewed on the phone.* |
| <img src="docs/images/drawer-music.png" alt="The Music tab: pick a song and how loud it is" width="400"><br>*Music: pick a song from your Library and how loud it sits.* | <img src="docs/images/drawer-pictures.png" alt="The Pictures tab: each picture or text card and the words it pops up on" width="400"><br>*Pictures: every picture and text card, and the words it appears on.* |
| <img src="docs/images/drawer-cover.png" alt="The Cover tab: pick the moment and the words on the cover" width="400"><br>*Cover: pick the moment and the words on it.* | <img src="docs/images/drawer-post.png" alt="The Post caption tab: caption and hashtags with copy buttons" width="400"><br>*Post caption: the text under your post, with hashtags, ready to copy.* |

### Export

<p align="center">
  <img src="docs/images/export.png" alt="The export screen: the saved video, its post caption with a copy button, and ways to send it to Instagram" width="760">
</p>

*Export saves the video to your computer, with the post caption ready to copy, and can send it to your phone.*

The demo reel in these pictures is a cartoon presenter with a synthetic voice and a synthesised song, all made for
this project. Credits: [docs/images/CREDITS.md](docs/images/CREDITS.md).

## Download and install

Get the latest installer from the [Releases page](https://github.com/AidenJohnston/reel-studio-app/releases/latest).

| System | File | Guide |
|---|---|---|
| Windows 10/11, 64-bit | `Reel-Studio-Setup-<version>-x64.exe` | [Install on Windows](docs/install-windows.md) |
| macOS 14+, Apple silicon | `Reel-Studio-<version>-arm64.dmg` | [Install on a Mac](docs/install-mac.md) |

The installers are not signed with a paid certificate yet, so Windows SmartScreen and macOS Gatekeeper
warn the first time you open the app. Both guides show the two extra clicks. The first time you open
the app it downloads its speech model (about 500 MB, once).

## How the AI works

The AI is optional. Without it, Reel Studio still transcribes your video, cuts the pauses and repeated
starts, adds captions, mixes in the song you choose, and makes a cover.

With an AI connected, it also picks your best takes, finds pictures and builds simple animation cards, writes
your post caption, and handles your notes. You choose one of:

* **Sign in with ChatGPT.** Uses your own ChatGPT plan through OpenAI's "Sign in with ChatGPT" flow. The
  sign-in happens in your browser; Reel Studio never sees your password, and the token is stored encrypted
  with your operating system's secure storage.
* **A Claude API key.** Paste a key from the Anthropic Console. It is stored encrypted the same way.

<p align="center">
  <img src="docs/images/connect-ai.png" alt="Connect your AI editor: sign in with ChatGPT, or use an Anthropic API key, or skip it" width="560">
</p>

The AI does not write code or ffmpeg commands. It reads the transcript and the project, then changes a
project file through a fixed list of actions; a deterministic engine renders that file. The same project in
always gives the same video out. Details: [docs/architecture.md](docs/architecture.md).

## Privacy

Everything runs on your computer: transcription, cutting, captions, rendering. Your videos and songs are
never uploaded.

If you connect an AI, the provider you chose (OpenAI or Anthropic) receives only what the editor needs to do
its job:

* the **transcript text** with word timings, and the retake and pause analysis of it;
* the **project file** (cut, caption, music and b-roll settings, titles, and the file names in your Library);
* a **few still frames** (at most six at a time) from a preview of your edit, so it can check its own work;
* your **notes** and your saved **style rules**.

Nothing else is sent. With no AI connected, nothing is sent at all.

Reel Studio itself makes only these other network requests, and only when you use the feature: the one-time
speech model download from Hugging Face, image search (Openverse and Wikimedia Commons) and brand logos
(Simple Icons) with the words the AI chose, a screenshot of a website or app page the AI names in your reel, and downloads of pictures, videos or songs from links you paste. There is no analytics and no
crash reporting.

One request happens without you asking: at most once a day it asks GitHub's public releases list
(`api.github.com/repos/AidenJohnston/reel-studio-app/releases`) whether a newer version is out, sending only a
generic `User-Agent: ReelStudio/<version>` and no cookies, account or ID. If there is one, a small note says so;
nothing is downloaded or installed. Turn it off in Settings with "Check for updates".

## Build from source

You need Node.js 22 or newer and Python 3.11. For development on a machine without the bundled runtime, put
`ffmpeg` and `ffprobe` (7.1 recommended) on your PATH.

```
git clone https://github.com/AidenJohnston/reel-studio-app.git
cd reel-studio-app
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

Run the app and the tests:

```
npm run dev                  # the app, with hot reload
npm test                     # app + ai unit tests
npm run typecheck
cd engine && python -m pytest tests          # engine tests (the compositing suite takes a few minutes)
npm run e2e                  # Electron end-to-end tests (slower; needs the engine venv)
```

Build the installers (they bundle Python, ffmpeg and fonts, about 250 MB of downloads the first time):

```
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1

# macOS (Apple silicon)
packaging/build-mac.sh
```

Packaging details, signing and notarizing: [packaging/README.md](packaging/README.md) and
[docs/signing-mac.md](docs/signing-mac.md).

The "Claude Code on this computer" option (the `claude` CLI you are already signed in to) is off in
public installers. To get it in your own build, set `REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD=1` when building,
or when running `npm run dev`.

## Project layout

| Path | What |
|---|---|
| `app/` | Electron + React + Vite desktop app |
| `ai/` | Providers, prompts, editor tools and the agent loop (TypeScript) |
| `engine/` | The media engine: transcribe, cut, captions, b-roll, music, render (Python) |
| `templates/` | HTML animation templates and fonts |
| `packaging/` | Installer config, runtime fetch scripts, licenses |
| `docs/` | Install guides, architecture, design notes |

## License and third-party notices

Reel Studio is released under the [MIT License](LICENSE).

The installers also contain other programs, each under its own license: FFmpeg and FFprobe (GPL v3, run
as separate programs), Python and its libraries, Electron, fonts (SIL OFL and Apache 2.0), and the YuNet face
detector (MIT). Full list, license texts and where to get the corresponding FFmpeg source:
[THIRD_PARTY.md](THIRD_PARTY.md) and [engine/THIRD_PARTY.md](engine/THIRD_PARTY.md). Every release
publishes that source next to the installers.

## Credits

The editing method follows the Minimum Viable Editing Strategy as described by **Mino Lee**, credited here with
Mino's permission.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
