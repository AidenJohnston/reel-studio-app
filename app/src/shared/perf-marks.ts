// Names of the moments app/perf/app.perf.ts times. The page names its moments with the browser's Element Timing
// attribute (`elementtiming`), so Chromium itself records when that element was first painted; nothing in the app
// reads these back or waits on them.

/** performance.mark in the main process when the window is shown (ready-to-show). */
export const WINDOW_SHOWN = 'rs:window-shown'

/** `elementtiming` on each reel's title on Home: the list a returning person clicks. */
export const HOME_REEL = 'home-reel'

/** `elementtiming` on the job's status line under the notes: the first sign a note was taken. */
export const NOTE_STATUS = 'note-status'

// The phone player's <video> carries its own test id as `elementtiming` ("player" on the Reel screen), so the
// poster or first frame of each version is timed when it reaches the screen.
