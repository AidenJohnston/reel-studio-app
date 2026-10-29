// Long-running work (first edit, notes, re-renders). One job per project at a time. Every event
// goes to the renderer; app.json records the running job so a crash can be recovered at startup.
import { randomUUID } from 'node:crypto'
import type { JobEvent, JobKind, JobUpdate, Phase } from '../shared/api'
import { addChat, cleanPartialVersions, projectDir, updateAppState } from './store'
import { toUserError } from './engine'
import { learn, ProgressTracker, type SpeedHistory } from './progress'

/** A job reports with the shared contract. A render's `file` becomes a playable `video` via `toVideo`. */
export type Emit = (e: JobUpdate) => void

/** Where measured phase times live, and how long the video is (for the time estimate). */
export interface ProgressDeps {
  loadHistory(): Promise<SpeedHistory>
  saveHistory(h: SpeedHistory): Promise<void>
  mediaSeconds(slug: string): Promise<number>
  /** ms between progress re-broadcasts while nothing else happens (default 1000) */
  tickMs?: number
}

/** Turns a finished render into a playable URL of a copy that is safe to play (index.ts). */
export type ToVideo = (slug: string, e: Extract<JobUpdate, { type: 'render' }>) => Promise<string | null>
export type JobFn = (emit: Emit, signal: AbortSignal) => Promise<{ summary: string; version?: number; quiet?: boolean }>

interface Running {
  id: string
  slug: string | null
  kind: JobKind
  abort: AbortController
  message: string
  pct: number
  overall: number
  secondsLeft: number | null
  overdue: boolean
  thinking: boolean
  done: Promise<void>
}

