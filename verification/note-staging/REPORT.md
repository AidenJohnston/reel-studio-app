# Note-staging verification

Source/model sync: b2f302508c549de26f7871ec74667325256ee55d, PR #20. The runner checks the covered files against coverage.json before running TLC.

## Findings

- Literal property 1 fails before commit. NoteTransaction.publish moves a new asset into live work/assets/ at ai/src/note-staging.ts:159. A crash or Stop before the project rename leaves the old project plus that new file. Recovery removes staging and future versions, but not these assets or merged credits. literal-bytes.cfg and the actual-source probe reproduce it after recovery. Existing references remain valid; the live tree is not byte-equal to the old tree.
- Literal property 1 fails for project.json alone. The rename at ai/src/note-staging.ts:182 publishes the new project without the new note. The version snapshot contains the note at line 130. A crash before the second project write at line 188 leaves bytes different from both the old project and the completed successful project. project-bytes.cfg and the actual-source probe reproduce this. The video and referenced assets exist. docs/versions.md explicitly accepts the lost-note window; the requested byte-equality property does not.
- Global property 2 fails for legacy writers. cover_only chooses the current published folder when --out is absent and writes its cover.png at engine/reelengine/render.py:1084. runEngine takes the shared lock at app/src/main/index.ts:104, preventing interleaving but not rewriting. legacy-immutability.cfg includes this writer. Note-only publication does not rewrite a published folder. The source docs explicitly retain the legacy behavior.

These are findings against the stated requirements, not product changes. No dangling asset or version reference was found in the baseline model.

## Checked result

The final run explored 3,265,479 generated states and 675,633 distinct states in the baseline, to depth 86. The baseline invariants passed. The cache, writer-first lock, preview, hash, order, rewrite, and recovery mutants produced their named counterexamples. The two literal-equality checks and the legacy-writer check failed as documented above. The source rehearsal passed, including the real-source hash mutation and the two-orphan notice retry. The focused AI tests passed 14 tests, and the focused engine tests passed 3 tests.

The model is synchronized to b2f3025. It includes private cache snapshots before the version move and postcommit promotion of absent live keys. Promotion copies to a private scratch path, then renames into live work under the project lock. The cache safety invariant allows the old key to remain and a new key to appear only after commit. Mutants that overwrite an existing key or write the live key during the copy fail this invariant. Draft-only notes take a private preview-copy path and never publish. The source rehearsal also checks the staging grant and the CLI preview path.

## Checks and bounds

TLC v1.8.0, revision d2e1472, checks safety by exhaustive breadth-first traversal. TLA+ fits this task because the main question is ordering independent filesystem effects. It checks a model, not the TypeScript implementation.

The baseline contains one project, one note, one competing manual writer, one old version and one new version, two new files, two cache keys, one representative input/cache copy, four version-file classes, and one preview output. Each copy or ordinary write has absent, partial-prefix, and complete states. The note may fail or receive Stop, with one late staging write. Up to two process crashes include crashes during recovery. Two completed recovery passes run with no admitted writer between them. All finite reachable states are explored with no depth cutoff. Deadlock checking is disabled because terminal and failed operations may stop.

The manual writer models a shared-lock read-modify-write in separate read, partial temp write, full temp write, and rename steps. UI BUSY checks and the AI edit lock permit fewer schedules than the model. Two simultaneous full AI transactions are not modeled. There is no unbounded-writer or liveness proof.

The baseline checks reference consistency, note-only published-folder immutability, cache publication safety, stale-base rejection at the commit rename, publish exclusion, preview-only non-publication, preview grant cleanup, and recovery idempotence. Literal byte equality stays in separate failing cases. This separation prevents one known failure from hiding other checks.

The model assumes valid initial project JSON, a complete old version, unique transaction-prefixed asset names, successfully completed render outputs, one app process, same-volume rename semantics, and collision-free symbolic hashes. Preview access is a boolean grant; the app media protocol and range streaming are source-reviewed, not TLC-modeled. A content symbol represents a byte string. The model does not check parsers, media contents, UUID collisions, or SHA-256 collision resistance.

