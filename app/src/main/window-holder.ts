export interface ClosableWindow {
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
}

export interface WindowHolder<T extends ClosableWindow> {
  getLive(): T | null
  track(window: T): T
}

/** Keeps one BrowserWindow reference valid across close/recreate cycles. */
export function createWindowHolder<T extends ClosableWindow>(): WindowHolder<T> {
  let current: T | null = null

  const track = (window: T): T => {
    current = window
    window.once('closed', () => {
      if (current === window) current = null
    })
    return window
  }

  return {
    getLive: () => current && !current.isDestroyed() ? current : null,
    track
  }
}
