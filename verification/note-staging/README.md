# Check note staging

From the repository root, with Python 3, Java, Node.js, and the repository's npm dependencies installed, run:

```sh
env -u CLIPROXY_API_KEY python3 verification/note-staging/run.py
```

The runner downloads the official TLC v1.8.0 jar into `tools/` and verifies its pinned SHA-256 before execution. Set `TLC_JAVA` to your Java executable if needed. It defaults to `/opt/homebrew/opt/openjdk/bin/java`, then falls back to `java` on PATH.

Exit 0 means all recorded outcomes matched, including expected counterexamples. Source drift, a failed source rehearsal, or an unexpected TLC result exits non-zero. `--self-test` is an alias; `--case broken-hash` runs one case. Logs and `summary.json` go into ignored `verification/note-staging/results/`. The runner deletes temporary TLC state databases after each case.

## Update the model after a source change

`coverage.json` lists covered source files and their SHA-256 digests, with the reviewed commit in `syncCommit`. Before running checks, the runner hashes each file's current bytes. A missing file or any difference, including uncommitted edits, stops the run. This detects drift; it does not prove that the model matches the implementation.

Compare changed files with `syncCommit` and use the [source-to-action mapping](REPORT.md#source-to-action-mapping) to review the affected steps:

- In `NoteStaging.tla`, update write destinations, partial copies, syncs, rename order, base-hash guards, lock lifetimes, cancellation, and preview access. Keep manifest preparation before live writes, version installation before project commit, and cache promotion after commit with new keys only.
- Update recovery steps for asset removal, conditional credits restoration, and interrupted cleanup. In `OrphanRecovery.tla`, preserve invalid transactions while valid ones recover in either scan order. Model parent checks separately from deletion.
- Adjust configs, `suite.json`, and `source-probes.cjs` when behavior or bounds change. Preserve counterexamples and reachability checks. Only same-volume renames are atomic; copies and recursive deletion require intermediate steps.

After reviewing correspondence, refresh affected digests and `syncCommit`, update the report, and rerun the full command. The source rehearsal uses temporary copies of real modules. For app recovery tests, build the AI package first with `npm run build -w ai` so they exercise installed-package recovery.

## Read expected failures

- `literal-bytes`: an asset can remain live after a crash until startup recovery removes it. Immediate byte equality fails; recovered equality and reference consistency must pass.
- `legacy-immutability`: legacy `cover_only` rewrites a published cover. This is an accepted exception outside the note contract.
- `broken-*`: deliberately damaged protocols must violate their named invariants. The [mutation table](REPORT.md#mutation-sensitivity) explains each counterexample. A surviving mutant fails the suite.
- `witness-*`: inverted assertions must fail to demonstrate reachable commit, recovery, stale refusal, cache promotion, preview, and external-credit states.

See [REPORT.md](REPORT.md) for bounds and findings. These finite checks do not prove the full implementation, unbounded behavior, or power-loss durability.
