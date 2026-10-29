# Versions and previews (contract between engine, ai and app)

Decided 2026-10-17 (polish stream). Goal: the user sees v1, v2, v3 for edits they can export,
never a pile of preview-only folders an AI run left behind.

## On disk

```
<project>/versions/
  v1/            a VERSION: export.mp4 + cover.png + verify.json + render.json + project.json
                 (+ notes.md, receipts.json)
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
6. `frames --render-id <id>` reads that render and nothing else (see Render identity).

## Render identity

Every render returns a random `renderId` and an `inputFingerprint` (SHA-256 of the edit, transcript
words, asset sizes and times, draft flag and window). The manifest next to the video (`render.json` or
`render_draft.json`) records both, the video's SHA-256, and that render's own caption boxes
(`captionsReport`), b-roll records (`layerItems`), segments and word times. `verify.json` repeats the id
and fingerprint. The manifest names its video by file name only, so it still resolves after the
project folder moves or on another OS. `frames`, `verify` and `inspect-render --render-id <id>` refuse with `RENDER_MISMATCH`
unless the manifest, the video and `verify.json` are one render, so a preview replaced by a newer one is
never inspected in its place. A window slice has no manifest and cannot be inspected; neither can a
render made with `--no-verify`.

Every render after the first version also returns `receipt`: `{jobId, renderId, version, facts}`, what
changed since the version `project.json` pointed at (`render --job-id` sets `jobId`). A final render
that changed something appends it to `versions/vN/receipts.json`, which the version buttons read
(docs/schema-changes.md). `verify` finds a copied video (an export in the Library) by its SHA-256
among the project's renders.

## Render result (engine `done.result`)

| field | meaning |
|---|---|
| `renderId`, `inputFingerprint` | this render's identity (see Render identity) |
| `version` | final: the version written. Preview: the number this edit WILL get when it is finalised |
| `preview` | `true` for drafts and windows (file is under `versions/preview/`) |
| `versionDir` | absolute folder the files went to |
| `file` | absolute path of the mp4 |
| `broll` | b-roll items shown differently than asked (`fallback`, `shownAs`) or skipped (`skipped`) |
| `receipt` | what changed since the last version; absent when there is no earlier version |

## What the app shows

- **Version chips** = folders matching `^v\d+$` that contain `export.mp4`, sorted by number.
  Folders without `export.mp4` (from older builds, or an AI run whose final render failed) are
  not shown.
- **While an AI run is working**, the player may show `versions/preview/draft.mp4` (the `render`
  event with `draft: true`).
- **`AgentResult.version`** is the version to select after a run. In the rare case its folder has
  no `export.mp4` (the final render failed and the run fell back to its preview), show
  `versions/preview/draft.mp4` and offer to try the final render again. It is absent after a note
  that made no version (it changed nothing, or its edit ended where it started). If the run had overwritten the
  preview while no `vN` exists, it renders the preview again from the restored edit first.
- `versions/vN/notes.md` (written by the ai package) is the note text for that chip.

## ai package

- `render_draft` = engine `render --draft` (preview). The agent caps previews per task (3 per first
  edit, 2 per note).
- After the agent calls `finish`, the loop runs one final `render`: that is the only step that adds a
  version.
