// One gate between real work (jobs: main/jobs.ts) and the listening model's background timing check
// (main/models.ts), so the two never run at the same time: the check would slow a transcription or a render down,
// and a busy computer would make the check pick the wrong thread count.

export interface WorkGate {
  /**
   * A job is starting. Stops a running check and resolves once its process has really exited, so the job's own
   * engine work starts on a quiet computer. Call the returned function when the job ends.
   */
  enterJob(): Promise<() => void>
  /**
   * Starts the check now if no job holds the gate; otherwise returns null and starts nothing. `start` must spawn
   * synchronously (before its first await) and call `exited` once the process is gone, however it ends.
   */
  runCheck<T>(start: (signal: AbortSignal, exited: () => void) => Promise<T>): Promise<T> | null
}

export function createWorkGate(): WorkGate {
  let jobs = 0
  let check: { abort: AbortController; exited: Promise<void> } | null = null

  return {
    async enterJob() {
      jobs++
      if (check) {
        check.abort.abort()
        await check.exited
      }
      return () => {
        jobs--
      }
    },
    runCheck(start) {
      if (jobs > 0 || check) return null
      const abort = new AbortController()
      let exit!: () => void
      const exited = new Promise<void>((resolve) => (exit = resolve))
      const mine = { abort, exited }
      check = mine
      void exited.then(() => {
        if (check === mine) check = null
      })
      return start(abort.signal, exit)
    }
  }
}
