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
   price on 'twenty bucks'"). Each note makes a new version (v1, v2, v3...). Notes that are lasting
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
`<Documents>/Reel Studio/My style.json`.

```
<slug>/
  project.json            the edit (schema below), the only file the AI changes
  media/                  copies (or hard links) of the user's raw takes for this project
  work/                   engine caches: transcript.json, audio.wav, face.json, layers/, proxies; safe to delete
  versions/v1/            project.json snapshot + export.mp4 + cover.png + verify.json + notes.md
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
{"event":"done","result":{...}}
{"event":"error","code":"NO_AUDIO","message":"<developer detail>","userMessage":"This video has no sound. Try a different file."}
```

Exit code 0 on done, 1 on error. The `message` in progress events is user-facing and plain.

| command | does |
|---|---|
| `probe <file>` | duration, fps, size, rotation, has audio, kind guess (`talking_head` / `broll_video` / `music` / `image` / `unknown`) |
| `classify --root <root> <file>...` | sorts dropped files into the Library folders |
| `init --project <dir> --title T <files>...` | creates the project folder and project.json, copies media |
| `transcribe` | faster-whisper word timestamps -> `work/transcript.json` with stable ids |
| `analyze` | audio envelope, pause list, retake groups (lines said more than once), face box track, a deterministic default cut |
| `autocut` | writes a deterministic baseline `cut.keep`; the AI then refines it |
| `render [--draft] [--window a:b]` | renders project.json -> `versions/vN/{export.mp4, cover.png, verify.json}`; `--draft` is a fast preview |
| `cover` | renders cover.png only |
| `verify <mp4>` | A/V sync, loudness (-14 LUFS target), duration, black frames, caption-safe placement report |
| `frames --times t1,t2,...` | extracts PNG frames from the latest render (for the AI to look at) |
| `search-images`, `fetch-image`, `download-media` | find a freely licensed image, fetch one by URL, download a video or song from a link |
| `attach --project <dir> <file> [--name N]` | a picture, GIF or short clip the user attached to a note -> `work/assets/attach-<id>-<stem>.<ext>` + sidecar `<asset>.attach.json` (name, kind, bytes, size, duration, sound, thumb) + a 320 px still in `work/thumbs/`. JPG/PNG copied; HEIC, still GIF/WebP, BMP -> PNG; animated GIF/WebP -> silent H.264 mp4 (looped to at least 3 s); clips copied. Limits: pictures 25 MB, clips and GIFs 200 MB and 60 s; anything else is refused with a plain message and nothing is written |
| `doctor` | checks ffmpeg, the speech model, fonts, GPU; prints a human report |

Everything must work with paths that contain spaces and non-ASCII characters, on macOS arm64 and Windows
x64. Encoders: libx264 for the final export; drafts use `h264_videotoolbox` on macOS and, on Windows, the first of
`h264_nvenc` / `h264_amf` / `h264_qsv` that opens on the machine (probed once, cached), else libx264 ultrafast.

## 5. Engine module split

