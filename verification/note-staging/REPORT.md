# Note-staging verification

Source/model sync: `152e91318640523c1c8beb08e5b7eec7281c8388`, PR #20. `coverage.json` records the covered source digests. TLC checks a finite ordering model, not the TypeScript implementation.

## Property outcomes

| Property | Result within the bounds below |
| --- | --- |
| 1. Old or complete new edit | Pass after completed cleanup or startup recovery, with no intervening external edit. `project.json` contains the note at commit. References exist at every modeled step. Literal whole-tree equality immediately after a crash still fails before recovery. |
| 2. Published versions stay immutable | Pass for notes. The separate `cover_only` counterexample is accepted legacy behavior outside the note contract. |
| 3. Live cache writes | Pass. Only absent keys become live, after commit, through same-volume renames of complete private copies. |
| 4. Stale base never publishes | Pass with the shared lock and base-hash check. |
| 5. Writers cannot interleave inside publish | Pass for the note and one shared-lock writer. Both no-lock entry orders fail their mutants. |
| 6. Recovery is idempotent | Pass for two completed recovery passes, including a crash during repair. The actual-source two-orphan notice retry also passes. |
| External credits survive recovery | Pass for one completed external write while the process is down, before recovery resumes. Removing the credits hash guard fails. |

The recovered edit projection includes project bytes, assets, credits, and version contents. It excludes optional postcommit caches under revised property 3. The original whole-tree check remains separate and failing. This distinction preserves the requested property rather than silently moving its observation point.

## Findings and repaired counterexamples

- Immediate byte equality still fails at `ai/src/note-staging.ts:402`. Publish moves an asset into live `work/assets`, then the process crashes before the project rename. The old project now has an extra file. `literal-bytes.cfg` catches this. Startup uses the manifest to remove the file, so the recovered edit passes. No dangling reference results from this order. A crash after commit can also leave optional cache promotion incomplete, so whole-tree equality to a fully promoted successful run is stronger than the revised cache contract.
- The earlier permanent asset and credits leak is repaired. `recoverTransaction` removes manifest-listed assets at line 222 and restores the exact original credit bytes at lines 228 to 233 when the current credits hash matches the transaction's merged bytes. `broken-manifest` leaves an asset after recovery. `broken-credits` leaves merged credits behind. Both fail recovered equality.
- The earlier lost-note window is repaired. The note enters the prepared project bytes before the atomic rename at line 413. `broken-append` restores the old order: project commits without its note, then crashes before the later append. Live project bytes differ from both complete alternatives.
- Recovery preserves newer credits at line 228. In the new scenario, the note moves merged credits, crashes, and another process finishes a different credit-book write before startup. Recovery removes the abandoned note's assets but retains the newer credit bytes. `broken-credits-guard` removes that condition and restores stale original bytes over the external edit.
- `engine/reelengine/render.py:1185` retains legacy `cover_only`, which can overwrite the current published cover. The lock prevents interleaving, not rewriting. `legacy-immutability` records this accepted exception without treating it as a note defect.

The external-write guarantee is deliberately narrow. The source reads the credit hash and later renames the restored file. An external writer during that interval is outside the stated scenario and the same-app lock.

## Source-to-action mapping

- `BeginLock` through `BeginReturn` map to `beginNote`. Copies of the project, representative input, and cache have partial and complete states. Copy-on-write clones share storage, not writable file identity.
- `StageWrite`, `WorkCache`, and the render state represent staged tools and output routing. One partial export represents either rendering or post-only media copying. Actual post-only reuse selection is covered by engine tests.
- `GrantPreview`, `PreviewCopy`, and `RevokePreview` represent job access, CLI draft-only output, and access revocation before cleanup. Canonical path containment is checked in source and app tests, not as a path parser in TLC.
- `PublishLock` and `CheckBase` map to `withProjectLock` and the live-project hash guard. `SnapshotCache` moves completed private caches into the prepared version before publication.
- `PrepareWrite`, `PrepareSync`, and `PrepareRename` model independent staged-file preparation at `ai/src/note-staging.ts:393`. Five representative files each pass through partial bytes, complete bytes, file sync, and rename. The metadata class abstracts repeated render, verify, normalized notes, and optional style-intent files. The all-settled barrier precedes `staging-sync` at line 395. It does not combine these writes into one atomic step.
- `Prune` represents `removeUnpublished` with an initially clean version directory. `AssetRename`, `CreditsRename`, `VersionRename`, and `ProjectRename` map to lines 402, 406, 410, and 413. Each is a separate same-volume rename. `project-sync` represents line 415.
- `PromoteSelect`, `PromoteCopy`, and `PromoteRename` map to `promoteCompletedCaches` at line 104. The lock spans the absent-key check and rename. A partial copy remains private. Cache completion is optional after the edit commits.
- `Stop`, `ToolFailure`, `AbortAtCheck`, and `Timeout` represent cancellation and fatal work failure. `discard` acquires the project lock. A publish abort calls `discardLocked` while still holding it. One representative late worker write can recreate private staging after timeout, but cannot publish.
- `RecoveryInspect` assumes a manifest produced by this publisher. The source validates the full manifest and rejects symlinks before deleting anything in that transaction. Invalid input refusal is covered by actual AI tests, not by a TLC parser model.
- `RecoveryAsset` deletes one asset per step. `RecoveryCreditsStart` compares current bytes to merged bytes. Restoration has partial write, full write, file sync, private rename, and live rename steps. `RecoveryVersion` removes unpublished version files individually. The manifest remains until repair finishes.
- `RecoveryStaging` deletes installed private files one at a time in a fixed order after repair. `RecoveryPrepared` deletes any unfinished preparation temp files individually. This removes equivalent deletion permutations, not live mutations. Startup then removes unpublished versions. The second recovery compares its disk projection with the first.
- `ExternalCreditsWrite` represents one completed external credit update while down, with no write during active recovery. `WriterAcquire` through `WriterRename` separately model one same-app shared-lock read-modify-write. `PublishExclusive` checks both active states directly and records overlap on either lock-entry order.
- Style replay from the immutable version maps to a stuttering action because preferences are outside the edit projection. The actual AI test checks idempotent rule replay. App interruption notices are also source-tested separately, including the 50-ID cap.

