// Long-running work (first edit, notes, re-renders). One job per project at a time. Every event
// goes to the renderer; app.json records the running job so a crash can be recovered at startup.
import type { IdleWork } from './footage-index'
import { randomUUID } from 'node:crypto'
import type { JobEvent, JobKind, JobUpdate, PausedFor, Phase, VersionMade } from '../shared/api'
import { cleanPartialVersions, listVersions, projectDir, recordVersionMade, settleNote, updateAppState, settleInterrupted, stamp, type AppState } from './store'
import { claimProject, type ProjectOwner } from './owner'
import type { ChatLine } from './style-consent'
import { toUserError } from './engine'
import { learn, ProgressTracker, type SpeedHistory, parseHistory, type ProgressKind } from './progress'
import type { WorkGate } from './work-gate'
import { createFirstEditSteps, type Step } from '../shared/steps'

/** A job reports with the shared contract. A render's `file` becomes a playable `video` via `toVideo`. */
export type Emit = (e: JobUpdate) => void

/** Where measured phase times live, and how long the video is (for the time estimate). */
export interface ProgressDeps {
  profile?(kind: JobKind): Promise<ProgressKind>
  loadHistory(): Promise<unknown>
  saveHistory(h: SpeedHistory): Promise<void>
  mediaSeconds(slug: string): Promise<number>
  /** ms between progress re-broadcasts while nothing else happens (default 1000) */
  tickMs?: number
}

/** Turns a finished render into a playable URL of a copy that is safe to play (index.ts). */
export type ToVideo = (slug: string, e: Extract<JobUpdate, { type: 'render' }>) => Promise<string | null>
/**
 * `job.id`: a note is saved in project.json under it (store.ts settleInterrupted). `job.owner`: the token that owns
 * the project while the job runs; every engine command and edit it starts joins with it (`--owner`, ai owner.ts).
 * `chat`: the lines to post when the job ends (default: the summary). `outcome`: for a note, whether it changed the
 * video (absent = it did). `made`: what this job changed, recorded for `version` only if the job's own final render
 * made it (see start).
 */
export type JobFn = (
  emit: Emit,
  signal: AbortSignal,
  job: { id: string; owner: string | null }
) => Promise<{ summary: string; version?: number; chat?: ChatLine[]; outcome?: 'done' | 'failed'; made?: Pick<VersionMade, 'by' | 'summary'> }>
/** Turns a moment's file into a playable URL of a copy the next moments run cannot overwrite (index.ts). */
export type ToMoment = (slug: string, e: Extract<JobUpdate, { type: 'moment' }>) => Promise<string | null>

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
  /** `message` is the wait for the editor (Waiting for Claude to answer), not the step's work */
  waiting: boolean
  steps?: Step[]
  /** The project owner token its engine commands carry (owner.ts); null until the project is claimed. */
  owner: string | null
  /** Waiting for the render slot another reel holds (render-slot.ts). */
  waitingForRender: boolean
  setWaitingForRender: (waiting: boolean) => void
  done: Promise<void>
}

export const WAITING_FOR_RENDER = 'Waiting for another reel to finish rendering'
const shown = (j: Running): string => (j.waitingForRender ? WAITING_FOR_RENDER : j.message)

