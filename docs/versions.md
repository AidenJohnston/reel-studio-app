# Versions, previews, and staged notes

An AI note works in `<project>/.staging/<txnId>/`. Until publication, the live
`project.json`, existing media, and published versions stay unchanged. A failed or
stopped note discards its staged edit. The app reports success only after a complete
new version is published.

## A note's files

The staged folder contains a copy of `project.json`, small transcript and analysis
inputs, a copy of the credit book, and new assets with transaction-prefixed names.
Existing media and Library files remain read-only inputs. Tools save proposed style
rules in memory until publication. Rules that still need consent return as suggestions.

Final rendering writes `.staging/<txnId>/version/`. Drafts, frame grabs, cover
candidates, animation files, thumbnails, and all caches stay under the same transaction.
Each draft gets its own filename. The app grants the running job access to that
transaction and plays the draft with the existing "Here's your change" message.
It revokes access before deleting staging. Publication selects the new version;
failure or Stop returns to the original. Notes never copy drafts into `work/live`.

A post-only note copies the current final video and cover when the saved edit,
media fingerprints, render inputs, and full-quality manifest still match. Otherwise
it renders normally. Either path creates a complete new version without changing
an older version. Main also re-encoded post-only AI notes, but this avoids that work.

CLI `apply-note --draft-only` returns `previewFile`, a playable temporary file outside
the project. It does not publish the edit, save style rules, or make a version.
The caller owns that temporary file; staging is still removed when the note ends.

At the start of a note, completed voice, music-mix, b-roll, and cover caches are
cloned from the current published version's `.cache/work/`, or live `work/` for
older versions without that snapshot. macOS uses `/bin/cp -c` because Node/libuv 1.52.1 does not
implement `COPYFILE_FICLONE_FORCE` there and silently copies for `COPYFILE_FICLONE`.
Other platforms use `COPYFILE_FICLONE`. APFS shares the file data until a write;
filesystems without cloning fall back to a separate copy. No hard links are used.
The clones retain timestamps for freshness checks, and partial files are skipped.
During a note, only the clones are written. Before publication, completed caches
move into the new version's hidden `.cache/work/` snapshot. After the project and
note record commit, new cache keys are promoted into live `work/` by atomic rename.
Existing keys are never replaced. Manual renders can also read the matching voice
cache from the published snapshot when their old `voice.wav` describes another cut.
Search, music analysis, and encoder JSON caches are seeded from read-only shared
caches into staged work. New shared-cache data stays in the project's cache. Cache keys use
project-relative input names or content hashes, so moving work into staging does
not invalidate it. Generated voice audio uses a content hash because restoring a
timestamp through Node can lose nanosecond precision. Existing voice, music, and
b-roll caches with older keys can still be read; cover code changes retain the
existing rule that invalidates cached covers.
Music keys also treat integral JSON numbers such as `0` and `0.0` as equal, so a
TypeScript project save does not invalidate audio rendered from Python's JSON.

The engine accepts additive options:

- `render --project <live-dir> --project-file <staged-project.json> --out <dir>`
  reads the staged edit, resolves existing inputs from the live project, and writes
  version files into `dir`. Engine changes to the version number go only into the
  staged project file.
- `cover`, `cover-candidates`, and `anim-context` accept the same options. New staged
  `work/` assets take precedence over existing live assets when resolving inputs.
- `frames --file <video> --out <dir>` reads the selected video and writes frames into
  `dir`, including when the input is a published export.
- `--cache-dir <dir>` redirects engine download, search, music, and encoder caches.
  Note calls always supply a staged cache directory. Render scratch files also stay
  in staging, so note safety does not depend on shared cache atomicity.

## Publication

`NoteTransaction.publish` owns the sequence under the same per-project lock used
by manual updates and live engine renders:

1. Hash the live `project.json` again. A different SHA-256 refuses publication with
   "Your video changed while I was working. Send your note again."
2. Prepare and sync a staging manifest listing the new asset and thumbnail destinations,
   directories created for them, the original credit-book bytes, and the merged credit
   hash. Sync the staging directory after the manifest rename. Every destination
   has this transaction's unique prefix and must not already exist.
3. Move those assets and thumbnails into their live folders and replace the credit book
   with the prepared merged copy. Same-volume renames preserve the timestamps recorded
   in `assets.json`, so an unchanged manual rerender reuses the published version.
