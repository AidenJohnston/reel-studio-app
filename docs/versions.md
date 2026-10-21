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
The app keeps playing the published video while the note runs. A post-text-only edit
also renders a new version; this implementation does not reuse encoded media.

At the start of a note, completed voice, music-mix, b-roll, and cover caches are
cloned from live `work/` with `COPYFILE_FICLONE`. APFS shares the file data until a
write; other filesystems fall back to a separate copy. No hard links are used.
The clones retain timestamps for freshness checks, and partial files are skipped.
Notes write only their clones and never refresh the live caches. Cache keys use
project-relative input names or content hashes, so moving work into staging does
not invalidate it. Generated voice audio uses a content hash because restoring a
timestamp through Node can lose nanosecond precision. Existing voice, music, and
b-roll caches with older keys can still be read; cover code changes retain the
existing rule that invalidates cached covers.

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
2. Move new assets and thumbnails into their live folders. Their unique names are
   not referenced by the old edit. Existing files cannot be replaced. Same-volume
   renames preserve the exact timestamps recorded in `assets.json`, so an unchanged
   manual rerender reuses the version just published.
3. Atomically replace the credit book, preserving existing entries and adding only
   this note's new asset credits.
4. Rename the complete staged version folder to `versions/vN+1/`.
5. Rename a prepared temporary project file over the live `project.json`. This is
   the commit point and the last live write before the append step.
6. Append saved style rules and the note record with `notes[].txnId`. A crash before
   this step finishes may lose preferences or the live note record; the published
   version's project snapshot already contains the record.

The staged snapshot and `notes.md` are prepared before the version folder moves.
Notes never rewrite a published version folder. The app shows only versions at or
below the number recorded in the live project. A crash before the commit can leave
unreferenced assets and credit entries, or an unpublished version folder, but the
old edit still reads its original files.

## Stop, failure, and startup

A failed tool aborts the note and stops scheduling further tools, including queued
parallel calls. Stop waits for the engine child and process-tree cleanup and for
in-flight tools. After at most ten seconds, the note discards staging. A late worker
can only write into its old staging folder and cannot publish an aborted transaction.
Stop after the project rename leaves the committed version in place.

Startup kills recorded orphan engines before accepting jobs, removes every
`.staging/*` folder, and removes version folders newer than `project.json.version`.
Publication also removes unpublished version folders before choosing the next number.
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
