# App timings

`npm run perf` (from `app/`) builds the app, then times what a person waits for in the app itself. Render speed is
measured separately, by `engine/harness`.

It is report only. Nothing passes or fails on a time, because there is no evidence yet for what these numbers should
be. A run fails only when a moment never happens.

## The moments

Each end is a time Chromium records itself. `src/shared/perf-marks.ts` names the elements, using the browser's Element
Timing attribute (`elementtiming`), so the app never reads its own timings or waits on them. Each start is the
`timeStamp` of the input event that began the moment. Both are on the page's clock, so the test's own polling never
enters a number.

| Moment | Starts | Ends |
|---|---|---|
| Launch to usable | the test spawns Electron | the later of the window being shown (`rs:window-shown`, main process) and the first reel title on Home being painted |
| Open a reel | the click on its card on Home | the player's first paint: the version's cover, or its first frame if it has none |
| Switch version | the click on a version not yet shown since launch | the new player's first paint |
| Switch back | the click back to the version the reel opened on | the new player's first paint |
| Scrub | the scrub bar's `input` event on a click | the frame at that position on screen (`requestVideoFrameCallback`, `expectedDisplayTime`) |
| Note to first status | Enter in the note box | the status line under the notes ("Reading your note") being painted |

Scrub clicks five positions in a fixed order and reports each on its own. A seek decodes from the keyframe before it,
so its time depends on where it lands in the encode, and the first click after opening also loads data the player had
not fetched yet. The fake engine encodes with x264's default keyframe spacing, so scrub numbers describe that encode,
not the real engine's exports.

Launch includes Playwright attaching to Electron, which holds Electron's `ready` event until it has. A person starting
the app does not pay that, so treat launch as an upper bound. The report splits launch into the main process starting,
the window being shown and the Home list being painted.

## One run

A setup launch, untimed, makes one reel with two versions in a fresh profile; it is also the warm-up. Each timed run
then relaunches that profile and goes through the moments in the order above, then waits for the note to finish and
closes the app. The engine is `app/dev/fake-engine` and the AI editor is the mock, so no moment waits on a render or a
model: the fake engine only makes the setup reel, and the mock holds each note for 1.5 s so its status line stays up as a
real model's does.

## Options

- `REELSTUDIO_PERF_RUNS`: timed runs (default 5).
- `REELSTUDIO_PERF_OUT`: where the JSON report goes (default `perf/results/app-<time>.json`, ignored by git).
- `REELSTUDIO_PERF_MAX_BUSY`: 0 to 1. Before each run, wait (outside any timing, up to 5 minutes) until the machine
  is less busy than this; unset, load is only recorded. Busy is the 1-minute load average per CPU, or on Windows one
  `typeperf` sample of total CPU.
- `REELSTUDIO_E2E_VIDEO`: a real take instead of the generated test pattern, as in the e2e tests.

The report gives each moment's median over the runs, its min and max, and spread, (max - min) / median, as
`engine/harness` does, with the machine, its load before and after each run, and the commit.
