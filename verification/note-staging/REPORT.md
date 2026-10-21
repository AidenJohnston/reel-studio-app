# Note-staging verification

Source/model sync: `cf379c5404e4c3cfb1156991f3b97959c43d2ed7`, PR #20. `coverage.json` records the covered source digests. TLC checks a finite ordering model, not the TypeScript implementation.

## Property outcomes

| Property | Result within the bounds below |
| --- | --- |
| 1. Recovered edit equality and reference consistency | Pass. After recovery, the live project is byte-identical to before the note or is the complete new version. The project never references a missing file. This uses the edit projection and assumptions below, with no intervening external edit. |
| 2. Published versions stay immutable | Pass for notes. The separate `cover_only` counterexample is accepted legacy behavior outside the note contract. |
| 3. Live cache writes | Pass. Only absent keys become live, after commit, through same-volume renames of complete private copies. |
| 4. Stale base never publishes | Pass with the shared lock and base-hash check. |
| 5. Writers cannot interleave inside publish | Pass for the note and one shared-lock writer. Both no-lock entry orders fail their mutants. |
| 6. Recovery is idempotent | Pass for two completed recovery passes, including a crash during repair. The actual-source two-orphan notice retry also passes. |
| Immediate byte equality before recovery | Expected failure, checked separately by `literal-bytes.cfg`. |
| Mixed valid and invalid orphans | Pass. The valid transaction recovers in either visit order. The invalid transaction and unrelated version files remain intact. |
| External credits survive recovery | Pass for one completed external write while the process is down, before recovery resumes. Removing the credits hash guard fails. |

The recovered edit projection includes project bytes, assets, credits, and version contents. It excludes optional postcommit caches under revised property 3. Property 1 combines `RecoveredOldOrCompleteNew` with `ReferencesExist`. The separately named property **Immediate byte equality before recovery** uses `OldOrCompleteNew` in `literal-bytes.cfg` and is expected to fail.

## Expected failures and regression counterexamples

- Immediate byte equality before recovery fails at `ai/src/note-staging.ts:428`. Publish moves an asset into live `work/assets`, then the process crashes before the project rename. The old project now has an extra file. `literal-bytes.cfg` catches this. The next startup uses the manifest to remove the file, so property 1 passes. This temporary difference is inherent in moving assets before the project commit: it prevents the project from referencing files that do not exist yet. A crash after commit can also leave optional cache promotion incomplete, so whole-tree equality to a fully promoted successful run is stronger than the revised cache contract.
- The earlier permanent asset and credits leak is repaired. `recoverTransaction` removes manifest-listed assets at line 237 and restores the exact original credit bytes at lines 243 to 249 when the current credits hash matches the transaction's merged bytes. `broken-manifest` leaves an asset after recovery. `broken-credits` leaves merged credits behind. Both fail recovered equality.
- The earlier lost-note window is repaired. The note enters the prepared project bytes before the atomic rename at line 439. `broken-append` restores the old order: project commits without its note, then crashes before the later append. Live project bytes differ from both complete alternatives.
- Recovery preserves newer credits at line 243. In the new scenario, the note moves merged credits, crashes, and another process finishes a different credit-book write before startup. Recovery removes the abandoned note's assets but retains the newer credit bytes. `broken-credits-guard` removes that condition and restores stale original bytes over the external edit.
- `engine/reelengine/render.py:1185` retains legacy `cover_only`, which can overwrite the current published cover. The lock prevents interleaving, not rewriting. `legacy-immutability` records this accepted exception without treating it as a note defect.

The external-write guarantee is deliberately narrow. The source reads the credit hash and later renames the restored file. An external writer during that interval is outside the stated scenario and the same-app lock.

## Source-to-action mapping