| Area | Modules |
|---|---|
| Core | `cli.py`, `project.py` (load/save/validate, word-anchor to output-time mapping), `schema/`, `probe.py`, `classify.py`, `transcribe.py`, `analyze.py` (pauses, retakes, default cut), `cut.py`, `captions.py`, `render.py` (orchestration and the final ffmpeg graph), `verify.py`, `frames.py`, `doctor.py` |
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
zoom.build_zooms(ctx) -> list[ZoomSpan]  # ZoomSpan(t0, t1, scale, cx, cy)
music.build_audio(ctx, voice_wav) -> Path   # final mixed wav at -14 LUFS integrated
cover.render(ctx, out_png) -> Path
```

## 6. AI tools (the editor's actions)

The agent loop lives in `ai/`. Tools are strict JSON-schema functions that operate on project.json through a
small TypeScript project API and then ask the main process to re-render. The set:

`get_project`, `get_transcript` (with retake groups and pauses from `analyze`), `set_cut(keep)`,
`set_gap_cap`, `set_caption_style`, `add_caption_correction`, `list_library(kind)`, `choose_music(track,
startAt, level)`, `set_music_automation`, `add_broll(anchor, treatment, asset, params)`, `update_broll`,
`remove_broll`, `set_mirror(on, source)` (flip a mirrored take; the editor calls it when text in the room reads
backwards in the frames it looks at, or when a note says the video is mirrored), `search_images(query)` / `fetch_image(url)`, `capture_website(url)` (a screenshot of a public web page in a locked-down offscreen window, for an app or site the speaker names), `make_animation(template, params)`, `set_zoom`,
`set_cover(atSourceTime, text)`, `write_post(caption, hashtags[5], keywords)`, `add_style_rule(rule)`,
`render_draft`, `look_at_frames(times)` (returns images for vision models), `finish(summary_for_user)`.

Agent tasks:

1. **First edit** after transcribe and analyze: pick takes (the "red thread": the best take of each beat,
   dropping doubles, false starts and meta-talk like "let me try that again"), captions, music, a b-roll plan,
   a cover and the post kit; render a draft, look at frames, fix obvious problems, render, summarize in one to
   three plain sentences.
2. **Apply a note**: change only what the note asks; if the note is a lasting preference, `add_style_rule`.
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
- **Connect Claude / Connect ChatGPT** (`app/src/main/vendor-connect.ts`, `vendor-setup.ts`): one click installs
  the vendor's app when it is missing, by downloading the vendor's own install script to a FILE and running it
  hidden (never a `| iex` / `| bash` command line: Defender blocks that one-liner as a trojan), then runs the
  CLI's own sign-in hidden (`claude auth login --claudeai`, `codex login`). The CLI opens the vendor's page and
  catches the answer on 127.0.0.1; Reel Studio only waits for the process and asks the CLI again. Its output is
  never shown or logged and stdin is closed, so no sign-in code passes through the app. The page only learns
  {vendor, state, step, version, plan kind, message}. A Claude sign-in whose page shows a code falls back to a
  terminal window running `claude auth login` (`claude-signin.ts`). Neither CLI is ever chosen on its own.
- **Retired: "Sign in with ChatGPT"** (`chatgpt`, `siwc.ts`): on the first start of this version a saved session is
  signed out (token revoked, files deleted). It stays in dev mode until `siwc.ts` is deleted.
- **Your own AI server** (`custom`, advanced, folded behind a link next to the API key): a connection to an
  Anthropic-compatible server (Messages API, through the same Anthropic adapter with the person's base URL) or an
  OpenAI-compatible one (Chat Completions, `ai/src/providers/openaiCompatible.ts`, because most compatible servers
  implement that endpoint). Label, kind, address and model live in `ai-settings.json`; each key is its own file
  encrypted with `safeStorage` (`connection-<id>.bin`), never returned to the page, never sent after a redirect,
  and only sent to the server (origin) it was saved for. On Linux without a keyring (`safeStorage`'s `basic_text`
  backend) no key is saved. Saving makes one small text request first and, if it fails, says which field to fix.
  A second request carries a 1×1 picture; if the server refuses it, the connection is saved with pictures off and
  the AI editor sends it none. The person can switch pictures on or off on the saved connection.
- **Developer providers** (behind a dev flag, never shown to users): the retired `chatgpt` sign-in and a
  recorded-response replay provider used by tests.

## 7. B-roll treatments and animations

Treatments (`engine/reelengine/templates/treatments/` and `broll.py`): `card-above-head` (an image card above
the face, slight tilt, sized to read), `full-frame` (covers the frame, face hidden), `phone-card` (asset in a
phone frame, beside the face), `side-card` (left or right of the face), `text-pop` (big words above the head),
`post-wall` (a grid of images building one per word), `icon-wall`, `split-top` (asset on the top half, speaker
on the bottom half), and `animation`. Each treatment is a deterministic layout from (asset, face track, frame
size, params).

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
`logo-pop`, `price-tag`, `typing-terminal`), each exposing `window.__setup(params)` and `window.__seek(t)`.
The Electron main process renders them in an offscreen window frame by frame into ffmpeg, producing a
transparent layer. No CDN is used at run time; any JS is vendored.

## 8. App and AI interface

`@reelstudio/ai` (`ai/src/index.ts`) is what the app's main process calls; the app implements `EngineHost`.

```ts
export type AgentEvent =
  | { type: 'status'; message: string; pct?: number }        // plain words, shown in the Working screen / chat
  | { type: 'tool'; name: string; summary: string }           // e.g. "Added b-roll on 'twenty bucks'"
  | { type: 'render'; version: number; draft: boolean };
export interface AgentResult { summary: string; version: number; styleRulesAdded: string[]; changed: string[] }
export interface ScriptResult { hook: string; script: string; onScreenText: string[] }

export interface EngineHost {                                // implemented by the app main process
  runEngine(command: string, args: string[], onProgress?: (p: { stage: string; pct: number; message: string }) => void,
            signal?: AbortSignal): Promise<any>;             // resolves with the engine's `done.result`, rejects with {code,userMessage}
  renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string>;
  captureWebsite(url: string, outPath: string, opts?: { layout?: 'phone' | 'desktop' }): Promise<{ path: string; url: string; site: string; title: string; width: number; height: number }>;
  reelStudioRoot(): string;                                  // <Documents>/Reel Studio
}

export interface ProviderStatus { id: 'chatgpt' | 'claude' | 'codex-cli' | 'claude-cli' | 'custom' | 'replay' | 'none'; connected: boolean; label: string; connectionId?: string }
export function createAI(opts: { host: EngineHost; settingsDir: string; dev?: boolean }): {
  providers(): Promise<ProviderStatus[]>;
  active(): Promise<ProviderStatus>;
  setActive(id: ProviderStatus['id'], connectionId?: string): Promise<void>;
  signInChatGPT(openExternal: (url: string) => Promise<void>): Promise<ProviderStatus>;
  signOutChatGPT(): Promise<void>;
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
