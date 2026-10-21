// Full screen for the reel viewer (renderer: components/FullScreenReel.tsx). The window itself goes
// full screen rather than the page's Fullscreen API: Electron 44's HTML full screen hangs (the request
// never resolves) when it is asked again after it was used inside a window that was already in macOS
// full screen and the window has since left it.

/** The part of a BrowserWindow this needs. */
export interface FullScreenWindow {
  isFullScreen(): boolean
  setFullScreen(on: boolean): void
  on(event: 'leave-full-screen', listener: () => void): unknown
}

/**
 * Returns the switch the viewer calls with true on open and false on close. It only undoes a full
 * screen it caused: a window the person had already made full screen stays that way.
 *
 * macOS full screen takes about half a second each way and Electron queues changes asked for
 * meanwhile, so "is it full screen" is not enough to know whose it is. `ours`: the viewer put the
 * window there. `leaves`: how many of the viewer's own exits have not finished yet; a leave beyond
 * those is the person's (the green button), and after that nothing is ours to undo.
 */
export function viewerFullScreen(win: FullScreenWindow): (on: boolean) => void {
  let ours = false
  let asked = false // the last value the viewer passed to setFullScreen
  let leaves = 0
  let want = false
  win.on('leave-full-screen', () => {
    if (leaves > 0) {
      leaves--
      if (leaves === 0 && !want) ours = false
    } else {
      ours = false
      asked = false
    }
  })
  return (on) => {
    want = on
    if (on) {
      if (!ours && win.isFullScreen()) return
      ours = true
      if (!asked) win.setFullScreen(true)
      asked = true
    } else if (ours && asked) {
      leaves++
      asked = false
      win.setFullScreen(false)
    }
  }
}
