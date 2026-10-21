// The reel viewer's full screen (src/main/viewer-fullscreen.ts) only undoes a full screen it caused.
import { describe, expect, it } from 'vitest'
import { viewerFullScreen, type FullScreenWindow } from '../src/main/viewer-fullscreen'

/**
 * A window that changes full screen the way Electron's macOS window does: each change is a
 * transition, calls made during one are queued (a repeat of the last queued value is dropped), and
 * 'leave-full-screen' fires when a leave finishes. `finish()` ends the transitions in turn.
 */
function fakeWindow(full = false) {
  let busy = false
  const queue: boolean[] = []
  const leave: (() => void)[] = []
  const w = {
    full,
    isFullScreen: () => w.full,
    setFullScreen(on: boolean) {
      if (busy) {
        if (queue[queue.length - 1] !== on) queue.push(on)
        return
      }
      if (on === w.full) return
      busy = true
      queue.unshift(on)
    },
    on(_e: 'leave-full-screen', fn: () => void) {
      leave.push(fn)
    },
    /** The person's green button. */
    toggleByHand() {
      w.full = !w.full
      if (!w.full) leave.forEach((fn) => fn())
    },
    finish() {
      while (queue.length) {
        const on = queue.shift()!
        busy = false
        if (on === w.full) continue
        w.full = on
        if (!on) leave.forEach((fn) => fn())
      }
    }
  }
  return w satisfies FullScreenWindow
}

describe('viewer full screen', () => {
  it('opens full screen and puts the window back on close', () => {
    const w = fakeWindow()
    const set = viewerFullScreen(w)
    set(true)
    w.finish()
    expect(w.full).toBe(true)
    set(false)
    w.finish()
    expect(w.full).toBe(false)
  })

  it('leaves a window that was already full screen as it was', () => {
    const w = fakeWindow(true)
    const set = viewerFullScreen(w)
    set(true)
    set(false)
    w.finish()
    expect(w.full).toBe(true)
  })

  it('closing while it is still going full screen still ends up back in the window', () => {
    const w = fakeWindow()
    const set = viewerFullScreen(w)
    set(true)
    set(false)
    w.finish()
    expect(w.full).toBe(false)
  })

  it('reopening while it is still leaving goes back to full screen, and the next close leaves again', () => {
    const w = fakeWindow()
    const set = viewerFullScreen(w)
    set(true)
    w.finish()
    set(false)
    set(true)
    w.finish()
    expect(w.full).toBe(true)
    set(false)
    w.finish()
    expect(w.full).toBe(false)
  })

  it('open, close, open in one go (React dev runs effects twice) ends full screen', () => {
    const w = fakeWindow()
    const set = viewerFullScreen(w)
    set(true)
    set(false)
    set(true)
    w.finish()
    expect(w.full).toBe(true)
  })

  it('several quick opens and closes still end where the last one asked', () => {
    const w = fakeWindow()
    const set = viewerFullScreen(w)
    for (const on of [true, false, true, false, true]) set(on)
    w.finish()
    expect(w.full).toBe(true)
    set(false)
    w.finish()
    expect(w.full).toBe(false)
  })

  it('after the person leaves full screen by hand, a later full screen of theirs is not ours to undo', () => {
    const w = fakeWindow()
    const set = viewerFullScreen(w)
    set(true)
    w.finish()
    w.toggleByHand() // green button while the viewer is open
    set(false)
    w.finish()
    expect(w.full).toBe(false)
    w.toggleByHand() // full screen again, by hand
    set(true)
    set(false)
    w.finish()
    expect(w.full).toBe(true)
  })
})