- `BeginLock` through `BeginReturn` map to `beginNote`. Copies of the project, representative input, and cache have partial and complete states. Copy-on-write clones share storage, not writable file identity.
- `StageWrite`, `WorkCache`, and the render state represent staged tools and output routing. One partial export represents either rendering or post-only media copying. Actual post-only reuse selection is covered by engine tests.
- `GrantPreview`, `PreviewCopy`, and `RevokePreview` represent job access, CLI draft-only output, and access revocation before cleanup. Canonical path containment is checked in source and app tests, not as a path parser in TLC.
- `PublishLock` and `CheckBase` map to `withProjectLock` and the live-project hash guard. `SnapshotCache` moves completed private caches into the prepared version before publication.
- `PrepareWrite`, `PrepareSync`, and `PrepareRename` model independent staged-file preparation at `ai/src/note-staging.ts:419`. Five representative files each pass through partial bytes, complete bytes, file sync, and rename. The metadata class abstracts repeated render, verify, normalized notes, and optional style-intent files. The all-settled barrier precedes `staging-sync` at line 421. It does not combine these writes into one atomic step.
- `Prune` represents `removeUnpublished` with an initially clean version directory. `AssetRename`, `CreditsRename`, `VersionRename`, and `ProjectRename` map to lines 428, 432, 436, and 439. Each is a separate same-volume rename. `project-sync` represents line 441.
- `PromoteSelect`, `PromoteCopy`, and `PromoteRename` map to `promoteCompletedCaches` at line 104. The lock spans the absent-key check and rename. A partial copy remains private. Cache completion is optional after the edit commits.
- `Stop`, `ToolFailure`, `AbortAtCheck`, and `Timeout` represent cancellation and fatal work failure. `discard` acquires the project lock. A publish abort calls `discardLocked` while still holding it. One representative late worker write can recreate private staging after timeout, but cannot publish.
- `RecoveryInspect` assumes a manifest produced by this publisher. The source validates the full manifest and rejects symlinks before deleting anything in that transaction. Invalid input refusal is covered by actual AI tests, not by a TLC parser model.
- `RecoveryAsset` deletes one asset per step. `RecoveryCreditsStart` compares current bytes to merged bytes. Restoration has partial write, full write, file sync, private rename, and live rename steps. `RecoveryVersion` removes unpublished version files individually. The manifest remains until repair finishes.
- `RecoveryStaging` deletes installed private files one at a time in a fixed order after repair. `RecoveryPrepared` deletes any unfinished preparation temp files individually. This removes equivalent deletion permutations, not live mutations. Startup then removes unpublished versions. The second recovery compares its disk projection with the first.
- `ExternalCreditsWrite` represents one completed external credit update while down, with no write during active recovery. `WriterAcquire` through `WriterRename` separately model one same-app shared-lock read-modify-write. `PublishExclusive` checks both active states directly and records overlap on either lock-entry order.
- Style replay from the immutable version maps to a stuttering action because preferences are outside the edit projection. The actual AI test checks idempotent rule replay. App interruption notices are also source-tested separately, including retention until the corresponding folder is gone.

Read-only awaits, close, and directory creation without modeled contents stutter. Directory sync has an explicit ordering step, but this process-crash model does not infer machine-power-loss durability. Empty directories, permissions, timestamps, and private temporary names are outside byte equality.

`OrphanRecovery.tla` models `recoverNoteStaging` at lines 279 to 290 separately from publication. It starts with one valid and one invalid orphan, explores both visit orders, and checks preservation after every step. Validation refusal returns to the scan. Valid recovery checks the parent before each single-file unlink, removes version and staging contents one file at a time, then removes the valid folder. Any refusal skips the general version sweep and retains `.staging`. The module permits two crashes and two completed recovery passes, with no depth cutoff. Valid transaction v2 and an unrelated v3 have disjoint contents. `ValidRecovered` must hold after a completed pass, and a reachability witness requires two completed passes to be possible. This is a safety check on completed passes, not a liveness proof.

The main publication model is unchanged. On stable paths, the additional parent checks are reads and single-file `unlink` matches its existing one-file deletion action. Directory-sync success, unsupported sync, and logged postcommit errors leave the same modeled disk state. Fatal precommit directory errors take the existing discard/repair outcome, represented by cancellation before the next live write. Nine actual-source fault cases check the error dispatch: only sync-call `EINVAL` and `ENOTSUP` continue before commit, other open/sync/close errors abort before commit, and postcommit errors preserve successful publication. Concurrent path replacement and general injected I/O faults remain outside the formal bounds.

## Bounds and assumptions

The baseline has one project, one note, one competing manual writer, one old version, one new version, two new files, two cache keys, six version-file classes, five prepared-file classes, one input copy, and one preview output. Bytes are opaque symbols. Copies and ordinary writes have absent, partial-prefix, and complete states. The baseline and recovered-equality run allow two process crashes, including crashes during recovery, and two completed recovery passes. There is no depth cutoff. Deadlock checking is disabled because failed and terminal operations may stop.

Exact equality uses no competing manual writer. The external-credit scenario uses one external write instead of the manual writer. It admits that write after the initial crash or a crash during the first recovery, but not between completed recovery passes. Its credits invariant applies immediately after the write and remains checked thereafter.

The model assumes a valid initial project, a complete old version, an existing original credits file, a valid publisher-produced manifest, unique transaction-prefixed filenames, same-volume atomic renames, collision-free symbolic hashes, one app process, and the AI package available for recovery. Absent original credits use a deletion branch in source and are not a separate TLC case. Other processes, malformed manifests, symlinks, and arbitrary external edits are outside the publication baseline. The separate orphan model abstracts manifest validation as valid or invalid; it does not verify the parser. The one external-credits case is the explicit extension described above.

