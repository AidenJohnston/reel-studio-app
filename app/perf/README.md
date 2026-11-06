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

The Reel screen's player loads a version in a hidden layer and swaps it in once its first frame is ready
(`Player.tsx`). Chromium records no Element Timing paint for a layer that loaded hidden (a Windows run timed out
waiting for one), so a player moment ends at the first animation frame in which the layer is the shown one, or at
the layer's paint when Chromium did record a later one (the first version on opening, which loads in view). That frame's start can be up to
one frame (about 17 ms at 60 Hz) before the swap is on screen.

| Moment | Starts | Ends |
|---|---|---|
| Launch to usable | the test spawns Electron | the later of the window being shown (`rs:window-shown`, main process) and the first reel title on Home being painted |
| Open a reel | the click on its card on Home | its latest version shown in the player: its cover, or its first frame if it has none |
| Switch version | the click on Play for the version before it in the notes, not yet shown since launch | that version shown in the player |
| Switch back | the click on Play for the latest version | the latest version shown in the player |
| Scrub | the `pointerup` of a click on the timeline under the phone, which seeks there | the frame at that position on screen (`requestVideoFrameCallback`, `expectedDisplayTime`) |
| Note to first status | Enter in the note box | the words in the note's progress strip being painted |

Scrub clicks five positions of the timeline in a fixed order and reports each on its own. A position covered by a
note's mark (a button that opens that note's version; each run's note adds one) or by the playhead moves to the nearest
bare spot, and each run records where it clicked (`scrubAt`), so compare a position's numbers only across runs that
clicked the same place. A seek decodes from the keyframe before it,
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
real model's does (`REELSTUDIO_MOCK_NOTE`).

## Options

- `REELSTUDIO_PERF_RUNS`: timed runs (default 5).
- `REELSTUDIO_PERF_OUT`: where the JSON report goes (default `perf/results/app-<time>.json`, ignored by git).
- `REELSTUDIO_PERF_MAX_BUSY`: 0 to 1. Before each run, wait (outside any timing, up to 5 minutes) until the machine
  is less busy than this; unset, load is only recorded. Busy is the 1-minute load average per CPU, or on Windows one
  `typeperf` sample of total CPU.
- `REELSTUDIO_E2E_VIDEO`: a real take instead of the generated test pattern, as in the e2e tests.

The report gives each moment's median over the runs, its min and max, and spread, (max - min) / median, as
`engine/harness` does, with the machine, its load before and after each run, and the commit.

## First-run motion

`motion.perf.ts` (run with the rest by `npm run perf`) clicks Get started, then "Use it" on a ready Claude in the
editor step, in a visible window at its real size, and records every animation frame's gap and every long animation
frame (`PerformanceObserver` type `long-animation-frame`, with the scripts that ran in it) for 3 s after each click.
It reports, per moment and run, the median gap (the display's frame time), the longest gap, the 95th percentile and
the frames longer than 50 ms. Around "Use it" it also records a Chromium trace and reports its longest tasks with the process and thread
each ran on (the renderer's main thread, the GPU process, the compositor), so a long frame can be put down to its
cause, and what the page painted in the 600 ms after the click, by element and area. The same trace covers the
600 ms before the click (`stillTasks`, `stillPaints`): what the step does with nobody touching it, so the work the click
adds is the difference. A Paint's area is what Chromium re-recorded, not what the GPU rastered; the GPU tasks' time is
the raster. Nodes are listed most-repainted first; a paint with no clip carries Chromium's unbounded rectangle, so it
is counted in `unbounded` and left out of `area`. `REELSTUDIO_PERF_MOTION_PRESS=key` presses "Use it" with Enter instead of a click: the app's keyboard mode turns
off the status line's settle-in, so the two runs side by side show what that transition costs.
`REELSTUDIO_PERF_RUNS` sets the runs (default 6 here); `REELSTUDIO_PERF_OUT_MOTION` the
report's path.

