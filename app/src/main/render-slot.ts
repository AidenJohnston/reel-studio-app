// Notes on different reels run at the same time, but their renders take turns, first come first
// served: two ffmpeg encodes at once on a laptop make both slower and can run it out of memory.
// Planning, searching and checking are not renders and keep going while a reel waits here.
import { isEngineError, type RunEngine } from './engine'

/** How many renders may run at once across all reels. */
export const RENDER_SLOTS = 1

/** `onWait(owner, waiting)`: a job's render (by its `--owner` token) started or stopped waiting. */
export function withRenderSlot(run: RunEngine, onWait: (owner: string, waiting: boolean) => void): { run: RunEngine } {
  let busy = 0
  const waiters: (() => void)[] = []

  function acquire(signal?: AbortSignal): Promise<void> {
    if (busy < RENDER_SLOTS) {
      busy++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject({ code: 'CANCELLED', userMessage: 'Stopped.' })
      const take = (): void => {
        signal?.removeEventListener('abort', stop)
        busy++
        resolve()
      }
      const stop = (): void => {
        waiters.splice(waiters.indexOf(take), 1)
        reject({ code: 'CANCELLED', userMessage: 'Stopped.' })
      }
      waiters.push(take)
      signal?.addEventListener('abort', stop, { once: true })
    })
  }

  function release(): void {
    busy--
    waiters.shift()?.()
  }

  // every argument goes through as it came: later runner arguments (an exit callback) must reach the runner
  const slotted: RunEngine = async (...call) => {
    const [command, args, , signal] = call
    if (command !== 'render') return run(...call)
    const at = args.indexOf('--owner')
    const owner = at >= 0 ? args[at + 1] : null
    const queued = busy >= RENDER_SLOTS
    if (queued && owner) onWait(owner, true)
    try {
      await acquire(signal)
    } finally {
      if (queued && owner) onWait(owner, false)
    }
    // The runner settles only once the engine's whole process group has exited (engine.ts), Stop
    // included. A group that would not die may still be encoding, so it keeps the slot until restart.
    let drained = true
    try {
      return await run(...call)
    } catch (e) {
      drained = !(isEngineError(e) && e.code === 'ENGINE_STUCK')
      throw e
    } finally {
      if (drained) release()
    }
  }
  return { run: slotted }
}
