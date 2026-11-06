import type { FootageIndexStatus } from '../shared/api'
import { toUserError, type RunEngine } from './engine'

export interface IdleWork {
  pause(): Promise<void>
  resume(): void
}

export interface FootageIndexResult {
  files: number
  stagesRun: number
  pending: number
  places?: { id: string; files: number; online: boolean }[]
}

export function createFootageIndexer(o: {
  runEngine: RunEngine
  root: () => string
  busy: () => boolean
  /** --source arguments for the added footage folders (footage-sources.ts indexArgs) */
  sources?: () => Promise<string[]>
  /** each finished run's result, for the folders' counts */
  done?: (result: FootageIndexResult) => void
}) {
  let status: FootageIndexStatus = { state: 'idle' }
  let requested = false
  let paused = false
  let stopped = false
  let active: { abort: AbortController; done: Promise<void> } | null = null

  function pump(): Promise<void> {
    if (active) return active.done
    if (stopped || !requested) return Promise.resolve()
    if (paused || o.busy()) {
      status = { state: 'paused' }
      return Promise.resolve()
    }
    requested = false
    const abort = new AbortController()
    status = { state: 'indexing', stage: 'scan', pct: 0, message: 'Looking for new videos' }
    const done = Promise.resolve().then(async () => {
      try {
        const sources = (await o.sources?.()) ?? []
        const result = await o.runEngine('footage', ['index', '--root', o.root(), '--budget-seconds', '120', ...sources],
          (p) => { if (!abort.signal.aborted) status = { state: 'indexing', ...p } }, abort.signal)
        if (!result || typeof result !== 'object' || !('pending' in result) || typeof result.pending !== 'number') {
          throw new Error('Footage index returned no pending stage count')
        }
        requested ||= result.pending > 0
        o.done?.(result as FootageIndexResult)
        status = { state: 'idle' }
      } catch (error) {
        if (abort.signal.aborted) {
          requested = true
          status = { state: 'paused' }
        } else {
          requested = false
          status = { state: 'error', message: toUserError(error).userMessage }
        }
      } finally {
        active = null
      }
      // Each budget gets its own turn so a new job can claim the lane first.
      if (requested && !stopped && !paused && !o.busy()) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        await pump()
      }
    })
    active = { abort, done }
    return done
  }

  async function pause(): Promise<void> {
    paused = true
    active?.abort.abort()
    await active?.done
    if (requested) status = { state: 'paused' }
  }

  return {
    status: (): FootageIndexStatus => ({ ...status }),
    request(): Promise<void> { requested = true; return pump() },
    pause,
    resume(): void { paused = false; void pump() },
    async stop(): Promise<void> { stopped = true; await pause() }
  }
}
