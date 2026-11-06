// Names of the moments app/perf/app.perf.ts times. The page names its moments with the browser's Element Timing
// attribute (`elementtiming`), so Chromium itself records when that element was first painted; nothing in the app
// reads these back or waits on them.

/** performance.mark in the main process when the window is shown (ready-to-show). */
export const WINDOW_SHOWN = 'rs:window-shown'

/** `elementtiming` on each reel's title on Home: the list a returning person clicks. */
export const HOME_REEL = 'home-reel'

/** `elementtiming` on the words in the note's progress strip: the first sign a note was taken. */
export const NOTE_STATUS = 'note-status'

/** `elementtiming` on each version <video> of the Reel screen's player, the shown one and the one loading behind it;
 * the shown one also carries data-testid="player". Its poster or first frame is timed when it is first painted. */
export const PLAYER = 'player'
