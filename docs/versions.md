# Versions and previews (contract between engine, ai and app)

Decided 2026-10-17 (polish stream). Goal: the user sees v1, v2, v3 for edits they can export,
never a pile of preview-only folders an AI run left behind.

## On disk

```
<project>/versions/
  v1/            a VERSION: export.mp4 + cover.png + verify.json + render.json + project.json + version.json (+ notes.md,
                 receipts.json, title.json, check.json, ai-run.json), and the reports that describe this video: captions.json,
                 layers.json, mix.json
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
   (the same edit, engine version, and files it reads, the transcript included) returns `vN` as it is
   (`reused: true`, nothing encoded); otherwise it makes `v(N+1)`, also when `vN` has lost its
   `export.mp4` or `render.json`. Versions without a recorded engine version get a new number too.
   A note that only changes the caption therefore keeps its version
   number, and `vN/project.json` keeps the caption it was made with; `project.json` has the new one,
   which is what Export writes. A `vN` folder above `project.json`'s `version` is an attempt that was
   never saved: the app does not list it (`listVersions`), and the next final render of that number
   deletes it first.
5. `cover` (cover only) writes into `preview/`.
6. `frames --render-id <id>` reads that render and nothing else, and `frames --file <video>` the render that file
   is (see Render identity). Its stills go to `work/frames/`.
7. `--project-file work/...` makes `render`, `anim-context` and `cover-candidates` read (and `render`
   patch `version` into) that document instead of `project.json`. A final rendered from such a copy
   never takes a number `project.json` has already saved: the engine refuses it (`PROJECT_CHANGED`).
8. `version.json` records `{ "parent": N }`, or null for Version 1. The engine writes it before
   advancing the project counter. Saved folders without this file have parent N-1, with null for
   Version 1; reading them never backfills the file. Previews have no parent.
9. `render --parent N` records an explicit parent. When N is older than the live counter carried by
   the edit, it creates the next version even if the result matches the newest video. This preserves
   branch ancestry without rewriting a saved folder. Rendering without an explicit older parent
   keeps the reuse rule above.

10. `render --parent A --merge-parent B` always creates a new final version and records
    `{ "parent": A, "parents": [A, B] }`. Both parents must be distinct saved versions.
    The AI-free layer merge and its anchor rules are in [Combining saved versions](version-merge.md).

## Render identity

Every render returns a random `renderId` and an `inputFingerprint` (SHA-256 of the edit, transcript
words, asset sizes and times, draft flag and window). The manifest next to the video (`render.json` or
`render_draft.json`) records both, the video's SHA-256, and that render's own caption boxes
(`captionsReport`), b-roll records (`layerItems`), segments and word times. A render id is looked up under
`versions/` and, for a note's previews, under `work/notes/<id>/` (the folder given with `--out`). `verify.json` repeats the id
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

The app names each version from its receipts ("Shorter cut, bigger subtitles", app/src/shared/describe.ts).
After a note, the creator's own connection may reword that name with its small model (Haiku through
Claude Code or a Claude key; none for other connections). The app keeps the rewording in
`versions/vN/title.json` (`{renderId, title, summary}`) only when every change, direction and number it
names is in the receipts, and shows it only while `renderId` is the folder's last receipt. The check reads each
part of the rewording as a claim (kind of change, direction, number) and compares it with what the app's own
words for that change claim, so "Cut 2 words" for words brought back, or "Cut a word" for 2, is dropped.

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

- **Version chips** = folders `vN` with N up to `project.json`'s `version` that contain
  `export.mp4`, sorted by number. Folders without `export.mp4` (from older builds, or an AI run
  whose final render failed) and folders above `version` are not shown.
- **The Subtitles list** shows the lines in `captions.json` of `v{version}`, or of `versions/preview/`
  while there is no version; a version made before reports moved beside their render has them in
  `work/captions.json`.
- **While an AI run is working**, the player may show its latest draft (the `render` event with
  `draft: true`): a note's own drafts, which go away with the note.
- **`AgentResult.version`** is the version to select after a run. In the rare case its folder has
  no `export.mp4` (a first edit whose final render failed fell back to its preview), show
  `versions/preview/draft.mp4` and offer to try the final render again. It is absent after a note
  that made no version (it changed nothing, or its edit ended where it started).
- `versions/vN/notes.md` (written by the ai package) is the note text for that chip.
- `versions/vN/ai-run.json` (written by the ai package when a model call was answered) records each call of the
  run that made the version, the checker's included: provider, the model asked for, the model and CLI version the
  provider reported, effort, and tokens including cache reads and writes. A value the provider did not report is the
  string `"not reported"`, never 0. A note writes it into its new version folder before `project.json` points at
  that version; a note that made no version writes none. It is measurement only; the app does not show it.
- **A change asked at a moment** (the button under the player) names the words on screen. The app
  reads them from the version being watched: `duration` and `segmentsDetail` (source, src_start,
  src_end, out_start per kept span) in `versions/vN/render.json`, or `versions/preview/render_draft.json`
  for the Preview, mapped onto `work/transcript.json`, read again each time the pop-up opens. Without
  them a "Just here" change is refused (never widened); the person can choose Whole reel. The main
  process checks the same render and rebuilds the word ids itself. The engine lists at most 2000
  segments; past the last one listed, the same applies. The note's mark on the scrub bar maps the same way in reverse:
  its word ids, placed on the version on screen; with none of them in that cut, it has no mark.
- `VersionInfo.parent` accompanies each version in project detail. The note IPC accepts an optional
  base number; choosing and displaying branches in the renderer is a later slice.
- A branched note's or a merge's receipt (`receipts.json`) says what changed since its parent, not since the
  newest version. In the app the base rides on the note's queue entry (`queue[].branch`).

## ai package

- `render_draft` = engine `render --draft` (preview). The agent caps previews per task (3 per first
  edit, 2 per note).
- With Settings > "Double-check each edit" on, after the agent calls `finish` on a note that changed
  the edit, a checker reviews it before the final render (see Checker below).
- Then the loop runs one final `render`: that is the only step that adds a version.
- A note is all-or-nothing (`ai/src/editor.ts` `applyNote`). It edits `work/notes/<id>/edit.json`, a
  copy of `project.json`, renders its drafts into that folder and its final into `v(N+1)`, then writes
  the snapshot and `notes.md` into `v(N+1)` and replaces `project.json` in one rename, after checking
  that `project.json` is still what the note started from and Stop was not pressed. A note that fails,
  is stopped, hits its step limit with something changed, or whose final render fails changes nothing
  the user can see; its downloads stay in `work/assets` but are not offered again.
- `applyNote(..., { base: N })` edits the saved `vN/project.json` snapshot. It retains live identity,
  title, timestamps, note history, manual-edit history and the highest version counter. Omitting
  `base` uses the live edit, including unrendered changes. Explicit bases are checked before staging
  for a finished snapshot, available assets and valid word anchors. The live bytes remain the
  compare-and-swap target. Preference-only notes do not switch the edit to the selected base.
- After an ordinary failed final, the note removes its unpublished next-version folder while still
  holding the edit lock. If the engine is stuck, or the live counter now includes that version,
  it leaves the folder alone. Crash leftovers still follow rule 3 and app recovery.

Snapshots do not freeze transcripts. Missing word anchors are refused, but a re-transcription that
reuses word ids can change their meaning. Restoring those earlier meanings requires transcript
history and is outside this first slice.

## Checker

A note's edit is checked before it becomes a version (`ai/src/checker.ts`, prompt `ai/prompts/checker.md`)
when Settings > "Double-check each edit" is on (`settings.json` `checkEdits`, passed to `applyNote` as
`checkEdit`). It is off by default until the eval harness measures the tokens and time it adds; with it
off a note runs exactly as without a checker.

1. **Candidate.** The editor's last preview when nothing changed after it, otherwise a new
   `render --draft`. A draft carries the receipt and `verify`, and never adds a version. The checker's
   drafts don't count against the editor's preview cap. A draft that fails to render ends the check
   with `error` (after undoing the repair it was meant to show, if any); the note still makes its version.
2. **Check.** One request to the editor's model with no tools and no earlier conversation. It
   contains the note, the receipt's facts (with the words a cut removed or brought back), the
   candidate's `verify`, `warnings` and `broll` report, the words the video now says, and up to 6
   frames from `look_at_frames` at the moments the facts touch: each new cut join (a take that
   now starts or ends elsewhere, including the video's last word), each changed b-roll, each added or removed zoom, and the middle of
   the video for caption, mirror or pause changes. The facts are fenced as data. The reply is
   `{verdict: pass|fix, fixes: [{problem, request}], scores}` with 1-5 scores for `asked`,
   `nothingElse`, `hook`, `pacing`, `captions`, `visuals`, `sound`. An unreadable reply is asked
   for once more. So is one whose `problem` (shown to the creator) is over 180 characters or two
   sentences, or names word ids, tools or fields.
3. **Repair.** A `fix` sends the requests and the note to the editor in a new run on the same
   project, which says the reviewer is not the user. At most 2 repair rounds; each is followed by a
   new check of a new candidate. A repair that changes nothing, or that stops with an AI error (its
   project changes, downloads and style rules are undone), ends the loop.
4. **Result.** `versions/vN/check.json` and `AgentResult.check` hold `{verdict, repairs, rounds,
   error?, cost: {tokens, seconds}}`. `verdict` is `pass`, `unresolved` (fixes remain: the summary
   ends with the checker's plain-words problems, never as a success) or `error` (no usable check;
   the version is kept and the summary is the editor's). `cost` counts checker requests and repair
   runs, from the first check to the last. Each round records `frames: {asked, seen, error?}`, so a
   pass made without the frames it asked for says so.

Fast notes (no model) and notes that end with no change are not checked.

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
children when it exits (`engine/reelengine/contain.py`). If Windows refuses the Job Object, the engine
logs it and runs anyway; Stop still ends its whole tree, but an engine crash can then leave its ffmpeg
running.

A closed project refuses everything that would write to it: jobs, manual edits, attachments, notes
and deleting the video. Each refusal asks the creator to restart Reel Studio first
(`app/src/main/jobs.ts`).

The app records each engine's pid, project and start time in `engines.json` (in its settings folder)
until the engine's whole group is gone, and at startup stops engines a crashed run left behind: only a
live process that runs the engine and started when the recorded one did. Anything else that may be
left (a start time that doesn't match, a group whose engine died but whose ffmpeg runs on) is not
signalled; it stays listed and keeps its project closed, and the next start after it ends opens it. A project whose
engine would not stop stays closed. When `engines.json` cannot be read, the app instead looks at the
running processes: a project stays closed only while an engine or ffmpeg names its folder in its
arguments, and every other project opens. It keeps looking at each start until it finds none
(`app/src/main/orphans.ts`).

## Notes waiting their turn

A note sent while another job runs on the same video waits in that video's queue in `app.json`
(`app/src/main/note-queue.ts`), written to disk before the send returns. Notes run one at a time, oldest
first, each on whatever version is newest when it starts. A queued note's id is the id it is saved under in
`project.json` `notes`, and it leaves the queue only once that id is there, so a crash on either side of
the save never runs it twice. A note that changes nothing is saved too, with `applied: []`.

The queue goes on by itself only after a saved note. Stop, a failed note and a restart hold it until the
user presses Resume (a note sent to an empty queue starts at once). A note that was stopped or failed before
it was saved waits again at the top, so it can be edited or tried again without retyping it. A file attached while a job runs goes
to `<userData>/note-staging/<slug>/` and is copied into `work/assets` by its own note's job.

Notes on different videos run side by side, but only one engine `render` runs at a time across all of
them (`app/src/main/render-slot.ts`). A render that ends with `ENGINE_STUCK` keeps the slot until Reel
Studio restarts. An engine a crashed run left that would not stop holds only its own video, which stays
closed until that engine exits (`app/src/main/last-run.ts`); other videos render as usual. A video kept
closed because the startup process scan found an engine or ffmpeg naming it opens once a later look finds
none.
