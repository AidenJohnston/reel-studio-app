# Measure the real Reel Studio app

Run from this checkout on macOS with Node, npm, Python 3.11, and uv available. The installed app supplies only read-only FFmpeg binaries. The runner never launches the installed app.

```sh
node scripts/perf/run.mjs --ref origin/main --runs 3 --long --note --models /path/to/existing/small.en
node scripts/perf/run.mjs --ref fork/cover-frame-streaming --runs 3 --long --note --models /path/to/existing/small.en
node scripts/perf/run.mjs --compare origin/main fork/cover-frame-streaming
```

Fetch the branch before measuring it. Each result records its resolved commit SHA. The runner does not fetch or move branches.

For interleaved comparisons with a new build, venv, and Node process for every run, use:

```sh
node scripts/perf/suite.mjs --runs 3 --note --models /path/to/existing/small.en origin/main fork/cover-frame-streaming
```

The suite runs one ref at a time in each round, cleans it, then starts the next ref. It retains each round's raw reports and writes combined medians to the usual ref directory. A resource stop ends the suite with an error. Only fully completed, cleaned results can be compared.

The suite pins each ref's SHA before starting. Add `--resume` to reuse its completed rounds at those pinned SHAs after an interruption. The suite validates the cached workload and dependencies before combining it. Inspect the owning PID before removing a stale `.suite-lock` after SIGKILL.

`--models` points to an existing CTranslate2 small.en directory containing model.bin, config.json, and tokenizer.json. It is linked read-only by convention into scratch. No model download or AI sign-in occurs. The model binary and input clips are SHA-256 hashed in the report. `REELSTUDIO_PERF_MODEL` can supply this path instead.

The default fixture is `~/Downloads/Video/aiden-v1-new.mp4`. `--long` also runs `~/Downloads/Video/IMG_7303.mov`. The runner copies each clip before importing it into a new project. `--python` selects the Python 3.11 executable. `--ffmpeg-dir` overrides the default `/Applications/Reel Studio.app/Contents/Resources/ffmpeg`.

Use `--clip long` to run only IMG_7303, including through suite.mjs. `--adopt-model` starts with an empty model folder and a scratch Hugging Face cache linked to the supplied weights. It calls the ref's real model.find API, requires successful adoption, and independently hashes the copied model. It never requests a model download. This option requires a ref with the pinned-model reuse API.

Results go to `/tmp/rs-perf-harness/<ref>/`, with slashes in the ref replaced by underscores. `results.json` and `REPORT.md` contain medians and full observed ranges. Each run also has JSON telemetry and a screenshot. Repeating a ref replaces its reports. Keep a copy to retain an older experiment.

## What the measurements mean

- Cold startup starts before Playwright launches Electron. It ends when clicking New video opens that screen. The process, app profile, and engine cache are new. OS file caches remain warm.
- First edit starts before setting the real file input. It ends after the job reports success and the Reel video has decoded. The real AI package uses its no-AI basic plan.
- Phase spans use the app's successive job phase transitions. Import, listening, analysis, and final rendering sum to the job duration. Concurrent face analysis and transcription remain overlapping engine-command records, not additive phase times.
- Open-project time starts at the project-card click and ends when Edit it myself opens its drawer. This checks an interaction after the detail loads.
- Two hand edits select Big, then Small subtitles in the real drawer and click Make a new version. Each must create a new version. The last saved output must decode with FFmpeg.
- Disk values are captured after the first edit and these two re-renders, before any replay note. JSON records logical and allocated bytes for media, work, and versions. Logical bytes, allocated bytes, and file counts deduplicate by device and inode within each walk. APFS clone physical usage is reported as "not measured". These are not reclaimable-space estimates.
- The screen's total React commits use React's DevTools commit hook, installed before the production renderer loads. Separate layout-effect counters record Reel and PhonePlayer commits. All counters exist only in scratch. Playback must advance at least 4.5 seconds during a five-second interval, excluding explicit seek/play changes. Browser-reported decoded and dropped video frames are also recorded.
- Electron memory comes from getAppMetrics. Python RSS and simultaneous engine-tree RSS use ps, including FFmpeg children. Samples run every 200 ms and can miss short peaks. The first final's Python peak isolates the cover-memory claim from speech-model memory. Setup-check engine peaks are recorded separately.
- Every projects:get and projects:update response records UTF-8 JSON bytes, handler duration, word count, and version count. This is serialized application payload size, not Electron's internal wire framing or structured-clone heap use.

