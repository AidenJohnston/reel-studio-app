# Reel Studio architecture

Reel Studio turns a raw talking-head video into a finished, postable 9:16 Reel with no manual editing.
This document describes how the pieces fit together. Section numbers are referenced from comments in the code.

## 1. What the app does

1. The user clicks **New video** and drops in one or more raw takes (retakes and fumbles included).
2. The app transcribes the speech, picks the best take of each line, removes pauses and do-overs, captions
   the result, picks a song from the user's own library and lowers it under the voice, adds b-roll (the
   user's own files, images found online, or generated animation cards), makes a cover, and writes a post
   caption with 5 hashtags.
3. The user watches the result and types **notes** in plain English ("music too loud at the start", "put the
   price on 'twenty bucks'"), from the button under the player. A note about the moment on screen names the words
   on screen then, read from the version being watched (`At 0:14 (around "...", words w80, w81): cut
   this part`), and the AI anchors the change on those word ids. Each note makes a new version (v1, v2, v3...). Notes that are lasting
   preferences are saved to **My style** and apply to every future video.
4. **Export** writes the finished mp4, the cover and the caption text to a folder.

The app works with no AI connected: transcription, a deterministic cut, captions, music on a chosen song
and a cover. Connecting an AI adds take-picking, b-roll, the post kit and note handling.

Design rule for the UI: every screen has one obvious next action, no jargon, and every error says what to do.

## 2. Architecture

```
Electron app (app/)                     TypeScript, React, Vite, electron-builder
 |- renderer: React UI
 `- main process
     |- project store (folders on disk, project.json per video)
     |- engine runner: spawns the bundled Python engine, reads JSON-lines progress
     |- ai/ package: provider sign-in + the editor agent loop (tools = project actions)
     `- animation renderer: offscreen BrowserWindow renders HTML templates frame by frame -> ffmpeg

engine/  (Python, package `reelengine`)  deterministic media engine; NEVER calls an LLM
ai/      (TypeScript, `@reelstudio/ai`)  providers, prompts, tools, agent loop; NEVER touches media directly
```

Bundled with the installer: a Python runtime plus the engine, ffmpeg/ffprobe, fonts, templates. The speech
model is downloaded on first run.

**The core rule: the AI edits a project file, the engine renders it.** The AI never writes code or ffmpeg
commands. It reads the transcript and the project, then calls a fixed set of tools (section 6) that change
`project.json`. The engine renders `project.json` deterministically: same project file in, same video out.
That is what makes notes cheap (a note changes one field and the engine re-renders) and what lets different
providers drive the same editor.

### Repository layout

| Path | What |
|---|---|
| `engine/` | The Python media engine (`reelengine`), `pyproject.toml`, pytest suites |
| `ai/` | The TypeScript AI package: providers, prompts, tools, agent loop (vitest) |
| `app/` | The Electron + React + Vite desktop app |
| `templates/` | HTML animation templates and shared fonts |
| `packaging/` | electron-builder config, runtime fetch/bundle scripts, build scripts per OS, licenses |
| `docs/` | Install guides, signing notes, design notes |

The root `package.json` is an npm workspace (`app`, `ai`).

## 3. Project folder format

Projects live in `<Documents>/Reel Studio/Projects/<slug>/`. The shared **Library** lives in
`<Documents>/Reel Studio/Library/` with subfolders `Raw takes/`, `B-roll/`, `Music/`, `Images/`, `Exports/`
(plain folder names on purpose, so anyone can open them in Finder or Explorer). User style lives in
`<Documents>/Reel Studio/My style.json`. Its rules are sentences the AI reads; a rule with `paused: true` stays
listed in My style but the AI doesn't read it, and the app doesn't apply it. A rule may also carry a typed `payload`
the app applies itself when a new video is made (only `{"kind":"caption-case","case":"lower"}` so far), plus `source`
(project, title, version) and `consent` (the question the person said Yes to). A rule may instead carry a `check`
the engine measures on every render, such as `{"kind":"captions.maxWords","value":2}` (`ai/src/rules.ts`,
`engine/reelengine/rule_checks.py`); its words are the app's, and a note can't finish while one fails. `proposals`
holds at most three memories My style suggests from post results or hand edits (`app/src/main/memory-loop.ts`),
none a rule until the person keeps it; a kept one records `learned` (where it was read from). `forgotten` lists the questions of
removed rules, so answering one again cannot bring a rule back. All of these are optional. An older version ignores `paused`, reads a
typed rule as a plain sentence, cannot answer a typed question, and may drop `forgotten` if it
rewrites the file. `updatedAt` is when a rule's words last changed (a pause does not count), and `byYou` marks a
rule typed in with Add a rule; My style lists the newest first by the first and names the source from the second.
A file there that can't be parsed is kept as `My style.damaged.json`
(`My style.damaged 2.json` and so on if that name is taken) and a new one starts, with the copy's name in
`damaged`; My style says so while the copy is there.

```
<slug>/
  project.json            the edit (schema below), the only file the AI changes
  media/                  copies (or hard links) of the user's raw takes for this project
  work/                   engine caches: transcript.json, audio.wav, face.json, layers/, proxy/ (preview copies); safe to delete
  versions/v1/            project.json snapshot + export.mp4 + cover.png + verify.json + notes.md (+ ai-run.json)
  versions/v2/ ...
  versions/preview/       the one scratch folder for drafts, overwritten each time (see versions.md)
```

### project.json (schemaVersion 1)

All times are seconds (float). **B-roll, zooms, music automation and caption overrides are anchored to
transcript word ids, never to output seconds**, so re-cutting never breaks them. The engine converts word
anchors to output time at render.

```jsonc
{
  "schemaVersion": 1,
  "id": "uuid", "title": "Why mornings matter", "slug": "why-mornings-matter",
  "createdAt": "ISO", "updatedAt": "ISO", "version": 3,          // last rendered version number
  "format": { "width": 1080, "height": 1920, "fps": 30 },
  "sources": [ { "id": "s1", "path": "media/take01.mp4", "duration": 241.3, "fps": 29.97, "width": 1080, "height": 1920, "rotation": 0 } ],
      // optional "mirror": true = the take is mirrored (front camera), the render flips the picture (schema-changes.md)
  "transcript": { "file": "work/transcript.json", "language": "en" },
      // transcript.json = { "words": [ { "id": "w0", "source": "s1", "s": 0.085, "e": 0.245, "w": "This" }, ... ] }
      // word ids are stable for the life of the project (re-transcription keeps ids by time overlap)
  "cut": {
    "keep": [ { "from": "w12", "to": "w40" }, { "from": "w58", "to": "w97" } ],   // in OUTPUT order; inclusive word-id ranges
    "gapCap": 0.25,              // max dead air kept between words (seconds), measured from the audio release
    "minSaving": 0.08
  },
  "captions": {
    "enabled": true,
    "style": { "preset": "bold-lower", "font": "Montserrat SemiBold", "size": 105, "maxWords": 3,
               "case": "upper", "color": "#FFFFFF", "outline": 6, "position": 0.70 },
    "corrections": [ { "from": "cloud", "to": "Claude" } ]
  },
  "music": {
    "enabled": true,
    "track": "Library/Music/my-song.mp3",     // path relative to the Reel Studio root, or null
    "frozen": { "track": "Library/Music/my-song.mp3", "path": "work/assets/frozen/music/<sha256>.mp3" },
                                              // optional: the AI's frozen copy, played while its track matches
    "startAt": 0.0,                           // offset into the track
    "level": "under-voice",                   // "under-voice" | "quiet" | "loud-intro"
    "automation": [ { "fromWord": "w0", "toWord": "w30", "gainDb": -6 } ],
    "fadeOut": 1.5
  },
  "broll": [
    { "id": "b1", "anchor": { "from": "w44", "to": "w49" }, "leadIn": 0.13,
      "treatment": "card-above-head",                 // see section 7
      "asset": "Library/Images/price-card.png",       // or project-relative "work/assets/x.png", or an animation id
      "params": { "tilt": -2.5, "scale": 1.0, "text": null } }
  ],
  "zooms": [ { "anchor": { "from": "w10", "to": "w14" }, "scale": 1.12 } ],
  "cover": { "atSourceTime": 40.0, "source": "s1", "text": null },
  "post": { "caption": "", "hashtags": [], "keywords": [] },
  "notes": [ { "version": 2, "text": "music too loud at the start", "applied": ["music.automation"], "at": "ISO" } ]
}
```

A JSON Schema lives at `engine/reelengine/schema/project.schema.json` and is mirrored as TypeScript types in
`ai/src/project.ts`. Schema changes are additive (optional fields only) and are logged in
[schema-changes.md](schema-changes.md). How previews and versions are written is in [versions.md](versions.md).

## 4. Engine CLI contract

Invocation: `python -m reelengine <command> --project <dir> [options]`. Paths to binaries come from the
environment: `REELENGINE_FFMPEG`, `REELENGINE_FFPROBE`, `REELENGINE_MODELS` (speech model folder),
`REELENGINE_FONTS`, `REELENGINE_ROOT` (the Reel Studio root, for resolving `Library/...` paths). Defaults:
look on PATH / repo-relative.

**stdout is JSON lines only** (one object per line); stderr is free-form logs:

```
{"event":"progress","stage":"transcribe","pct":42,"message":"Listening to your video"}
{"event":"progress","stage":"moments","pct":40,"message":"Here's your change","ready":{"kind":"still","t":2.4,"file":"..."}}
{"event":"done","result":{...}}
{"event":"error","code":"NO_AUDIO","message":"<developer detail>","userMessage":"This video has no sound. Try a different file."}
```

Exit code 0 on done, 1 on error. The `message` in progress events is user-facing and plain. A progress
event may carry `ready`, a file the app can show right away: `{"kind":"still","t":<output s>,"file"}` or
`{"kind":"window","from","to","file"}` (only `moments` sends them).

| command | does |
|---|---|
| `probe <file>` | duration, fps, size, rotation, has audio, kind guess (`talking_head` / `broll_video` / `music` / `image` / `unknown`) |
| `classify --root <root> <file>...` | sorts dropped files into the Library folders |
| `init --project <dir> --title T <files>...` | creates the project folder and project.json, copies media |
| `transcribe` | faster-whisper word timestamps -> `work/transcript.json` with stable ids |
| `analyze` | audio envelope, pause list, retake groups (lines said more than once), face box track, a deterministic default cut |
| `autocut` | writes a deterministic baseline `cut.keep`; the AI then refines it |
| `render [--draft] [--window a:b] [--rules file]` | renders project.json -> `versions/vN/{export.mp4, cover.png, verify.json}`; `--draft` is a fast preview; `--rules` measures checked My style rules (result `ruleChecks`) and a final render that breaks one listed in `stopOn` returns `encoded: false` before its encode |
| `score --version N` | the mechanical checks saved version N passes, from the reports beside it (pauses, subtitles, loudness, the file, My style rules, the double-check); renders nothing |
| `match-joins [--keep <json>] [--every] [--project-file <f>]` | for each match join of the cut (or, with `--every`, each join that could hold one): whether the frames around it line up, its output time and why not (`match.py`) |
| `pace-preview` | for no pace and each cut-style preset: picture changes a minute and in the first 5 seconds, from the plan a render would make, without encoding |
| `proxy` | makes the preview copy of each take bigger than 1080p or HDR: `work/proxy/<sid>-<key>.mp4` (H.264, every frame a keyframe, short side 1080, SDR, no sound) + its `.json` sidecar. Drafts and windows read it when it matches the take as it is now; finals and covers read the original. The app starts it after import, at below-normal priority |
| `cover` | renders cover.png only |
| `verify <mp4>` | A/V sync, loudness (-14 LUFS target), duration, black frames, caption-safe placement report, checked against that render's own manifest |
| `moments [--mark] [--no-draft] [--project-file <f> --out <dir>]` | what changed on screen since the state last shown (`work/moments/base.json`, or `moments-base.json` beside a note's `--project-file`), as output intervals (`moments.py`): stills inside them (at most 3, sent as `ready` as each is drawn), the 2 s window around the first (`ready`), then the draft (into `--out`, as `render --draft --out` does; `--job-id`, `--parent` and `--merge-parent` are passed on to it); the result has `intervals`, `changes`, `stills`, `window` and `draft` (the render result). The base becomes this state only when the run finishes. `--mark` only writes the base |
| `frames [--render-id <id>] --times t1,t2,... [--words w1,...]` | PNG stills for the AI to look at. With `--render-id`, from that render; it refuses a render a newer one replaced. Without, stills of the edit (a note's copy with `--project-file`): cut from the newest render that still shows it, or drawn straight from the project when none does |
| `inspect-render --render-id <id>` | that render's own verify result, caption boxes, b-roll records, segments and word times (docs/versions.md) |
| `search-images`, `fetch-image`, `download-media` | find a freely licensed image, fetch one by URL, download a video or song from a link |
| `attach --project <dir> <file> [--name N]` | a picture, GIF or short clip the user attached to a note -> `work/assets/attach-<id>-<stem>.<ext>` + sidecar `<asset>.attach.json` (name, kind, bytes, size, duration, sound, thumb) + a 320 px still in `work/thumbs/`. JPG/PNG copied; HEIC, still GIF/WebP, BMP -> PNG; animated GIF/WebP -> silent H.264 mp4 (looped to at least 3 s); clips copied. Limits: pictures 25 MB, clips and GIFs 200 MB and 60 s; anything else is refused with a plain message and nothing is written |
| `doctor` | checks ffmpeg, the speech model, fonts, GPU; prints a human report |
| `import-reference <file> [--output F]` | reads a Final Cut Pro (`.fcpxml`, `.fcpxmld`) or Premiere FCP7 `.xml` export through OpenTimelineIO (the `reference` extra) into a timeline record: tracks, clip positions and source ranges, markers, transitions, effects and media, with exact FCPXML timing. The adapter runs in a child process stopped after 60 s or 2 GiB. `losses` lists what the adapters are known to drop and `rawMetadata` what they keep only as metadata. Writes nothing into a project |

Everything must work with paths that contain spaces and non-ASCII characters, on macOS arm64 and Windows
x64. Encoders: libx264 for the final export; drafts use `h264_videotoolbox` on macOS and, on Windows, the first of
`h264_nvenc` / `h264_amf` / `h264_qsv` that opens on the machine (probed once, cached), else libx264 ultrafast.

## 5. Engine module split

| Area | Modules |
|---|---|
| Core | `cli.py`, `project.py` (load/save/validate, word-anchor to output-time mapping), `schema/`, `probe.py`, `classify.py`, `transcribe.py`, `analyze.py` (pauses, retakes, default cut), `cut.py`, `match.py` (match cuts: the frames around a join that line up, searched in its pause and cached; `project.timeline` applies them so every kind of render cuts on the same frames), `captions.py`, `render.py` (orchestration and the final ffmpeg graph), `verify.py`, `frames.py`, `doctor.py` |
| Compositing | `broll.py` (treatments to layers), `placement.py` (face-aware safe boxes), `zoom.py`, `music.py` (track analysis, level presets, automation, ducking, loudness), `cover.py`, `assets.py` (images from the web, media from a link via yt-dlp), `templates/` |

The core renders by composing: cut video (+ zooms) -> overlay layers by z -> captions burned last -> mux the
mixed audio. Captions always sit on top of b-roll. Graphics stay out of the eyes-to-chin zone and the caption
band unless the treatment hides the speaker (full-frame, post-wall, split-top); see section 7.

The compositing modules implement this interface, called by the core:

```python
# reelengine/render_ctx.py
@dataclass
class RenderCtx:
    project: dict; project_dir: Path; root: Path          # root = Reel Studio root
    out_timeline: list[Segment]                          # cut segments in output order
    word_out_time: Callable[[str], float]                # word id -> output seconds
    duration: float; fmt: dict; draft: bool; work: Path; ffmpeg: str; ffprobe: str
    progress: Callable[[str, float, str], None]

broll.build_layers(ctx) -> list[Layer]   # Layer(path, kind:'image'|'video', t0, t1, x, y, w, h, rotate_deg, z, fade_in, fade_out)
zoom.build_zooms(ctx) -> list[ZoomSpan]  # ZoomSpan(t0, t1, scale, cx, cy, ramp_in, ramp_out)
music.build_audio(ctx, voice_wav) -> Path   # final mixed wav at -14 LUFS integrated
cover.render(ctx, out_png) -> Path
```

## 6. AI tools (the editor's actions)

The agent loop lives in `ai/`. Tools are strict JSON-schema functions that operate on project.json through a
small TypeScript project API and then ask the main process to re-render. The set:

`get_project`, `get_transcript` (with retake groups and pauses from `analyze`), `set_cut(keep)`, `find_match_cuts`
(which joins can be match cuts, from `reelengine match-joins`; `set_cut` refuses a match whose two sides don't line up),
`set_gap_cap`, `set_cut_style(preset, seed)`, `set_beat_accents(on)` (accents on the song's beat; null lets the cut style decide), `set_caption_style`, `add_caption_correction`, `list_library(kind)`, `read_references` (the
reference reels saved in My style and the app's readout of what they have in common: talking pace, seconds per shot,
the opening line; titles and opening lines are other creators' words, fenced as data), `choose_music(track,
startAt, level)`, `set_music_automation`, `add_broll(anchor, treatment, asset, params)`, `update_broll`,
`remove_broll`, `set_mirror(on, source)` (flip a mirrored take; the editor calls it when text in the room reads
backwards in the frames it looks at, or when a note says the video is mirrored), `resolve_asset(kind, intent, phase, candidateId)`, `list_assets`, `preview_asset`, `export_asset_credits`, `search_images(query)` / `fetch_image(url)`, `capture_website(url)` (a screenshot of a public web page in a locked-down offscreen window, for an app or site the speaker names), `make_animation(template, params)`, `set_zoom`,
`set_sfx` (built-in sound effects, each hitting on a word, a b-roll's appearance or a cut; the engine plays at
most one every 2 seconds, under the voice),
`set_cover(atSourceTime, text)`, `write_post(caption, hashtags[5], keywords)`, `add_style_rule(rule, check)`,
`lint_edit` (deterministic repairs and issues, see `docs/edit-lint.md`), `render_draft` (runs the same lint before encoding), `look_at_frames(times)` (returns images for vision models), `finish(summary_for_user)`.

`make_variant(variable, hook?, cover?, caption?, brightness?)` saves a trial changing one of
`seed`, `hook`, `cover`, `caption`, or `brightness`. The editor supplies the alternative hook word
range, cover, or post caption. Seed trials generate a new seed in the same style; brightness
trials multiply footage exposure by 1.08 or 0.92. `trials.json` beside the project records
`{parent_version, variable, from, to}`. These fields and their types remain unchanged. New
records also include `parent_id` and `parent_snapshot`, a project-relative path under
`trials/parents/`. That file is the exact pre-trial project, identified by its SHA-256 digest.
`parent_version` remains the last final render number; several unrendered edits can share it.
Comparison readers, including the learning loop, must use `parent_snapshot` when present and
fall back to the rendered version only for older records. Trials never create or overwrite a
rendered version snapshot.

Engine project reads, writes and final render version updates share `.project-owner.lock`.
The OS releases ownership when a process exits; the file stays in place so waiters keep locking
the same file. A trial checks that its parent is still current, then durably records both states
and both trial logs in `.trial-transaction.json` before replacing either public file. It writes
the project first and the trial log second. The next engine project access finishes an interrupted
transaction under the same lock. Recovery refuses to overwrite a state outside that transaction.
Non-engine writers must coordinate with the owner lock; this lock does not cover independent
filesystem writes.

For projects with `cutStyle`, one RNG resolves the framing scale, starting framing, card lead,
cadence phase, tied accent choices, and existing J/L frame offsets. `set_zoom` accepts an optional
`accentGroup` for equally suitable moments. The renderer returns the resolved decisions in
`variation` and stores them in its render report. Projects without `cutStyle` retain their
existing framing and timing. Preset values define the cadence band and two nominal framings;
the seed changes neither the preset nor its budgets, transition options, or audio levels.
People choose the preset, a new seed ("Try other moments") and each zoom's kind in "Edit it myself" > Cut >
Pace. Those changes go through the hand-edit queue like the drawer's others, and main refuses a preset, seed or
kind the AI's tools would refuse (`app/src/shared/cut-style.ts`, kept equal to the AI's and the engine's by
`app/test/cut-style.test.ts`).

Agent tasks:

1. **First edit** after transcribe and analyze: pick takes (the "red thread": the best take of each beat,
   dropping doubles, false starts and meta-talk like "let me try that again"), captions, music, a b-roll plan,
   a cover and the post kit; render a draft, look at frames, fix obvious problems, render, summarize in one to
   three plain sentences.
2. **Apply a note**: change only what the note asks; if the note is a lasting preference, `add_style_rule`.
   Every render in a first edit or a note measures the checked My style rules (`render --rules`). The editor
   sees a failing rule in `render_draft`, and `finish` refuses once while the newest render fails one and
   nothing changed. A final render that fails a rule stops before its encode and the editor gets one short fix
   run; then the reel is made and the reply names any rule still failing. Rules already failing in the version
   the note started from are named, not chased.
3. **Idea to script**: a hook, a spoken script and on-screen text in the user's voice.

Prompts are plain markdown in `ai/prompts/`.

### Providers

- **Anthropic via a pasted API key** (Messages API with tool use).
- **"Use Claude (your Claude Code app)"** (`claude-cli`, offered to everyone): runs the person's own Claude Code
  app, Anthropic's `claude` CLI, so the edit uses their own Claude plan and its usage limits. Reel Studio never
  sees, stores, reads or proxies a Claude credential. It finds the binary (PATH, Anthropic's native installer in
  `~/.local/bin`, Homebrew, npm, nvm, Volta, Bun, WinGet, and on macOS the login shell, since a Finder-launched app
  has a minimal PATH) and asks the CLI itself: `claude --version` (installed) and `claude auth status` (signed in).
  Only the yes/no, the version and the plan kind are kept, never the e-mail or organization.
- **"ChatGPT (your Codex app)"** (`codex-cli`): the same idea with OpenAI's `codex` CLI, signed in with the
  person's ChatGPT plan. Found the same way (PATH, OpenAI's installer folders, Homebrew, npm's native exe, the
  macOS login shell); `codex --version` and `codex login status` only, never `~/.codex`. Edits run `codex exec`
  read-only, ephemeral and with `--ignore-user-config`, so the person's MCP servers, plugins and hooks never run.
  The dev MCP harness (`ai/src/mcp/codex.ts`) runs the same binary that detection found.
- **Connect Claude / Connect ChatGPT** (`app/src/main/vendor-connect.ts`, `vendor-setup.ts`): one click installs
  the vendor's app when it is missing, by downloading the vendor's own install script to a FILE and running it
  hidden (never a `| iex` / `| bash` command line: Defender blocks that one-liner as a trojan), then runs the
  CLI's own sign-in hidden (`claude auth login --claudeai`, `codex login`). The CLI opens the vendor's page and
  catches the answer on 127.0.0.1; Reel Studio only waits for the process and asks the CLI again. Its output is
  never shown or logged and stdin is closed, so no sign-in code passes through the app. The page only learns
  {vendor, state, step, version, plan kind, message}. A Claude sign-in whose page shows a code falls back to a
  terminal window running `claude auth login` (`claude-signin.ts`). Neither CLI is ever chosen on its own. Choosing
  Claude sends it one short message first; if that fails, the row says why, and Cancel stops it. Each vendor is a
  row of the editor picker, what the person already has first (otherwise Claude), with the connect's steps under it.
- **Retired: "Sign in with ChatGPT"** (0.1.2 and earlier): 0.1.3 signed a saved session out (token revoked, files
  deleted); its code is gone since. On start, `retireSignInWithChatGPT()` deletes any files an older version left
  and clears a choice of it, with no request to OpenAI, and the Connect screen says ChatGPT moved to the Codex app.
- **Your own AI server** (`custom`, advanced, folded behind a link next to the API key): a connection to an
  Anthropic-compatible server (Messages API, through the same Anthropic adapter with the person's base URL) or an
  OpenAI-compatible one (Chat Completions, `ai/src/providers/openaiCompatible.ts`, because most compatible servers
  implement that endpoint). Label, kind, address and model live in `ai-settings.json`; each key is its own file
  encrypted with `safeStorage` (`connection-<id>.bin`), never returned to the page, never sent after a redirect,
  and only sent to the server (origin) it was saved for. On Linux without a keyring (`safeStorage`'s `basic_text`
  backend) no key is saved. Saving makes one small text request first and, if it fails, says which field to fix.
  A second request carries a 1×1 picture; if the server refuses it, the connection is saved with pictures off and
  the AI editor sends it none. The person can switch pictures on or off on the saved connection.
- **Developer providers** (behind a dev flag, never shown to users): a recorded-response replay provider used by
  tests.

## 7. B-roll treatments and animations

Treatments (`engine/reelengine/templates/treatments/` and `broll.py`): `card-above-head` (an image card above
the face, slight tilt, sized to read), `full-frame` (covers the frame, face hidden), `phone-card` (asset in a
phone frame, beside the face), `side-card` (left or right of the face), `text-pop` (big words above the head),
`post-wall` (a grid of images building one per word), `icon-wall`, `split-top` (asset on the top half, speaker
on the bottom half), `animation`, and `text-behind` (big words behind the speaker). Each treatment is a
deterministic layout from (asset, face track, frame size, params).

`text-behind` draws its words as a layer, then a `matte` layer above them: the speaker cut out of the footage.
`segment.py` makes the matte, a grey clip of the window, with PP-HumanSeg (OpenCV Model Zoo, downloaded once and
pinned by SHA-256) on each source frame through the render's own crop, turn and mirror. `build_video_cmd` pads
that clip to the whole render, runs it through the same zoom chains as the footage, and alpha-merges it with a
copy of the zoomed frame, so the cut-out follows every zoom. Without the model (offline), the words go above
the face as `text-pop` and the render result says so.

**Placement rule.** The protected zone is the **eyes-to-chin** region (eyes, nose and mouth: from just above
the eyebrows to the chin, outer eye corners plus a margin) and the **caption band**, not the whole face box.
It comes from YuNet's eye and mouth landmarks, else from the face box's proportions. Cards may cover hair, the
forehead down to just above the brows, and the sides of the head.

- `card-above-head` sits as low as the brow line allows and is sized to read: a card with text (screenshot,
  article, post, clip) is at least 55% of the frame wide; a logo or cut-out may be smaller (at least 22%). A
  tall asset that cannot read above the brows may go beside the face (at least 40% wide).
- `side-card` sits beside the eyes-to-chin zone; with no readable room there it goes over the hair on its
  side; text cards stay at least 40% wide.
- A text card is first cropped to its words (plain margins and empty blocks only; the readable floor shrinks
  with the width dropped, never below 30%). A `card-above-head` that still can't read centred goes a little
  smaller over the hair on one side.
- Split view is the last resort, used only when even the relaxed zone leaves no readable placement; the render
  result reports every such fallback in plain words.
- `full-frame`, `post-wall` and `split-top` cover or move the face on purpose.
- Default look: a short tilt (about 2-3 degrees) on stills; clips stay level.

**Animations** (`templates/animations/`): HTML templates (`stat-count-up`, `big-quote`, `list-reveal`,
`logo-pop`, `price-tag`, `typing-terminal`, and `compose`, which the AI builds from rows of typed parts), each exposing `window.__setup(params)` and `window.__seek(t)`.
The Electron main process renders them in an offscreen window frame by frame into ffmpeg, producing a
transparent layer. No CDN is used at run time; any JS is vendored.

## 8. App and AI interface

`@reelstudio/ai` (`ai/src/index.ts`) is what the app's main process calls; the app implements `EngineHost`.

```ts
export type AgentEvent =
  | { type: 'status'; message: string; pct?: number }        // plain words, shown in the Working screen / chat
  | { type: 'tool'; name: string; summary: string }           // e.g. "Added b-roll on 'twenty bucks'"
  | { type: 'render'; version: number; draft: boolean }
  | { type: 'moment'; kind: 'still'; t: number; file: string }              // what an AI reply changed, before its draft
  | { type: 'moment'; kind: 'window'; from: number; to: number; file: string };
export interface AgentResult { summary: string; version: number; styleRulesAdded: string[]; changed: string[] }
export interface ScriptResult { hook: string; script: string; onScreenText: string[] }

export interface EngineHost {                                // implemented by the app main process
  runEngine(command: string, args: string[], onProgress?: (p: { stage: string; pct: number; message: string }) => void,
            signal?: AbortSignal): Promise<any>;             // resolves with the engine's `done.result`, rejects with {code,userMessage}
  renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string>;
  captureWebsite(url: string, outPath: string, opts?: { layout?: 'phone' | 'desktop' }): Promise<{ path: string; url: string; site: string; title: string; width: number; height: number }>;
  reelStudioRoot(): string;                                  // <Documents>/Reel Studio
}

export interface ProviderStatus { id: 'claude' | 'codex-cli' | 'claude-cli' | 'custom' | 'replay' | 'none'; connected: boolean; label: string; connectionId?: string }
export function createAI(opts: { host: EngineHost; settingsDir: string; dev?: boolean }): {
  providers(): Promise<ProviderStatus[]>;
  active(): Promise<ProviderStatus>;
  setActive(id: ProviderStatus['id'], connectionId?: string): Promise<void>;
  setClaudeKey(key: string | null): Promise<ProviderStatus>;   // validates the key with a tiny request
  connections(): Promise<ConnectionInfo[]>;                    // the person's own servers, never their keys
  saveConnection(c: { id?: string; label: string; kind: 'anthropic' | 'openai'; baseURL: string; model: string; key?: string }):
    Promise<{ status: ProviderStatus; connection?: ConnectionInfo; error?: UserFacingError & { field?: 'label' | 'address' | 'key' | 'model' } }>; // checks first
  removeConnection(id: string): Promise<void>;
  setConnectionImages(id: string, supportsImages: boolean): Promise<void>;
  connectionModels(q: { kind: 'anthropic' | 'openai'; baseURL: string; key?: string; id?: string }): Promise<{ models: string[]; suggested: string | null; needsKey: boolean }>; // suggested: first of PREFERRED_MODELS the server lists, never just its first
  claudeCodeStatus(): Promise<{ state: 'missing' | 'broken' | 'signed_out' | 'ready'; version?: string; plan?: string }>; // the person's own Claude Code app, a fresh look
  firstEdit(projectDir: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult>;
  applyNote(projectDir: string, note: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal,
            opts?: { attachments?: string[] }): Promise<AgentResult>;   // work/assets/attach-* refs, re-checked against their sidecars
  writeScript(idea: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ScriptResult>;
  styleRules(): Promise<{ id: string; text: string; createdAt: string }[]>;
  removeStyleRule(id: string): Promise<void>;
};
```

With no provider connected, `firstEdit` still runs the deterministic path (engine `autocut`, default captions,
music if a track is in the Library, a cover and a render) and returns a summary saying the AI is not connected.
See `ai/README.md` for the extra methods beyond this list.

### Frozen assets (pictures, clips and songs)

Web and found pictures, and clips or songs that are not in the Library (an attachment, a download), reach
the edit through `resolve_asset`. It offers candidates read where they are, each with a preview: a still for
a picture, a 3x3 contact sheet for a clip, a waveform with duration and loudness (LUFS) for a song. Only a
committed candidate can be placed. The user's own Library pictures, clips and songs skip the candidate
turn: `add_broll`, `update_broll`, `choose_music` and `logo-pop` take a `Library/...` path and freeze it
with its record in the same call, unseen by the model. A Library song keeps its `Library/...` path in
`music.track`, whether it was placed by its path or committed through `resolve_asset`, and its frozen copy
goes in `music.frozen`, which the engine plays. A song from anywhere else keeps its frozen path in
`music.track`, and the app names it by its ledger title.

Freezing happens in the engine, because the AI package never reads media. `freeze-asset` copies the file to
`work/assets/frozen/<kind>/<sha256>.<ext>`, or reuses a frozen file with the same bytes. It clones where
the disk supports it (APFS `clonefile`, Linux `FICLONE`), so a frozen copy of a Library clip costs no extra
disk on a Mac, and makes a plain copy elsewhere. It hashes the copy in chunks, never holding a whole file
in memory. Clips and songs may be up to 200 MB (clips match the app's attachment limit); pictures up to 40 MB. The AI
then appends one record of source, licence, credit and intent to `work/assets/manifest.jsonl`. Before a
placement the AI checks that a frozen file still has its recorded hash: `hash-asset` reads it once, and
the AI reuses that hash while the file's size and modification time stay the same. A failed note deletes
the frozen files that were not on disk when it started and truncates the ledger back. Animations made in
the same run are placed as they are.
