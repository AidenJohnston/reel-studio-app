---
name: verify-note-staging
description: Check note begin, staged work, publish ordering, Stop cleanup, cache promotion, shared project locks, and startup recovery with TLA+ and TLC. Use when any covered path changes or when reviewing the note transaction.
---

# Verify note staging

This skill checks a finite model of the filesystem protocol. A TLC pass is not a proof of TypeScript, Python, Electron, filesystem durability, or unbounded executions.

## Run the check

From the repository root, run:

    python3 verification/note-staging/run.py

The runner downloads the official TLA+ v1.8.0 jar if absent and checks its pinned SHA-256 before executing it. Java defaults to /opt/homebrew/opt/openjdk/bin/java; set TLC_JAVA on another machine.

Exit 1 means the current-source findings in REPORT.md reproduced. Exit 2 means a source mismatch or unexpected checker result. Use --self-test to validate every recorded pass and counterexample. It returns zero only when all expected outcomes match, while still printing RESULT: FAIL for the current findings. Do not describe that self-test as all requested properties passing.

TLC logs and a machine-readable summary go into verification/note-staging/results/. State databases use owned temporary directories and are deleted when TLC exits. Do not commit the jar, result logs, or states/.

## Confirm the source mapping before accepting results

Last confirmed source commit: b2f302508c549de26f7871ec74667325256ee55d. coverage.json records SHA-256 digests for the covered paths. The runner refuses any drift, including uncommitted edits.

- ai/src/note-staging.ts: withProjectLock, cloneFile, transferCompletedCaches, promoteCompletedCaches, beginNote, NoteTransaction.publish, discard, removeUnpublished, and recoverNoteStaging.
- ai/src/project.ts: writeFileAtomic, loadProject, and saveProject.
- ai/src/editor.ts: applyNote, bounded Stop wait, pending tool settlement, applyStagedNote, and the final publication call.
- ai/src/tools.ts: staged engine arguments, output and cache destinations, tool error handling, and render completion.
- ai/src/index.ts: AI edit serialization and withEditLock.
- app/src/main/index.ts: runEngine, projects:update, and startup ordering.
- app/src/main/store.ts: per-file queues, writeProject, listVersions, recoverInterrupted, and cleanPartialVersions.
- app/src/main/jobs.ts: per-project job admission, cancellation, completion, draft event ordering, and cleanup.
- app/src/main/ai.ts, app/src/main/project-engine.ts, app/src/main/staging-media.ts, app/src/main/live-video.ts, and app/src/main/media.ts: the shared lock, staged preview grant, media path check, and draft playback copy.
- ai/src/cli.ts: the draft-only no-publication path.
- engine/reelengine/cache.py and engine/reelengine/render.py: private cache inputs, post-only reuse, and output routing.
- engine/reelengine/render.py: staged output contract and the legacy cover writer used by the global-immutability counterexample.
- docs/versions.md: protocol and threat-model claims.

When a covered file changes, compare it with the sync commit. Inspect every changed write destination, await boundary, guard, lock lifetime, and recovery action. Read REPORT.md, update the model to describe the implementation, preserve the separate literal-byte and reference checks, refresh coverage.json and advance the sync commit here only after confirming correspondence, then rerun the full command and source rehearsal. For wider maintenance, use /maintain-formal-verification-skill.

## Interpret a counterexample

Open the named case log. Follow s.pc, s.disk, s.owner, s.abort, and s.recoveryPC through the trace. Match each changing field to REPORT.md.

A rename is indivisible only on the same volume. Copies and ordinary writes have absent, partial, and complete states. Recursive removal deletes one file per step. Directory creation, reads under the lock, fsync, close, and other operations that do not change a modeled observable may stutter. If a trace uses an impossible source schedule, correct the model. If the source can execute it, record a finding.

Property 3 uses the revised requirement: a note cannot write live caches before commit. After commit it may add only new keys through atomic renames. Do not restore the older blanket ban on every postcommit cache write.

## Rehearse against actual source

Run node verification/note-staging/source-probes.cjs after npm ci --ignore-scripts --no-audit --no-fund if needed. The probe copies the real TypeScript modules into an owned temporary directory, compiles them with the repository TypeScript compiler, runs stale-base and crash-boundary assertions, changes the scratch source hash guard to if (false), and checks that the mutant fails while restored source passes. It never edits tracked product files.

Also run python3 verification/note-staging/run.py --case broken-hash. TLC must fail StaleNeverPublishes. An unexpected result requires a source/model review before committing verification changes.
