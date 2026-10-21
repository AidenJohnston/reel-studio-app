# Versions and previews (contract between engine, ai and app)

Decided 2026-10-17 (polish stream). Goal: the user sees v1, v2, v3 for edits they can export,
never a pile of preview-only folders an AI run left behind.

## On disk

```
<project>/versions/
  v1/            a VERSION: export.mp4 + cover.png + verify.json + render.json + project.json (+ notes.md)
  v2/
  preview/       the ONE scratch folder for previews, overwritten every time:
                 draft.mp4, window_<a>-<b>.mp4 (only the latest window), cover.png, verify.json,
                 render_draft.json, project.json
```

Rules:

1. **Only a final render (`render` without `--draft`/`--window`) creates or fills `versions/vN/`.**
2. **Every `render --draft` and every `render --window a:b` writes into `versions/preview/`**,
   replacing what was there (a new window deletes the previous `window_*.mp4`). It never creates a
   `vN` folder and never changes `project.json`'s `version`.
3. `project.json` `version` = the last FINAL version number.
4. A final render re-uses `vN` when the edit is unchanged since `vN` was rendered (re-rendering the
   same edit overwrites it); otherwise it makes `v(N+1)`.
5. `cover` (cover only) writes into `vN` when that edit already has its `export.mp4`, else into
   `preview/`.
6. `frames` reads the newest full render, preview or final (never a window slice).

## Render result (engine `done.result`)

| field | meaning |
|---|---|
| `version` | final: the version written. Preview: the number this edit WILL get when it is finalised |
| `preview` | `true` for drafts and windows (file is under `versions/preview/`) |
| `versionDir` | absolute folder the files went to |
| `file` | absolute path of the mp4 |
| `broll` | b-roll items shown differently than asked (`fallback`, `shownAs`) or skipped (`skipped`) |

## What the app shows

- **Version chips** = folders matching `^v\d+$` that contain `export.mp4`, sorted by number.
  Folders without `export.mp4` (from older builds, or an AI run whose final render failed) are
  not shown.
- **While an AI run is working**, the player may show `versions/preview/draft.mp4` (the `render`
  event with `draft: true`).
- **`AgentResult.version`** is the version to select after a run. In the rare case its folder has
  no `export.mp4` (the final render failed and the run fell back to its preview), show
  `versions/preview/draft.mp4` and offer to try the final render again.
- `versions/vN/notes.md` (written by the ai package) is the note text for that chip.
- **A change asked at a moment** (the button under the player) names the words on screen. The app
  reads them from the version being watched: `duration` and `segmentsDetail` (source, src_start,
  src_end, out_start per kept span) in `versions/vN/render.json`, or `versions/preview/render_draft.json`
  for the Preview, mapped onto `work/transcript.json`, read again each time the pop-up opens. Without
  them a "Just here" change is refused (never widened); the person can choose Whole reel. The main
  process checks the same render and rebuilds the word ids itself. The engine lists at most 2000
  segments; past the last one listed, the same applies. The note's mark on the scrub bar maps the same way in reverse:
  its word ids, placed on the version on screen; with none of them in that cut, it has no mark.

## ai package

- `render_draft` = engine `render --draft` (preview). The agent caps previews per task (3 per first
  edit, 2 per note).
- After the agent calls `finish`, the loop runs one final `render`: that is the only step that adds a
  version.