4. Rename the complete staged version folder to `versions/vN+1/`.
5. Rename the synced temporary project file over live `project.json`. This is the
   commit point. Its bytes match the version snapshot, including the note record and
   `notes[].txnId`; there is no later project-file append. Sync the project directory
   after this rename.
6. Save requested style rules. The immutable version contains `style-rules.json` with
   the rules and their destination root. If the app closes before this finishes,
   startup replays the rules before deleting staging. Equivalent rules are not added twice.

All temporary publication files stay in staging, including the merged credit book.
Published version folders are never rewritten. Before commit, recovery removes only
manifest-listed new assets. It restores original credit bytes only if the current
file matches the recorded hash of the merged credits. If the hash differs, recovery
logs the mismatch and leaves the credits alone. It then deletes unpublished
versions and staging. The manifest remains until repairs finish, so another crash
can repeat recovery. Before deleting anything, recovery validates the
whole manifest: only transaction-prefixed basenames in `work/assets` or `work/thumbs`
are allowed, with no separators or `..` in the basename. Symlinks within any recovery
path cause refusal. Invalid manifests are logged and retained without cleanup. Project
root aliases remain supported. After commit, recovery retains the complete version
and its note record, and finishes any style append. Reordering assets after the project
commit would instead expose a project referencing files that do not exist yet.

## Stop, failure, and startup

Invalid arguments and unavailable lookups return to the model as tool results so
it can correct them. Image lookup retains its retry and fallback behavior. A fatal
render or project-write failure aborts the note and stops scheduling further tools,
including queued parallel calls. Stop waits for the engine child and process-tree cleanup and for
in-flight tools. After at most ten seconds, the note discards staging. A late worker
can only write into its old staging folder and cannot publish an aborted transaction.
Stop after the project rename leaves the committed version in place. A step limit
can still publish a valid partial edit with main's explanation that the note was
not finished.

Before final or draft-only output, every note path compares the staged project
with its initial snapshot, excluding root `version`, `notes`, `txnId`, `createdAt`
and `updatedAt`. It checks again after the engine updates the staged project and
before publication. An unchanged setter or an edit that was undone makes no
version and cannot claim a change. A no-change answer without attempted edits
retains the model's explanation or question. A preference without a project change
returns for consent instead of creating a video version to save it.

Startup kills recorded orphan engines before accepting jobs. If staging contains an
unpublished note, it saves the existing interrupted-change chat message even when
the app job record is missing. The message records the announced transaction IDs, so
retrying cleanup does not repeat it even if only some orphan folders remain. Only
the latest 50 transaction IDs are retained; older chat messages remain visible. The
committed version snapshot identifies notes that already published.
Recovery removes the whole `.staging` directory, including an empty one, and removes
version folders newer than `project.json.version`.
Publication also removes unpublished version folders before choosing the next number.
If the optional AI package has been removed since a note ran, the app keeps any
publication manifest and its staging for recovery after the package is restored.
It still starts without AI and cleans ordinary staging that has no publication intent.
The live app history in `app.json`, progress statistics, and diagnostic logs record
attempts even when the edit is unchanged; they are not part of the edit transaction.

## Threat model

The transaction covers process crashes or kills, Stop, engine failures, tool failures
including parallel tools, and manual edits or other jobs racing a note in the same app.
The same-app lock covers the final hash check through the commit and append. An AI
edit lock also prevents overlapping AI runs on one project.

User-created symlinks inside a project folder are outside this guarantee.
Injected disk I/O errors are outside this guarantee.
Another program editing project files mid-note is outside the same-app lock; the
base-hash check refuses a changed project file, with no further defense.

## Existing callers without the new options

Legacy engine behavior is unchanged. Final `render` writes `versions/vN/` and may
reuse the current folder for an unchanged edit. `cover` may replace that folder's
`cover.png`. Drafts and windows overwrite `versions/preview/`, and legacy `frames`
writes beside its input. First edits, manual rerenders, and export promotion still
use those paths. AI notes always use the explicit staged output contract.

Render results retain `version`, `preview`, `versionDir`, `file`, and `broll`.
A note returns `AgentResult.version` only after publication; it never falls back to
a draft when the final render fails.
