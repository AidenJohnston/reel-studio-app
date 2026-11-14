// Animations follow a re-cut (engine/reelengine/anim_timing.py). An animation's beats and its place
// above the face are worked out from the cut, so when the cut moves, the engine names the clips that
// need rendering again with the beats on the same words (`anim-jobs`), and this renders them with the
// template renderer before every render (a `render`, or a `moments` run, which draws stills, a window and a
// draft). The engine plays the old clip for any that are missing, so a failure here never stops a render.
import type { EngineProgress, RunEngine } from './engine'

type RenderAnimation = (template: string, params: Record<string, unknown>, outPath: string, fps?: number, signal?: AbortSignal) => Promise<string>

interface AnimJob {
  id: string
  template: string
  params: Record<string, unknown>
  /** the project's rate (engine anim_timing.project_fps); an older engine leaves it out */
  fps?: number
  out: string
}

/** The commands that draw the cut's frames; `moments --mark` only writes a file (render-slot.ts). */
function draws(command: string, args: string[]): boolean {
  return command === 'render' || (command === 'moments' && !args.includes('--mark'))
}

/** The render's own project file, job token and Library root: anim-jobs must read the edit the render reads
 * (a note renders its private copy, `--project-file`), and the engine refuses it without the job's token
 * while the job has the project open (engine owner.py). */
const FORWARDED = ['--project-file', '--owner', '--root']

function forwarded(args: string[]): string[] {
  return FORWARDED.flatMap((flag) => {
    const i = args.indexOf(flag)
    return i >= 0 && args[i + 1] ? [flag, args[i + 1]] : []
  })
}

const STOPPED = { code: 'CANCELLED', userMessage: 'Stopped.' }

/** `work`, or a rejection the moment `signal` aborts: Stop never waits for a render (one queued
 * behind another, or one between frames). The renderer gets the signal too and quits on its own;
 * `work` always keeps a handler, so the render it abandons never becomes an unhandled rejection. */
export function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(STOPPED)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    // after a Stop this settles nothing (the promise already rejected): it only keeps `work` handled
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** `run`, with every render preceded by re-rendering the animations the current cut moved. */
export function withAnimationRetiming(run: RunEngine, render: RenderAnimation, log: (line: string) => void = () => {}): RunEngine {
  // every argument goes through as it came: later runner arguments (an exit callback) must reach the runner
  return async (...call) => {
    const [command, args, onProgress, signal] = call
    if (draws(command, args)) await retimeAnimations(run, render, args, log, onProgress, signal)
    return run(...call)
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
    const r = (await run('anim-jobs', ['--project', args[i + 1], ...forwarded(args)], undefined, signal)) as { jobs?: AnimJob[] } | null
    jobs = Array.isArray(r?.jobs) ? r.jobs : []
  } catch (e) {
    if (signal?.aborted) throw e
    log(`[animation] could not list the animations to re-time: ${(e as { message?: string })?.message ?? e}`)
    return
  }
  for (const job of jobs) {
    onProgress?.({ stage: 'animations', pct: 0, message: 'Re-timing an animation' })
    try {
      await untilStopped(render(job.template, job.params, job.out, job.fps, signal), signal)
    } catch (e) {
      if (signal?.aborted) throw e // Stop: the job ends here, no render after it
      log(`[animation] ${job.id}: could not re-time (${(e as { message?: string })?.message ?? e}); the old one plays`)
    }
  }
}
