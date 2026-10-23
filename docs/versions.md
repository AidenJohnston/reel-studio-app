# Versions and previews (contract between engine, ai and app)

Decided 2026-10-17 (polish stream). Goal: the user sees v1, v2, v3 for edits they can export,
never a pile of preview-only folders an AI run left behind.

## On disk

```
<project>/versions/
  v1/            a VERSION: export.mp4 + cover.png + verify.json + render.json + project.json (+ notes.md),
                 and the reports that describe this video: captions.json, layers.json, mix.json
  v2/
  preview/       the ONE scratch folder for previews, overwritten every time:
                 draft.mp4, window_<a>-<b>.mp4 (only the latest window), cover.png, verify.json,
                 render_draft.json, project.json
<project>/work/notes/<id>/   a running note: edit.json (its private copy of project.json) and its drafts
```

Rules:

1. **Only a final render (`render` without `--draft`/`--window`) creates or fills `versions/vN/`.**
2. **Every `render --draft` and every `render --window a:b` writes into `versions/preview/`** (or the
   folder given with `--out`, which a note uses), replacing what was there (a new window deletes the
   previous `window_*.mp4`). It never creates a `vN` folder and never changes `project.json`'s `version`.
3. `project.json` `version` = the last FINAL version number, and **a `vN` folder counts as a version
   only when N <= `version`**. A higher one is an attempt that was never saved (a note that failed, was
   stopped, or was cut off by a quit or crash): nobody shows it, and the next final render of that
   number deletes it first.
4. **A saved version is never rewritten.** A final render of an edit unchanged since `vN` was rendered
   (the same edit, and the same files it reads, the transcript included) returns `vN` as it is
   (`reused: true`, nothing encoded); otherwise it makes `v(N+1)`. A note that only changes the
   caption therefore keeps its version number, and `vN/project.json` keeps the caption it was made
   with; `project.json` has the new one, which is what Export writes.
5. `cover` (cover only) writes into `preview/`.
6. `frames` reads the file given with `--file`, else the video the project shows: `v{version}`, or the
   preview while there is no version. Its stills go to `work/frames/`.
7. `--project-file work/...` makes `render`, `anim-context` and `cover-candidates` read (and `render`
   patch `version` into) that document instead of `project.json`.

## Render result (engine `done.result`)

| field | meaning |
|---|---|
| `version` | final: the version written. Preview: the number this edit WILL get when it is finalised |
| `preview` | `true` for drafts and windows (file is under `versions/preview/`) |
| `versionDir` | absolute folder the files went to |
| `file` | absolute path of the mp4 |
| `broll` | b-roll items shown differently than asked (`fallback`, `shownAs`) or skipped (`skipped`) |

## What the app shows

- **Version chips** = folders matching `^v\d+$` that contain `export.mp4` and whose number is at most
  `project.json`'s `version`, sorted by number. Folders without `export.mp4` (from older builds) are
  not shown. If `project.json` cannot be read, no chip is shown.
- **While an AI run is working**, the player may show its latest draft (the `render` event with
  `draft: true`): a note's own drafts, which go away with the note.
- **`AgentResult.version`** is the version to select after a run. In the rare case its folder has
  no `export.mp4` (a first edit whose final render failed fell back to its preview), show
  `versions/preview/draft.mp4` and offer to try the final render again.
- `versions/vN/notes.md` (written by the ai package) is the note text for that chip.

## ai package

- `render_draft` = engine `render --draft` (preview). The agent caps previews per task (3 per first
  edit, 2 per note).
- After the agent calls `finish`, the loop runs one final `render`: that is the only step that adds a
  version.
- A note is all-or-nothing (`ai/src/editor.ts` `applyNote`). It edits `work/notes/<id>/edit.json`, a
  copy of `project.json`, renders its drafts into that folder and its final into `v(N+1)`, then writes
  the snapshot and `notes.md` into `v(N+1)` and replaces `project.json` in one rename, after checking
  that `project.json` is still what the note started from and Stop was not pressed. A note that fails,
  is stopped, hits its step limit, or whose final render fails changes nothing the user can see; its
  downloads stay in `work/assets` but are not offered again.

## One writer per project

The running app is the only writer of its projects. Electron's single-instance lock is held by the OS
until the app process dies, and inside the app the job lane runs one job or manual edit per project.
Everything a job runs, the AI edit and each engine command, gets the job's token (`--owner`) and never
decides ownership itself. `<project>/work/.owner.lock` only tells tools run by hand that the app has
the project open: the engine CLI and the AI dev CLI refuse while it exists ("Reel Studio may be using
this project. Close it, or delete <path> if it isn't running.") and never take a project over. The
app removes leftover lock files when it starts (`app/src/main/owner.ts`).

Every AI edit, the app's and the dev CLI's alike, also holds `<project>/work/.ai-edit.lock` for its
whole run, so two edits in different processes never run on one project at once (`ai/src/index.ts`
`withEditLock`). A lock whose process has died, or that is 3 hours old, is taken over.

## Engine processes

An engine call settles only after the engine and everything it started have exited. On macOS and
Linux the engine runs as its own process group and the host stops what is left of the group after
any exit; if something survives SIGKILL the call fails with `ENGINE_STUCK` and the app keeps that
project closed until it restarts. On Windows the engine puts itself in a Job Object that ends its
children when it exits (`engine/reelengine/contain.py`).

The app records each engine's pid and project in `engines.json` (in its settings folder) until the
engine's whole group is gone, and at startup stops engines a crashed run left behind. A project whose
engine would not stop stays closed. When `engines.json` cannot be read, the app instead looks at the
running processes: a project stays closed only while an engine or ffmpeg names its folder in its
arguments, and every other project opens. It keeps looking at each start until it finds none
(`app/src/main/orphans.ts`).