`--note` runs a synthetic ReplayProvider sequence after the deterministic workflow. It requests two caption styles with two previews, then finishes. The real agent tools and Python renders run without inference. The runner checks final size/color, records render count, and decodes the saved output. This tests one successful staged note, not cancellation, attachments, rollback, or general AI quality. All compared refs must use the same note setting.

The runner executes the ref's real speech thread check before editing and records setup duration and selection. Some refs expose model.runCheck. Newer refs suppress their background check in test mode, so the scratch main entry exposes that existing method and the runner awaits it. The main branch retains its existing thread policy. First-edit times exclude this one-time check. This compares the configured branch behavior; it does not claim that model construction is reused across separate engine processes.

## Repeatability and resource limits

Each ref gets a detached scratch worktree, npm ci, a fresh venv with its exact engine requirements, and a production electron-vite build. Only the generated benchmark entry point and counters differ from that ref. App data, projects, model links, temporary files, and REELENGINE_CACHE all point into scratch. The worktree and venv are removed after the ref, including failure paths. A lock prevents overlapping runs of this runner. It cannot exclude other agents' Electron jobs.

Before builds and installations, the runner prints df. It refuses to continue below 3 GiB free, at memory pressure 4, or at 2 GiB of scratch. It also checks while commands and app jobs run. Before startup, first edit, project opening, each subtitle re-render, the replay note, and any model-adoption or speech-setup timing, the 1-minute load average must be strictly below a fixed threshold of 8. This is two-thirds of the 12-core benchmark host and rejects the earlier 26.44-load trials. Refused attempts are recorded in loadChecks and retried after 30 seconds, outside the measured interval. Each trial records accepted operation loads in loads. The guard limits starting load; it does not control thermal drift or load changes during an operation.

SIGINT and SIGTERM request cleanup of its own commands and app. Each engine PID is appended synchronously to a scratch registry when spawned. Cleanup reads that registry even if Electron crashed, checks live process commands for paths under the unique scratch directory, and terminates engines and FFmpeg descendants. It waits for exit, escalating from SIGTERM to SIGKILL after five seconds. If a process survives or cannot be verified, scratch is retained and cleaned is false. A SIGKILL cannot run cleanup; inspect the PID in `/tmp/rs-perf-harness/.lock` before removing a stale lock.

Compare mode requires complete matching host and runtime fingerprints, including a hash of the machine UUID, OS, CPU, core count, architecture, memory capacity, Node, Python, Playwright, and Electron runtime versions. Reports without these fingerprints cannot be compared. It also refuses different clip, model, FFmpeg, Python-package, method, or replay settings. A delta no larger than either side's full observed range is marked `noise`. A single run is marked `insufficient runs`. These labels are conservative comparisons, not significance tests. At least five alternating before/after trials provide stronger timing evidence than three sequential runs. Rebuild one ref at a time to keep disk bounded, and report host load alongside the numbers.

JavaScript lock changes also fail comparison by default. For a whole-branch comparison such as alpha adding electron-updater, pass `--whole-ref` to compare mode. The table explicitly warns that it cannot attribute differences to one feature. Model, FFmpeg, Python packages, fixtures, and benchmark code must still match.

The measurement choices follow the T3 Code scout's separation of byte budgets, committed React work, allocated storage, and end-to-end timing. Its local research artifact is `/tmp/rs-eval/t3code-perf-lessons.md`. Playwright's [Electron API](https://playwright.dev/docs/api/class-electron) documents the launch and main-process evaluation used here.

Run the statistics and replay-contract checks with `node --test scripts/perf/*.test.mjs`.
