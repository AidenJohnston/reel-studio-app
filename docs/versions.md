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
   returns `vN` as it is (`reused: true`, nothing encoded); otherwise it makes `v(N+1)`. A note that
   only changes the caption therefore keeps its version number, and `vN/project.json` keeps the caption
   it was made with; `project.json` has the new one, which is what Export writes.
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

`<project>/work/.owner.lock` holds the token of the project's single writer (`ai/src/owner.ts`,
`engine/reelengine/owner.py`). The app's job lane takes it for every job and manual edit and passes the
token on: the AI edit joins it, and every engine command the job runs gets `--owner <token>`. An
engine command run by hand without a token takes the project for itself while it runs, and refuses
("This project is open in Reel Studio") while another owner is alive. `attach` and commands that
change nothing in the project run beside the owner.

The owner touches the lock file every 5 s; a lock untouched for 30 s has no live owner and can be taken
over. The timestamp is the liveness signal because Node has no OS file lock, a PID can be reused, and
`os.kill(pid, 0)` sends Ctrl-C on Windows. A note checks it still owns the project right before it
replaces `project.json`, so a note whose lock was taken over fails instead of saving.