No unbounded proof, liveness proof, or simultaneous pair of full AI transactions is claimed. Pre-existing orphan versions and a later publish reusing their number are outside this baseline. Injected disk I/O errors remain outside the documented threat model. The checks do not verify media contents, parsers, every tool implementation, UI behavior, logs, app history as a whole, or power-loss durability. Source digests detect changes that require a model review.

## Mutation sensitivity

Every mutant must fail its named invariant. A surviving mutant makes the runner fail with an unexpected result.

| Mutant | Counterexample |
| --- | --- |
| `broken-orphan-return` | Return at the invalid transaction. A valid transaction later in the scan remains unrecovered. |
| `broken-orphan-delete` | Delete a file from the refused transaction. Its bytes no longer match the initial state. |
| `broken-orphan-sweep` | Run the general version sweep despite refusal. An unrelated future version is deleted. |
| `broken-order` | Commit project before version rename. A referenced version is missing. |
| `broken-manifest` | Omit manifest. Crash after an asset move. Recovery leaves the asset live. |
| `broken-append` | Append the note after commit. Crash in between. The committed project lacks its note. |
| `broken-credits` | Skip credits restoration. Recovery leaves merged credits with the old project. |
| `broken-credits-guard` | Ignore current credits hash. Recovery overwrites an external edit. |
| `broken-hash` | Ignore stale base. A manual edit occurs after begin, then the note publishes over it. |
| `broken-lock`, `broken-lock-writer-first` | Bypass the lock. Writer and publisher overlap in either entry order. |
| `broken-cache` | Alias live cache during work. A note changes it before commit. |
| `broken-cache-overwrite` | Promote over an existing key. The note rewrites a live cache entry. |
| `broken-cache-copy` | Copy directly into live cache. A partial cache entry becomes visible. |
| `broken-rewrite` | Change published version metadata after commit. |
| `broken-recovery` | Return after deleting one unpublished-version file. A second recovery changes disk again. |
| `broken-preview-publish` | Let draft-only execution publish. |
| `broken-preview-grant` | Keep preview access after cleanup starts. |

Seven inverse properties establish reachable commit, stale refusal, two recovery passes in each model, cache promotion, preview output, and an external credits write. TLC must refute them so that an always-aborting model cannot pass silently.

## Evidence and reproduction

The full 33-case suite matched all recorded outcomes against `cf379c5`. The baseline explored 1,141,266 generated states and 819,662 distinct states to depth 101. Recovered equality explored 404,449 distinct states. External-credit preservation explored 804,336 distinct states. Mixed-orphan recovery explored 521 distinct states. All 18 mutants produced their named counterexamples, and all seven reachability witnesses were reached. The expected immediate-equality failure and accepted legacy exception reproduced.

From the repository root:

```sh
env -u CLIPROXY_API_KEY python3 verification/note-staging/run.py
```

The default run returns `RESULT: PASS`, exit 0, when every outcome matches its recorded expectation, including expected failures. A mismatch or source/checker error returns non-zero. `--self-test` remains a compatibility alias for the default behavior. `--case broken-manifest` runs one case. Logs and counterexamples stay in ignored `verification/note-staging/results/`. State databases use temporary directories deleted at checker exit.

The runner uses TLC v1.8.0, revision d2e1472, breadth-first search, one worker, fingerprint polynomial 0, and seed 1. It verifies the [official release asset](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) against SHA-256 `5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2` before execution. Java defaults to `/opt/homebrew/opt/openjdk/bin/java`. The jar and state directories are ignored.

`source-probes.cjs` compiles copies of real modules in temporary directories. It checks crash-boundary rollback, exact CRLF credit bytes, committed-note equality, external-credit preservation, stale refusal, two-orphan notice retry, mixed valid/invalid orphans, and directory-sync error handling. Scratch mutants remove the manifest, delay the note append, remove the credits guard, restore old notice deduplication, remove the base-hash guard, return early on an invalid orphan, delete a refused transaction, and bypass the refused-version-sweep guard. The source assertions reject each mutant. Tracked product files are unchanged.

Focused product checks use the same unset environment variable:

- AI `note-staging`, `cache-continuity`, and `note-tools`: 23 tests passed, including malformed manifest refusal, symlink refusal, credits ownership, style replay, and Stop ordering.
- App `live`, `project-engine`, and `ai-optional`: 13 tests passed. Filtered store recovery tests: 4 passed, 15 unrelated tests skipped. The new 51-folder case first took the package-absent fallback and failed; after `npm run build -w ai`, the installed-package run passed.
- Engine `test_post_only_reuse`, `test_private_cache`, and `test_staged_cache`: 4 passed with `PYTHONPATH=engine` and the isolated Python 3.11 dependencies. The first invocation lacked that import path and failed the subprocess import; the corrected invocation passed.