A process crash is not a machine power loss. Directory fsync and filesystem durability after power loss are not established. User-created symlinks, injected disk I/O errors, and external writes after the base check remain outside scope. Engine internals, every possible tool path, app logs, UI behavior, preferences, and multi-process locking are not formally verified. Cache/output routing is a source-reviewed assumption recorded by coverage digests.

## Source-to-action mapping

- BeginLock through BeginReturn map to beginNote. Project, input, and cache copies have partial states. cloneFile uses isolated copies or copy-on-write clones. One input and cache file represent the repeated copy loops.
- WorkCache, StageWrite, and the render/notes program counters represent applyStagedNote and staged runEngine calls. Existing live inputs are reads.
- PublishLock and CheckBase map to the publish lock and hash guard. PrepareAtomic models the snapshot and metadata temp writes followed by rename. One metadata file stands for render and verify metadata.
- Prune represents removeUnpublished on an initially clean version directory. Recovery separately models deletion of a version left by this note. Pre-existing orphan versions and a second publish reusing their number are not in this baseline.
- AssetRename moves one asset or thumbnail per atomic action. CreditsWrite has partial bytes in a live temporary file, followed by CreditsRename.
- VersionRename moves the prepared version folder in one same-volume rename. The project-write action prepares a partial/full temp. ProjectRename is the commit point. SetPublished follows the awaited rename.
- The style action, AppendWrite, and AppendRename keep the later project append separate. Preference writes are outside the disk projection.
- Stop, ToolFailure, AbortAtCheck, TimeoutRemove, MissingStaged, and LateStageWrite represent applyNote cleanup and its ten-second timeout. Cleanup deletes individual staged files while in-flight actions may run. Missing inputs after cleanup can terminate the operation without committing.
- WriterAcquire through WriterRename model projects:update and lock-using jobs. store.ts's per-file queue alone would not exclude the note publisher. jobs.ts admits one job synchronously and retains it until cleanup completes.
- Crash, Restart, and recovery actions map to startup after orphan engines are reaped. Recovery removes staged files individually, reads the live version, then removes each file of an unpublished newer version. The idempotence check compares the disk after the second complete pass with the first. A crash during recovery restarts that sequence.

Directory creation without new observable contents, locked reads, access checks, fsync, close, and promise bookkeeping stutter. None merges two live byte-changing filesystem calls into one atomic action. Recursive directory metadata, timestamps, permissions, and private temp filenames are abstracted.

## Mutation sensitivity

Each config changes one implementation choice and must produce the named counterexample. A passing mutant is a verification failure.

- broken-order publishes project.json before the version rename. The project points to a folder still in staging. ReferencesExist fails.
- broken-hash removes the base guard. A manual edit follows begin; the note commits over it. StaleNeverPublishes fails.
- broken-lock lets a writer bypass withProjectLock. It enters while the note owns publish. PublishExclusive fails.
- broken-cache aliases the live cache. A staged render changes live bytes before commit. CachePublicationSafe fails.
- broken-rewrite writes version metadata after publication. PublishedImmutable fails.
- broken-recovery returns after deleting one file of the newer version. The second recovery removes another file. RecoveryIdempotent fails.

Three inverse properties must also fail: a commit is reachable, two recovery passes are reachable, and a stale refusal is reachable. These prevent an always-aborting model from passing the safety checks.

## Reproduction

From the repository root:

    python3 verification/note-staging/run.py

Expected status is RESULT: FAIL for the findings above, exit 1. Use --self-test to validate all recorded outcomes while preserving that finding status in output. Use --case broken-order for one case. Full counterexamples are retained in the ignored results/ directory. source-probes.cjs executes copied real source, catches a deleted hash guard, then verifies restored source.

The runner pins the [official release asset](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) to SHA-256 5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2. The digest was verified against GitHub's asset metadata before execution.
