// Keeps a permission checklist current while it is on screen, the way T3 Code's usePermissionStatus does: check
// right away, every 1.5 s while the window is visible, and again when the window gets focus or becomes visible
// (the person is back from System Settings). One check at a time; a failed check says so and keeps trying.
// No React and no DOM here, so it can be tested on its own (test/permissions.test.ts).

export const PERMISSION_POLL_MS = 1500
export const CHECK_FAILED = "Could not check this. I'll try again by myself."

export interface PollEnv {
  hidden(): boolean
  /** Run fn every ms; returns a stop function. */
  every(fn: () => void, ms: number): () => void
  /** Run fn when the window gets focus or its visibility changes; returns a stop function. */
  onWake(fn: () => void): () => void
}

export function pollPermissions<T>(
  check: () => Promise<T>,
  on: { status: (s: T) => void; error: (message: string | null) => void },
  env: PollEnv
): () => void {
  let disposed = false
  let checking = false
  const refresh = async (): Promise<void> => {
    if (disposed || checking || env.hidden()) return
    checking = true
    try {
      const next = await check()
      if (!disposed) {
        on.status(next)
        on.error(null)
      }
    } catch {
      if (!disposed) on.error(CHECK_FAILED)
    }
    checking = false
  }
  void refresh()
  const stopTimer = env.every(() => void refresh(), PERMISSION_POLL_MS)
  const stopWake = env.onWake(() => void refresh())
  return () => {
    disposed = true
    stopTimer()
    stopWake()
  }
}
