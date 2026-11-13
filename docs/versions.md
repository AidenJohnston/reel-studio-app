# Versions and previews (contract between engine, ai and app)

Decided 2026-10-17 (polish stream). Goal: the user sees v1, v2, v3 for edits they can export,
never a pile of preview-only folders an AI run left behind.

Changed 2026-11-12: a version is saved from its draft. Notes and hand edits end at the draft, and the
full-quality file is made once, when the person exports (a 2 s nitpick no longer waits for a full render).
A saved version is complete and never changes, and Export rebuilds any version from its own snapshot.

## On disk

```
<project>/versions/
  v1/            a VERSION, saved from its draft and then never changed: project.json (the snapshot),
                 inputs.json (every file its draft was rendered from, as the renderer recorded it),
                 draft.mp4, cover.png (+ notes.md); once exported, also export.mp4 + render.json +
                 verify.json, made from that snapshot
  v2/
  preview/       the ONE scratch folder for previews, overwritten every time:
                 draft.mp4, window_<a>-<b>.mp4 (only the latest window), cover.png, verify.json,
                 render_draft.json, project.json,
                 moments/still_<frame>.png (the latest `moments` run's stills, replaced by the next run)
```

`work/moments/base.json` is the project (and its animation files' sizes and times) as the screen last
showed it: `moments` compares the project with it to find what an edit changed, and replaces it when a
run finishes.

Rules:

1. **Only `save-version` creates `versions/vN/`, and only `export` adds to it.** `save-version` copies
   the draft of this edit from `preview/` (rendering it first when `preview/` shows another edit, or
   was made from a file that has changed since) with its cover, the snapshot and `inputs.json`, writes
   them under `.vN.part/` and renames that to `vN/`,
   so a version is whole or absent. It records the moments base (the screen now shows this version).
   Nothing ever rewrites or deletes a saved version's files.
2. **Every `render --draft` and every `render --window a:b` writes into `versions/preview/`**,
   replacing what was there (a new window deletes the previous `window_*.mp4`). It never creates a
   `vN` folder and never changes `project.json`'s `version`.
3. `project.json` `version` = the last SAVED version number (saved from its draft or exported).
4. **What a video is made from is recorded by the renderer, never listed by hand** (`reads.py`): while
   a full render or a draft runs, every file the engine opens for reading, every existing file it hands
   to FFmpeg and every path the project resolver resolves, under the project or the Reel Studio root, is
   kept, except what the engine writes itself (`reads.GENERATED`) and project.json. So is every file it
   looks for and does not find (an optional input such as a face track), as absent, and every file it
   writes there itself (a face track it detects and caches). Each one goes into the render's manifest
   (`inputs`) with a digest taken when the render ends, so a file the render made counts with the content
   it ended with (a file written and gone by then, such as an atomic write's `<name>.<pid>.tmp`, was
   temporary and only the name it was renamed to counts): content for files up to 16 MB, size and time for larger ones (the takes), `null` for a
   file still not there, so a file that appears later counts as a change. A draft in `preview/` is reused only while every file in its `inputs` is
   unchanged, the song included. `save-version` copies those `inputs` into `inputs.json`, keeps the
   current `vN` when it is this very video (the same edit signature, its `inputs.json` unchanged), and
   otherwise saves `v(N+1)`. A file replaced under the same name is a new version, never a changed old one.
5. `export --version K` makes version K's `export.mp4` by rendering K's own snapshot into `vK/`
   (`render.run(version=K)`), whatever the project is now, so every version, newest or only ever a
   preview, exports its own video. The rebuild reads the project's work files through a work folder of
   its own (`vK/.rebuild/`, removed after) holding only the work files K was made from, and writes its
   reports and scratch there, so the current
   edit's `work/captions.json` and `work/layers/` are never replaced. It renders once: a whole
   `export.mp4` (its `render.json` written after it) is handed back as it is. When a file in K's
   `inputs.json` has changed since K was saved, it refuses (`VERSION_INPUTS_CHANGED`) instead of making
   a different video under K's number. Without
   `--version` it saves the edit as it is now first. Its result carries `facts` read from the file with
   ffprobe: width, height, fps, bytes, duration and `fullResolution` (the version's format).
6. `cover` (cover only) writes into `vN` when that edit already has its `export.mp4` (the same edit
   draws the same cover), else into `preview/`.
7. `frames` reads the newest full render, preview or final (never a window slice), whose manifest
   carries the project's current picture key. When none does, it draws the stills from the project
   into `preview/frames/` without making a preview.

## Render result (engine `done.result`)

| field | meaning |
|---|---|
| `version` | final: the version written. Preview: the number this edit WILL get when it is finalised |
| `preview` | `true` for drafts and windows (file is under `versions/preview/`) |
| `versionDir` | absolute folder the files went to |
| `file` | absolute path of the mp4 |
| `broll` | b-roll items shown differently than asked (`fallback`, `shownAs`) or skipped (`skipped`) |

## What the app shows

- **Version chips** = folders matching `^v\d+$` that contain `export.mp4`, or `draft.mp4` beside
  `inputs.json` (an older build's scratch draft in a `vN` folder has no `inputs.json` and is not a
  version), sorted by number. A chip without `export.mp4` plays its draft and says it is a quick
  preview; Export makes that version's full-quality file.
- **While an AI run is working**, the player may show `versions/preview/draft.mp4` (the `render`
  event with `draft: true`).
- **`AgentResult.version`** is the version to select after a run: saved from its draft, so its folder
  has `draft.mp4` until it is exported.
- **Export, Send to my phone and posting** all start with `export --version <the chosen chip>`, as a job
  with progress; the file copied into Library › Finished videos is that version's `export.mp4`.
- `versions/vN/notes.md` (written by the ai package) is the note text for that chip: the one file
  added to a saved version, and never part of its video.

## ai package

- `render_draft` = engine `render --draft` (preview). The agent caps previews per task (3 per first
  edit, 2 per note).
- After the agent calls `finish`, the task renders a draft only when the last one does not show the
  edit (a moments run of this edit counts), then runs `save-version`: that is the only step that adds a
  version. No AI task renders a full-quality file.