export function createJobManager(broadcast: (e: JobEvent) => void, log: (s: string) => void, progress?: ProgressDeps, toVideo?: ToVideo) {
  const jobs = new Map<string, Running>()

  /** Projects an engine process may still be writing to after its job ended (ENGINE_STUCK): nothing
   * runs on them and they stay closed until Reel Studio restarts and its leftovers are reaped. */
  const stuck = new Map<string, { code: string; userMessage: string }>()
  const BUSY = { code: 'BUSY', userMessage: 'I am still working on this video. Give me a moment, or press Stop.' }

  function refuseIfBusy(slug: string): void {
    const s = stuck.get(slug)
    if (s) throw s
    if (forSlug(slug)) throw BUSY
  }

  function forSlug(slug: string): Running | undefined {
    return [...jobs.values()].find((j) => j.slug === slug)
  }

  /** Nothing else may write to the project: a job runs on it, or it is kept closed. */
  function isClosed(slug: string): boolean {
    return stuck.has(slug) || !!forSlug(slug)
  }

  function start(slug: string | null, kind: JobKind, fn: JobFn, opts: { note?: string } = {}): string {
    if (slug) refuseIfBusy(slug)
    const id = randomUUID()
    const abort = new AbortController()
    const job: Running = { id, slug, kind, abort, message: 'Getting started', pct: 0, overall: 0, secondsLeft: null, overdue: false, thinking: false, done: Promise.resolve() }
    jobs.set(id, job)
    const send = (e: JobEvent): void => broadcast(e)
    let history: SpeedHistory = { v: 1, phases: {} }
    let mediaSec = 0
    let mediaAsked = false
    const pending: Promise<void>[] = []
    const tracker = new ProgressTracker(kind, 0, history)
    let phase: Phase | undefined
    // `thinking` is state, not a one-off: the once-a-second repeats keep saying it until the AI answers
    const status = (): void => {
      const snap = tracker.snapshot()
      job.overall = snap.overall
      // Until the video's length is known every estimate is for "0 minutes of video" and would jump UP
      // later ("about a minute" -> "about 4 minutes"): say nothing yet (the screen uses its own guess).
      job.secondsLeft = slug && progress && !mediaSec ? null : snap.etaSec
      job.overdue = snap.overdue
      send({ jobId: id, slug, type: 'status', message: job.message, pct: job.pct, ...(phase ? { phase } : {}), overall: snap.overall, secondsLeft: job.secondsLeft, overdue: job.overdue, thinking: job.thinking })
    }
    // re-broadcast once a second: time moves the bar and the estimate even while the AI thinks
    const tick = setInterval(() => status(), progress?.tickMs ?? 1000)
    tick.unref?.()

    job.done = (async () => {
      try {
        // Inside the try: if even this fails, the user gets an error instead of a job that never ends.
        if (slug) {
          await updateAppState(slug, (s) => {
            s.job = { id, kind, startedAt: new Date().toISOString(), note: opts.note }
            s.lastError = null
            if (kind === 'first-edit') s.status = 'working'
          })
        }
        if (progress) {
          history = await progress.loadHistory().catch(() => history)
          tracker.setHistory(history)
        }
        status()
        // main.log gets each new status line and each AI step, timed, so a slow edit can be traced afterwards
        const t0 = Date.now()
        let logged = ''
        const res = await fn((e) => {
          if (e.type === 'status') {
            if (e.message && e.message !== logged) log(`[job ${kind}] ${(logged = e.message)}`)
            job.message = e.message || job.message
            // Raw: per-step percents restart at 0; `overall` (progress.ts) is the whole job.
            if (typeof e.pct === 'number') job.pct = Math.max(0, Math.min(100, e.pct))
            if (e.phase && slug && progress && !mediaAsked) {
              mediaAsked = true
              // project.json exists once a phase starts (after init): the estimate scales with it
              void progress.mediaSeconds(slug).then((s) => { mediaSec = s; tracker.setMedia(s) }).catch(() => undefined)
            }
            tracker.update(e.phase, e.phase ? e.pct : undefined)
            if (e.phase) phase = e.phase
            job.thinking = !!e.thinking
            status()
          } else if (e.type === 'tool') {
            log(`[job ${kind}] tool ${e.name}`)
            job.thinking = false // the AI answered
            send({ jobId: id, slug, type: 'tool', name: e.name, summary: e.summary })
          } else if (e.type === 'render') {
            const r = e
            const video = slug && toVideo ? toVideo(slug, r).catch(() => null) : Promise.resolve(null)
            pending.push(video.then((v) => send({ jobId: id, slug, type: 'render', version: r.version, draft: r.draft, firstLook: !!r.firstLook, video: v })))
          } else if (e.type === 'reply') send({ jobId: id, slug, type: 'reply', text: e.text })
          else send({ jobId: id, slug, type: 'heard', words: e.words })
        }, abort.signal)
        await Promise.all(pending) // a render's event before `done`, never after
        if (progress && mediaSec > 0) {
          // what each phase really took on this computer: the next estimate starts from it
          await progress.saveHistory(learn(history, kind, mediaSec, tracker.finish())).catch(() => undefined)
        }
        if (slug) {
          await updateAppState(slug, (s) => {
            s.job = null
            s.status = 'ready'
          })
          if (!res.quiet) await addChat(slug, 'editor', res.summary, res.version)
        }
        log(`[job ${kind}] done in ${Math.round((Date.now() - t0) / 1000)} s`)
        send({ jobId: id, slug, type: 'done', summary: res.summary, version: res.version })
      } catch (e) {
        const err = toUserError(e)
        const cancelled = err.code === 'CANCELLED' || abort.signal.aborted
        if (!cancelled) log(`[job ${kind}] ${err.code}: ${err.message ?? ''}`)
        if (slug && err.code === 'ENGINE_STUCK') stuck.set(slug, { code: err.code, userMessage: err.userMessage })
        // With a stuck engine nothing is cleaned up: it may still be writing.
        if (slug && !stuck.has(slug)) {
          await cleanPartialVersions(projectDir(slug)).catch(() => [])
          await updateAppState(slug, (s) => {
            s.job = null
            if (kind === 'first-edit') s.status = cancelled ? 'interrupted' : 'failed'
            if (!cancelled) s.lastError = { code: err.code, userMessage: err.userMessage }
          }).catch(() => {})
        }
        if (slug && !cancelled && kind !== 'first-edit') await addChat(slug, 'editor', err.userMessage).catch(() => {})
        send(cancelled ? { jobId: id, slug, type: 'cancelled' } : { jobId: id, slug, type: 'error', code: err.code, userMessage: err.userMessage })
      } finally {
        clearInterval(tick)
        jobs.delete(id)
      }
    })()
    return id
  }

  /** A project something of a previous run still writes to (orphans.ts reap): closed until it stops. */
  function keepClosed(slug: string): void {
    stuck.set(slug, { code: 'ENGINE_STILL_RUNNING', userMessage: "Part of Reel Studio's video engine from last time is still running on this video. Quit and reopen Reel Studio in a few minutes, or restart your computer, before you change it." })
  }

  return {
    start,
    /** Throws while a job runs on the project or it is kept closed: a manual edit must wait. */
    refuseIfBusy,
    isClosed,
    keepClosed,
    forSlug,
    get: (id: string) => jobs.get(id),
    cancel(id: string): void {
      jobs.get(id)?.abort.abort()
    },
    async cancelAll(): Promise<void> {
      const all = [...jobs.values()]
      all.forEach((j) => j.abort.abort())
      await Promise.race([Promise.all(all.map((j) => j.done)), new Promise((r) => setTimeout(r, 4000))])
    },
    runningCount: () => jobs.size
  }
}

export type JobManager = ReturnType<typeof createJobManager>