Read-only awaits, close, and directory creation without modeled contents stutter. Directory sync has an explicit ordering step, but this process-crash model does not infer machine-power-loss durability. Empty directories, permissions, timestamps, and private temporary names are outside byte equality.

## Bounds and assumptions

The baseline has one project, one note, one competing manual writer, one old version, one new version, two new files, two cache keys, six version-file classes, five prepared-file classes, one input copy, and one preview output. Bytes are opaque symbols. Copies and ordinary writes have absent, partial-prefix, and complete states. The baseline and recovered-equality run allow two process crashes, including crashes during recovery, and two completed recovery passes. There is no depth cutoff. Deadlock checking is disabled because failed and terminal operations may stop.

Exact equality uses no competing manual writer. The external-credit scenario uses one external write instead of the manual writer. It admits that write after the initial crash or a crash during the first recovery, but not between completed recovery passes. Its credits invariant applies immediately after the write and remains checked thereafter.

The model assumes a valid initial project, a complete old version, an existing original credits file, a valid publisher-produced manifest, unique transaction-prefixed filenames, same-volume atomic renames, collision-free symbolic hashes, one app process, and the AI package available for recovery. Absent original credits use a deletion branch in source and are not a separate TLC case. Other processes, malformed manifests, symlinks, and arbitrary external edits are outside the baseline. The one external-credits case is the explicit extension described above.

No unbounded proof, liveness proof, or simultaneous pair of full AI transactions is claimed. Pre-existing orphan versions and a later publish reusing their number are outside this baseline. Injected disk I/O errors remain outside the documented threat model. The checks do not verify media contents, parsers, every tool implementation, UI behavior, logs, app history as a whole, or power-loss durability. Source digests detect changes that require a model review.

## Mutation sensitivity

Every mutant must fail its named invariant. A surviving mutant makes the runner fail with an unexpected result.

| Mutant | Counterexample |
| --- | --- |
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

Six inverse properties establish reachable commit, stale refusal, two recovery passes, cache promotion, preview output, and an external credits write. TLC must refute them so that an always-aborting model cannot pass silently.

## Evidence and reproduction

The full 28-case suite matched all recorded outcomes against `152e913`. The baseline explored 1,141,266 generated states and 819,662 distinct states to depth 101. Recovered equality explored 404,449 distinct states. External-credit preservation explored 804,336 distinct states. All 15 mutants produced their named counterexamples, and all six reachability witnesses were reached. The literal-equality finding and accepted legacy exception reproduced.

From the repository root:

```sh
env -u CLIPROXY_API_KEY python3 verification/note-staging/run.py
```

The normal run returns `RESULT: FAIL`, exit 1, for the retained immediate-byte-equality finding. `--self-test` returns zero when all recorded outcomes match, without changing that finding. `--case broken-manifest` runs one case. Logs and counterexamples stay in ignored `verification/note-staging/results/`. State databases use temporary directories deleted at checker exit.

The runner uses TLC v1.8.0, revision d2e1472, breadth-first search, one worker, fingerprint polynomial 0, and seed 1. It verifies the [official release asset](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) against SHA-256 `5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2` before execution. Java defaults to `/opt/homebrew/opt/openjdk/bin/java`. The jar and state directories are ignored.

`source-probes.cjs` compiles copies of real modules in temporary directories. It checks crash-boundary rollback, exact CRLF credit bytes, committed-note equality, external-credit preservation, stale refusal, and two-orphan notice retry. Scratch mutants remove the manifest, delay the note append, remove the credits guard, restore old notice deduplication, and remove the base-hash guard. The source assertions reject each mutant. Tracked product files are unchanged.

Focused product checks use the same unset environment variable:

- AI `note-staging`, `cache-continuity`, and `note-tools`: 20 tests passed, including malformed manifest refusal, symlink refusal, credits ownership, style replay, and Stop ordering.
- App `live`, `project-engine`, and `ai-optional`: 13 tests passed. Filtered store recovery tests: 4 passed, 15 unrelated tests skipped.
- Engine `test_post_only_reuse`, `test_private_cache`, and `test_staged_cache`: 4 passed with `PYTHONPATH=engine` and the isolated Python 3.11 dependencies. The first invocation lacked that import path and failed the subprocess import; the corrected invocation passed.
