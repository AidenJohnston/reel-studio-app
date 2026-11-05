# Reel Studio

Turn a raw talking-head video into a finished, postable 9:16 Reel. Drop in your takes, retakes and
fumbles included. Reel Studio listens, picks your best take of every line, cuts the pauses, adds captions,
puts your own music under your voice, adds b-roll and a cover, and writes the post caption. Then you type
notes in plain English ("music too loud at the start") and get a new version. Paste, drop or attach a picture,
GIF or short clip to a note ("put this over my face when I say 'the ick'") and it goes on those words.

It is an open source desktop app for **macOS (Apple silicon)** and **Windows 10/11 (64-bit)**.
No account, no telemetry: your videos stay on your computer.

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

## Where it's going

Reel Studio is going to be an all-in-one content creation platform that helps you create and grow your audience, at
scale. Turn a raw talking-head video into polished short-form content, with agents working on your machine and a
desktop app where you control what they do, then share it across your socials. It works with your Claude Code and
Codex subscriptions.

It's going to be T3 Code, but with all the agentic surfaces hidden behind the actual user experience. Several agents
work on one video at once. You never manage them. You see the video, what changed, and the versions to pick from,
and you can stop or undo anything.

Why Reel Studio:

1. **OSS, trust and control over your content.** Everything runs on your computer, and the code is AGPL, so you, or
   a company's security team, can read exactly what happens to your videos and build it yourself. A company can check
   that for itself instead of taking a vendor's word for it.
2. **Truly continual learning.** We're building a system that never makes the same mistake. When you correct
   something, it becomes a rule. A rule the engine can check, like caption size, how loud the music sits under your
   voice, or nothing covering your eyes, is checked on every render, and the agent can't hand you a video that
   breaks it. A rule about taste can't be checked, so for those we measure how often it's followed instead of
   promising.
3. **Parallel and autonomous A/B testing,** because testing short form means getting real content out, and that's
   hard. Agents make several versions of one video in parallel, with a different hook, first line or pace. You pick
   one, or approve them all and post them as Instagram trial reels, which go to people who don't follow you first,
   and see how each did, judged by how many people keep watching rather than by views. One post against another is
   noisy, so it tells you when the result isn't clear yet.
4. **Unparalleled rendering speed, and a QC UI and experience where you see your changes immediately.** We're going
   to push the performance of this app to a ridiculous point. For our use case that means a system that is FFmpeg,
   but faster:
   - your 4K footage is decoded once, into a lighter copy made in the background when you import it, instead of on
     every edit;
   - the engine knows exactly which frames an edit changed, from the project file, so it renders those first and you
     see stills of the agents at work within a second, then the moments around them, then the whole draft;
   - anything an edit didn't touch is reused, not rendered again;
   - a draft keeps what matters most and lets the rest go. Where the cuts land, the caption words and their timing,
     what covers your face and how it sounds all match the export. Only detail too small to see at preview size is
     dropped.

   Agents build most of it, and their one goal is less waiting. They keep cutting work out of a render until a check
   against today's renderer fails, figure out why it failed, find a faster patch that passes, and repeat. The check
   compares every frame, on footage we shot on our own phones, and the agents can't change it, so faster never means
   different.

### Why shorts work

We want to study the cognitive mechanisms of human attention for short form: not click-through rate, but whether
people keep watching, and why. Then distill it into a methodology models can use to analyze why something would work,
and apply the same approach to your drafts, in the form of subjective reviewers.

Reel Studio knows every edit decision in a video, down to the word. It reads back how each video did, YouTube's
retention curve and Instagram's average watch time and how many people skip in the first three seconds, and lines that
up with those decisions on your computer. Your results stay in your project folder, and your own agents use them to
choose what to test next. You can also choose to share what you've learned with us, as numbers and never your videos
or transcripts, so everyone starts from better defaults. Human panels compare two hooks side by side.

We don't think adversarial review, one model arguing with another, is the way to go. A reviewer only counts for what
it can predict on videos it hasn't seen, against a simple baseline we set in advance, the same way we check the
renderer.

## Download and install

[Buy Reel Studio at getreelstudio.com](https://getreelstudio.com/): $99 once (perpetual license plus all 1.x
updates) or $20 a month, cancel anytime. The download link for the installers is on the page right after
payment, and the app tells you when a newer version is out. Buying funds development and gets you the signed
builds, updates and help. You still need your own Claude or ChatGPT plan for the AI editor.

The code is MIT, so anyone can [build it themselves](#build-from-source) for free.

| System | File | Guide |
|---|---|---|
| Windows 10/11, 64-bit | `Reel-Studio-Setup-<version>-x64.exe` | [Install on Windows](docs/install-windows.md) |
| macOS 14+, Apple silicon | `Reel-Studio-<version>-arm64.dmg` | [Install on a Mac](docs/install-mac.md) |

The Mac app is signed and notarized by Apple, so it opens with a double-click. The Windows installer is not
signed with a paid certificate yet, so Windows SmartScreen warns the first time you open it; the Windows guide
shows the two extra clicks. The first time you open the app it downloads its speech model (about 500 MB, once).

## How the AI works

The AI is optional. Without it, Reel Studio still transcribes your video, cuts the pauses and repeated
starts, adds captions, mixes in the song you choose, and makes a cover.

With an AI connected, it also picks your best takes, finds pictures and builds simple animation cards, writes
your post caption, and handles your notes. You choose one of:

* **Connect Claude.** Needs a paid Claude plan (Pro or Max). One click installs Anthropic's Claude Code app if
  you don't have it, then opens Anthropic's own sign-in page in your browser. Reel Studio never sees that
  sign-in, your password or any token: Anthropic's app keeps it. The edits run on your own Claude plan and
  count toward its usage limits.
* **Connect ChatGPT.** Works with your ChatGPT plan, free ones too (with their limits). One click installs
  OpenAI's Codex app if you don't have it, then opens OpenAI's own sign-in page. Same rules: Reel Studio never
  sees the sign-in, and the edits run on your own ChatGPT plan.
* **A Claude API key** (advanced). Paste a key from the Anthropic Console. It is stored encrypted with your
  operating system's secure storage.

If one of those apps is already signed in on your computer, it is the first choice offered; nothing switches
to it until you click it. The installers are the vendors' own (the scripts on their install pages), downloaded
and run for you.

<p align="center">
  <img src="docs/images/connect-ai.png" alt="Connect your AI editor: Connect Claude or Connect ChatGPT, use an Anthropic API key, or skip it" width="560">
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
* your **notes** and your saved **style rules**;
* for each picture, GIF or clip you **attach to a note**: one small still of it, plus its file name, size and
  length. The file itself stays on your computer.

With "Use Claude (your Claude Code app)", the same things go to Anthropic through the Claude Code app you signed
in to, on your own Claude plan. Reel Studio starts that app on your computer and asks it whether you are signed
in; it never reads, stores or passes on your Claude sign-in.

Nothing else is sent. With no AI connected, nothing is sent at all.

Reel Studio itself makes only these other network requests, and only when you use the feature: the one-time
speech model download from Hugging Face, image search (Openverse and Wikimedia Commons) and brand logos
(Simple Icons) with the words the AI chose, a screenshot of a website or app page the AI names in your reel, and downloads of pictures, videos or songs from links you paste. There is no analytics and no
crash reporting.

One request happens without you asking: at most once a day it asks `dl.getreelstudio.com/latest.json` whether a
newer version is out, sending only a generic
`User-Agent: ReelStudio/<version>` and no cookies, account or ID. If there is one, a small note says so; nothing
is downloaded or installed. Turn it off in Settings with "Check for updates".

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
