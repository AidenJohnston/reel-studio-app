// Animations follow a re-cut (engine/reelengine/anim_timing.py). An animation's beats and its place
// above the face are worked out from the cut, so when the cut moves, the engine names the clips that
// need rendering again with the beats on the same words (`anim-jobs`), and this renders them with the
// template renderer before every render. The engine plays the old clip for any that are missing, so a
// failure here never stops a render.
import type { EngineProgress, RunEngine } from './engine'

type RenderAnimation = (template: string, params: Record<string, unknown>, outPath: string, signal?: AbortSignal) => Promise<string>

interface AnimJob {
  id: string
  template: string
  params: Record<string, unknown>
  out: string
}

const STOPPED = { code: 'CANCELLED', userMessage: 'Stopped.' }

/** `work`, or a rejection the moment `signal` aborts: Stop never waits for a render (one queued
 * behind another, or one between frames). The renderer gets the signal too and quits on its own. */
export function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(STOPPED)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(STOPPED)
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** `run`, with every `render` preceded by re-rendering the animations the current cut moved. */
export function withAnimationRetiming(run: RunEngine, render: RenderAnimation, log: (line: string) => void = () => {}): RunEngine {
  return async (command, args, onProgress, signal) => {
    if (command === 'render') await retimeAnimations(run, render, args, log, onProgress, signal)
    return run(command, args, onProgress, signal)
  }
}

export async function retimeAnimations(
  run: RunEngine,
  render: RenderAnimation,
  args: string[],
  log: (line: string) => void,
  onProgress?: (p: EngineProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const i = args.indexOf('--project')
  if (i < 0 || !args[i + 1]) return
  let jobs: AnimJob[]
  try {
    const r = (await run('anim-jobs', ['--project', args[i + 1]], undefined, signal)) as { jobs?: AnimJob[] } | null
    jobs = Array.isArray(r?.jobs) ? r.jobs : []
  } catch (e) {
    if (signal?.aborted) throw e
    log(`[animation] could not list the animations to re-time: ${(e as { message?: string })?.message ?? e}`)
    return
  }
  for (const job of jobs) {
    onProgress?.({ stage: 'animations', pct: 0, message: 'Re-timing an animation' })
    try {
      await untilStopped(render(job.template, job.params, job.out, signal), signal)
    } catch (e) {
      if (signal?.aborted) throw e // Stop: the job ends here, no render after it
      log(`[animation] ${job.id}: could not re-time (${(e as { message?: string })?.message ?? e}); the old one plays`)
    }
  }
}
