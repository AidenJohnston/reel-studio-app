// As T3 Code's usePermissionStatus: check at once, every 1.5 s while visible, and again on focus (the person is back
// from System Settings). No React or DOM, so it is tested on its own.

const PERMISSION_POLL_MS = 1500
const CHECK_FAILED = "Could not check this. I'll try again by myself."

export interface PollEnv {
  hidden(): boolean
  every(fn: () => void, ms: number): () => void
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