export function createJobManager(
  broadcast: (e: JobEvent) => void,
  log: (s: string) => void,
  progress?: ProgressDeps,
  toVideo?: ToVideo,
  gate?: WorkGate,
  /** The updater refuses new work while it restarts to install (main/updater.ts). */
  assertCanStart: () => void = () => {},
  /** Background work that yields while any job runs (footage-index.ts: indexing Library footage). */
  idleWork?: IdleWork,
  /** Pictures of what the AI just changed, before its draft: a playable URL of each (live-video.ts). */
  toMoment?: ToMoment,
  /** Each job's last event (not a pause, which continues), with how long the job ran (main/usage.ts). */
  onEnded?: (kind: JobKind, last: Extract<JobEvent, { type: 'done' | 'error' | 'cancelled' }>, seconds: number) => void
) {
  const jobs = new Map<string, Running>()

  /** Projects a manual edit is writing right now: no job may start on them meanwhile. */
  const held = new Set<string>()
  /** Callers waiting for a project to have no job and no manual edit (`whenFree`). */
  const freeWaiters = new Map<string, (() => void)[]>()
  function freed(slug: string): void {
    if (forSlug(slug) || held.has(slug)) return
    const waiting = freeWaiters.get(slug)
    freeWaiters.delete(slug)
    waiting?.forEach((go) => go())
  }
  /** Projects an engine process may still be writing to after its job ended (ENGINE_STUCK): nothing
   * runs on them and they stay closed until Reel Studio restarts and its leftovers are reaped. */
  const stuck = new Map<string, { code: string; userMessage: string }>()
  const BUSY = { code: 'BUSY', userMessage: 'This reel is still being worked on. Wait a moment, or press Stop.' }

  function refuseIfKeptClosed(slug: string): void {
    const s = stuck.get(slug)
    if (s) throw s
  }

  function refuseIfBusy(slug: string): void {
    refuseIfKeptClosed(slug)
    if (forSlug(slug) || held.has(slug)) throw BUSY
  }

  function forSlug(slug: string): Running | undefined {
    return [...jobs.values()].find((j) => j.slug === slug)
  }

  /** Nothing else may write to the project: a job runs on it, or it is kept closed. A manual edit
   * (`hold`) does not count: it is quick, and only refuses jobs and other edits meanwhile. */
  function isClosed(slug: string): boolean {
    return stuck.has(slug) || !!forSlug(slug)
  }

  /** `record`: more changes to app.json, saved in the same write that records the job as running. */
  /** `pause`: whether a failure pauses the job to continue on its own (main/pause.ts) rather than failing it. */
  function start(slug: string | null, kind: JobKind, fn: JobFn, opts: { note?: string; record?: (s: AppState) => void; pause?: (err: unknown) => PausedFor | null } = {}): string {
    assertCanStart()
    if (slug) refuseIfBusy(slug)
    const id = randomUUID()
    const abort = new AbortController()
    const startedAt = Date.now()
    const job: Running = { id, slug, kind, abort, message: 'Getting started', pct: 0, overall: 0, secondsLeft: null, overdue: false, thinking: false, waiting: false, owner: null, waitingForRender: false, setWaitingForRender: () => undefined, done: Promise.resolve() }
    jobs.set(id, job)
    const send = (e: JobEvent): void => broadcast(e)
    let history: SpeedHistory = { v: 1, phases: {} }
    let mediaSec = 0
    let mediaAsked = false
    const pending: Promise<void>[] = []
    let progressKind: ProgressKind = kind
    let ended: JobEvent | null = null
    // after a failure or Stop, a render still being copied is never shown
    let open = true
    let tracker = new ProgressTracker(progressKind, 0, history)
    let owner: ProjectOwner | null = null
    // moments are copied one after another, so they arrive in the order they were made
    let moments: Promise<void> = Promise.resolve()
    let phase: Phase | undefined
    const rows = kind === 'first-edit' ? createFirstEditSteps() : null
    if (rows) job.steps = rows.steps()
    // `thinking` is state, not a one-off: the once-a-second repeats keep saying it until the AI answers
    const status = (): void => {
      const snap = tracker.snapshot()
      job.overall = snap.overall
      // Until the video's length is known every estimate is for "0 minutes of video" and would jump UP
      // later: wait for duration before showing a number.
      const secondsLeft = slug && progress && !mediaSec ? null : snap.etaSec
      // Null clears an expired estimate in broadcasts and project-detail hydration alike.
      job.secondsLeft = secondsLeft
      job.overdue = snap.overdue
      send({ jobId: id, slug, type: 'status', message: shown(job), pct: job.pct, ...(phase ? { phase } : {}), overall: snap.overall, secondsLeft: job.secondsLeft, overdue: job.overdue, thinking: job.thinking, waiting: job.waiting, waitingForRender: job.waitingForRender, ...(job.steps ? { steps: job.steps } : {}) })
    }
    job.setWaitingForRender = (waiting) => {
      job.waitingForRender = waiting
      tracker.hold(waiting)
      status()
    }
    // re-broadcast once a second: time moves the bar and the estimate even while the AI thinks
    const tick = setInterval(() => status(), progress?.tickMs ?? 1000)
    tick.unref?.()

    job.done = (async () => {
      const leaveGate = await gate?.enterJob()
      try {
        await idleWork?.pause()
        if (abort.signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
        // Inside the try: if even this fails, the user gets an error instead of a job that never ends.
        if (slug) {
          owner = await enter(slug)
          job.owner = owner.token
          await updateAppState(slug, (s) => {
            s.job = { id, kind, startedAt: new Date().toISOString(), note: opts.note }
            s.lastError = null
            // the work a pause waits for starts again; an export or a script leaves the pause to continue it
            if (kind === 'first-edit' || kind === 'note' || kind === 'rerender') delete s.paused
            if (kind === 'first-edit') s.status = 'working'
            opts.record?.(s)
          })
        }
        if (progress) {
          history = parseHistory(await progress.loadHistory().catch(() => history))
          progressKind = await progress.profile?.(kind) ?? kind
          tracker = new ProgressTracker(progressKind, 0, history)
        }
        status()
        // main.log gets each new status line and each AI step, timed, so a slow edit can be traced afterwards
        const t0 = Date.now()
        let logged = ''
        // What made a version is recorded where success is announced, only if this job's final render produced it
        // and it did not exist before (an unchanged edit re-renders, and so reuses, the current version).
        const existed = new Set(slug ? (await listVersions(projectDir(slug))).filter((v) => !v.draft).map((v) => v.n) : [])
        const finals = new Set<number>()
        // false once `fn` has settled: a stopped engine's late lines must not reach the screen
        let reporting = true
        // Stop pressed while the job waited for the gate or its project: its work never starts
        if (abort.signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
        const res = await fn((e) => {
          // A stopped engine can still report progress after its job has ended; the job's result wins.
          if (!reporting) return
          if (e.type === 'status') {
            if (e.message && e.message !== logged) log(`[job ${kind}] ${(logged = e.message)}`)
            job.message = e.message || job.message
            // Raw: per-step percents restart at 0; `overall` (progress.ts) is the whole job.
            if (typeof e.pct === 'number') job.pct = Math.max(0, Math.min(100, e.pct))
            // project.json exists once a phase after init starts: the estimate scales with it. Preparing a clip
            // happens inside init, before project.json is written, so it never asks.
            if (e.phase && e.phase !== 'prepare' && slug && progress && !mediaAsked) {
              mediaAsked = true
              pending.push(progress.mediaSeconds(slug).then((s) => {
                mediaSec = s
                tracker.setMedia(s)
              }).catch(() => undefined))
            }
            tracker.update(e.phase, e.pct, e.aggregate === true)
            if (e.phase) phase = e.phase
            if (rows) {
              rows.update({ message: e.message, phase, noAI: e.noAI })
              if (e.note) rows.note(e.note)
              job.steps = rows.steps()
            }
            job.thinking = !!e.thinking
            job.waiting = !!e.waiting
            status()
          } else if (e.type === 'tool') {
            log(`[job ${kind}] tool ${e.name}`)
            job.thinking = false // the AI answered
            job.waiting = false
            send({ jobId: id, slug, type: 'tool', name: e.name, summary: e.summary })
          } else if (e.type === 'render') {
            const r = e
            if (!r.draft) finals.add(r.version)
            const video = slug && toVideo ? toVideo(slug, r).catch(() => null) : Promise.resolve(null)
            // after the pictures made before it: a draft takes their place on screen, so none may land after it
            const inOrder = moments.then(() => video)
            pending.push(inOrder.then((v) => { if (open) send({ jobId: id, slug, type: 'render', version: r.version, draft: r.draft, firstLook: !!r.firstLook, video: v }) }))
          } else if (e.type === 'reply') send({ jobId: id, slug, type: 'reply', text: e.text })
          else if (e.type === 'trace') log(`[job ${kind}] ${e.text}`)
          else if (e.type === 'moment') {
            if (!slug || !toMoment) return
            const m = e
            moments = moments.then(() => toMoment(slug, m).catch(() => null)).then((url) => {
              // Stop pressed: the engine may still write a line before it is gone, and the job has not ended yet
              if (!url || !open || abort.signal.aborted) return
              send(m.kind === 'still'
                ? { jobId: id, slug, type: 'moment', kind: 'still', t: m.t, image: url, run: m.run }
                : { jobId: id, slug, type: 'moment', kind: 'window', from: m.from, to: m.to, video: url, run: m.run })
            })
            pending.push(moments)
          }
          else {
            if (rows) {
              rows.result('listen', `${e.words.length} words`)
              job.steps = rows.steps()
            }
            send({ jobId: id, slug, type: 'heard', words: e.words })
          }
        }, abort.signal, { id, owner: owner?.token ?? null }).finally(() => {
          reporting = false
        })
        await Promise.all(pending) // a render's event before `done`, never after
        if (progress && mediaSec > 0) {
          // what each phase really took on this computer: the next estimate starts from it
          await progress.saveHistory(learn(history, progressKind, mediaSec, tracker.finish())).catch(() => undefined)
        }
        // The work is saved: bookkeeping that fails now is logged, never reported as a failed job. The
        // job stays recorded in app.json then, and settleInterrupted finishes it before the next job.
        if (slug) {
          await updateAppState(slug, (s) => {
            s.job = null
            // a script is written for a reel with no video yet: it stays planned; a look for more reels changes no video
            if (kind !== 'script' && kind !== 'propose') s.status = 'ready'
            settleNote(s, id, res.outcome ?? 'done')
            // the job's id on its replies: the notes pair them with the attempt that wrote them (shared/notes-log.ts)
            s.chat.push(...(res.chat ?? [{ from: 'editor', text: res.summary, version: res.version }]).map((line) => stamp({ ...line, jobId: id })))
          }).catch((e) => log(`[job ${kind}] saved, but app.json was not updated: ${String(e)}`))
          const n = res.version
          if (res.made && n !== undefined && finals.has(n) && !existed.has(n)) {
            await recordVersionMade(slug, { version: n, ...res.made, at: new Date().toISOString() })
              .catch((e) => log(`[job ${kind}] saved, but the version's record was not: ${String(e)}`))
          }
        }
        log(`[job ${kind}] done in ${Math.round((Date.now() - t0) / 1000)} s`)
        ended = { jobId: id, slug, type: 'done', summary: res.summary, version: res.version }
      } catch (e) {
        open = false
        await Promise.allSettled(pending)
        const err = toUserError(e)
        const cancelled = err.code === 'CANCELLED' || abort.signal.aborted
        const paused = cancelled ? null : (opts.pause?.(e) ?? null)
        if (!cancelled) log(`[job ${kind}] ${err.code}: ${err.message ?? ''}${paused ? ` (paused: ${paused.reason})` : ''}`)
        if (slug && err.code === 'ENGINE_STUCK') stuck.set(slug, { code: err.code, userMessage: err.userMessage })
        // Without the project (an earlier job could not be settled) this job wrote nothing, and app.json's
        // record of that earlier job must stay for settleInterrupted. With a stuck engine nothing is
        // cleaned up or let go: it may still be writing.
        if (slug && owner && !stuck.has(slug)) {
          await cleanPartialVersions(projectDir(slug)).catch(() => [])
          await updateAppState(slug, (s) => {
            s.job = null
            if (kind === 'first-edit') s.status = cancelled || paused ? 'interrupted' : 'failed'
            if (paused) s.paused = paused
            // An export failure is shown in the export dialog; the video itself is fine.
            else if (!cancelled && kind !== 'export') s.lastError = { code: err.code, userMessage: err.userMessage }
            settleNote(s, id, cancelled ? 'stopped' : paused ? 'paused' : 'failed')
          }).catch(() => {})
        }
        if (slug && !cancelled && !paused && kind !== 'first-edit' && kind !== 'export')
          await updateAppState(slug, (s) => void s.chat.push(stamp({ from: 'editor', text: err.userMessage, jobId: id, ...(kind === 'script' ? { plan: true as const } : kind === 'propose' ? { reels: true as const } : {}) }))).catch(() => {})
        ended = cancelled ? { jobId: id, slug, type: 'cancelled' } : paused ? { jobId: id, slug, type: 'paused', paused } : { jobId: id, slug, type: 'error', code: err.code, userMessage: err.userMessage }
      } finally {
        clearInterval(tick)
        if (!(slug && stuck.has(slug))) await owner?.release().catch((e) => log(`[job ${kind}] could not let go of the project: ${String(e)}`))
        jobs.delete(id)
        leaveGate?.()
        // The job's last event goes out only now: a screen that reloads on it must find no job running
        // (projects:get reads forSlug), or it shows the progress row again after the note is done.
        if (ended) send(ended)
        if (ended?.type === 'done' || ended?.type === 'error' || ended?.type === 'cancelled') onEnded?.(kind, ended, (Date.now() - startedAt) / 1000)
        if (slug) freed(slug)
        // the last job is done: background indexing may go on
        if (!jobs.size) idleWork?.resume()
      }
    })()
    return id
  }

  /** The token of the job or manual edit that has each project open (`ownerToken`). */
  const tokens = new Map<string, string>()

  /** Marks the project open, then finishes a job app.json still records, before anything else writes. */
  async function enter(slug: string): Promise<ProjectOwner> {
    const claimed = await claimProject(projectDir(slug))
    tokens.set(slug, claimed.token)
    const owner: ProjectOwner = {
      token: claimed.token,
      release: async () => {
        if (tokens.get(slug) === claimed.token) tokens.delete(slug)
        await claimed.release()
      }
    }
    try {
      if ((await settleInterrupted(slug)) === 'unreadable') {
        throw { code: 'PROJECT_UNREADABLE', userMessage: 'This reel could not be read right now. Try again in a moment.' }
      }
      return owner
    } catch (e) {
      await owner.release()
      throw e
    }
  }

  /** Runs a quick change to a project (a manual edit) as its only writer: refused while a job runs
   * on it, and no job can start on it until `fn` is done. */
  async function hold<T>(slug: string, fn: (owner: string) => Promise<T>): Promise<T> {
    // a manual edit writes the project too: refused while new work is (the library moving, an update installing)
    assertCanStart()
    refuseIfBusy(slug)
    held.add(slug)
    try {
      const owner = await enter(slug)
      try {
        return await fn(owner.token)
      } catch (e) {
        const err = e as { code?: string; userMessage?: string }
        if (err?.code === 'ENGINE_STUCK') stuck.set(slug, { code: err.code, userMessage: err.userMessage ?? 'Part of Reel Studio\'s video engine is still running on this video.' })
        throw e
      } finally {
        if (!stuck.has(slug)) await owner.release()
      }
    } finally {
      held.delete(slug)
      freed(slug)
    }
  }

  /** A project kept closed for a previous run's engine (keepClosed) whose engine has exited. A job's own
   * stuck engine (ENGINE_STUCK) keeps its project closed until restart. */
  function reopen(slug: string): void {
    if (stuck.get(slug)?.code === 'ENGINE_STILL_RUNNING') stuck.delete(slug)
  }

  /** A project something of a previous run still writes to (orphans.ts reap): closed until it stops. */
  function keepClosed(slug: string): void {
    stuck.set(slug, { code: 'ENGINE_STILL_RUNNING', userMessage: "Part of Reel Studio's video engine from last time is still running on this reel. Quit and reopen Reel Studio in a few minutes, or restart your computer, before you change it." })
  }

  return {
    start,
    hold,
    /** Throws while a job runs on the project, a manual edit holds it, or it is kept closed: deleting
     * the video must wait. */
    refuseIfBusy,
    /** Throws while the project is kept closed, with the reason. A note or an attachment sent while a
     * job runs waits for that job (note-queue.ts, attachments.ts staging); one sent to a video kept
     * closed is refused instead. */
    refuseIfKeptClosed,
    isClosed,
    /** The owner token of the job or manual edit that has `slug` open, or null. Work that runs beside it on the
     * same project (the cover picker's scan) passes it as `--owner`, as the job's own engine commands do. */
    ownerToken: (slug: string): string | null => tokens.get(slug) ?? null,
    keepClosed,
    reopen,
    forSlug,
    /** Resolves once nothing runs on the project and no manual edit holds it. */
    whenFree(slug: string): Promise<void> {
      if (!forSlug(slug) && !held.has(slug)) return Promise.resolve()
      return new Promise((resolve) => freeWaiters.set(slug, [...(freeWaiters.get(slug) ?? []), resolve]))
    },
    get: (id: string) => jobs.get(id),
    /** What a job is showing now (its own words, or that it waits for the render slot). */
    message: shown,
    waitingForRender(owner: string, waiting: boolean): void {
      ;[...jobs.values()].find((j) => j.owner === owner)?.setWaitingForRender(waiting)
    },
    cancel(id: string): void {
      jobs.get(id)?.abort.abort()
    },
    async cancelAll(): Promise<void> {
      const all = [...jobs.values()]
      all.forEach((j) => j.abort.abort())
      await Promise.race([Promise.all(all.map((j) => j.done)), new Promise((r) => setTimeout(r, 4000))])
    },
    runningCount: () => jobs.size,
    /** Whether anything is writing a project now: a job or a manual edit. The library must not move meanwhile. */
    writing: () => jobs.size > 0 || held.size > 0,
    /** Reels a version is being made for (a first edit, a note, a hand edit): what a quit asks about. */
    making: (): string[] => [...new Set([...jobs.values()].filter((j) => j.slug && (j.kind === 'first-edit' || j.kind === 'note' || j.kind === 'rerender')).map((j) => j.slug!))]
  }
}

export type JobManager = ReturnType<typeof createJobManager>
