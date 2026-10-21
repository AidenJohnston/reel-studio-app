---
name: verify-note-staging
description: Check note begin, staged work, publish ordering, Stop cleanup, cache promotion, shared project locks, and startup recovery with TLA+ and TLC. Use when any covered path changes or when reviewing the note transaction.
---

# Verify note staging

This skill checks a finite model of the filesystem protocol. A TLC pass is not a proof of TypeScript, Python, Electron, filesystem durability, or unbounded executions.

## Run the check

From the repository root, run:

    env -u CLIPROXY_API_KEY python3 verification/note-staging/run.py

The runner downloads the official TLA+ v1.8.0 jar if absent and checks its pinned SHA-256 before executing it. Java defaults to /opt/homebrew/opt/openjdk/bin/java; set TLC_JAVA on another machine.

The default command exits 0 and prints RESULT: PASS when every recorded expectation matches, including expected failures. A source mismatch, source rehearsal failure, or unexpected checker result exits non-zero. --self-test is a compatibility alias for the default behavior. An expected invariant violation remains a counterexample, even when the suite succeeds.

TLC logs and a machine-readable summary go into verification/note-staging/results/. State databases use owned temporary directories and are deleted when TLC exits. Do not commit the jar, result logs, or states/.

## Confirm the source mapping before accepting results

Last confirmed source commit: 152e91318640523c1c8beb08e5b7eec7281c8388. coverage.json records SHA-256 digests for the covered paths. The runner refuses any drift, including uncommitted edits.

- ai/src/note-staging.ts: withProjectLock, cloneFile, transferCompletedCaches, promoteCompletedCaches, beginNote, NoteTransaction.publish, discardLocked, parseManifest, syncDirectory, recoverTransaction, removeUnpublished, and recoverNoteStaging.
- ai/src/style.ts: idempotent rule replay from the immutable version.
- ai/src/project.ts: writeFileAtomic, loadProject, and saveProject.
- ai/src/editor.ts: applyNote, bounded Stop wait, pending tool settlement, applyStagedNote, and the final publication call.
- ai/src/tools.ts: staged engine arguments, output and cache destinations, tool error handling, and render completion.
- ai/src/index.ts: AI edit serialization and withEditLock.
- app/src/main/index.ts: runEngine, projects:update, and startup ordering.
- app/src/main/store.ts: per-file queues, writeProject, listVersions, recoverInterrupted, and cleanPartialVersions.
- app/src/main/jobs.ts: per-project job admission, cancellation, completion, draft event ordering, and cleanup.
- app/src/main/ai.ts, app/src/main/project-engine.ts, app/src/main/staging-media.ts, app/src/main/live-video.ts, and app/src/main/media.ts: the shared lock, staged preview grant, media path check, and draft playback copy.
- ai/src/cli.ts: the draft-only no-publication path.
- engine/reelengine/cache.py, engine/reelengine/assets.py, and engine/reelengine/render.py: private cache inputs, post-only reuse, and output routing.
- engine/reelengine/render.py: staged output contract and the legacy cover writer used by the global-immutability counterexample.
- docs/versions.md: protocol and threat-model claims.

When a covered file changes, compare it with the sync commit. Inspect every changed write destination, await boundary, guard, lock lifetime, and recovery action. Read REPORT.md, update the model to describe the implementation, preserve the separate literal-byte and reference checks, refresh coverage.json and advance the sync commit here only after confirming correspondence, then rerun the full command and source rehearsal. For wider maintenance, use /maintain-formal-verification-skill.

## Interpret a counterexample

Open the named case log. Follow s.pc, s.disk, s.owner, s.abort, and s.recoveryPC through the trace. Match each changing field to REPORT.md.

A rename is indivisible only on the same volume. Copies and ordinary writes have absent, partial, and complete states. Recursive removal deletes one file per step. Directory creation, reads under the lock, close, and other operations that do not change a modeled observable may stutter. Prepared file syncs and the staging/project directory syncs have explicit steps. These establish ordering, not a power-loss guarantee. If a trace uses an impossible source schedule, correct the model. If the source can execute it, record a finding.

Property 3 uses the revised requirement: a note cannot write live caches before commit. After commit it may add only new keys through atomic renames. Do not restore the older blanket ban on every postcommit cache write.

Property 1 requires the live project after recovery to be byte-identical to before the note or the complete new version, with no missing references at any step. Recovered edit equality and reference consistency pass within the documented projection and bounds. The separate property "Immediate byte equality before recovery" is expected to fail between an asset move and recovery. Preserve both checks when updating this model. The `cover_only` immutability failure is the accepted legacy exception, not a note defect.

The external-credit case permits one completed write while the process is down, before recovery resumes. It checks that conditional rollback preserves those bytes. It does not permit an external writer during the recovery hash-read/rename interval. Valid publisher-generated manifests are assumed in TLC. Malformed manifests and symlink refusal are checked by `ai/test/note-staging.test.ts`. Run those tests when changing validation. App notice tests cover the 50-ID retention limit separately.

## Rehearse against actual source

Run `env -u CLIPROXY_API_KEY node verification/note-staging/source-probes.cjs`. Install repository dependencies with `npm ci --ignore-scripts --no-audit --no-fund` if TypeScript is missing. The full runner includes this rehearsal.

The probe compiles copies of the real TypeScript modules in an owned temporary directory. It checks stale refusal, exact credits rollback, committed-note bytes, external-credit preservation, and the two-orphan notice retry. Scratch mutants omit the manifest, append the note after commit, remove the credits hash guard, restore the old notice dedupe, and remove the base-hash guard. Each must trigger its behavioral assertion. Tracked product files remain untouched.

Also run `env -u CLIPROXY_API_KEY python3 verification/note-staging/run.py --case broken-hash`. TLC must fail StaleNeverPublishes. An unexpected result requires a source/model review before committing verification changes.
