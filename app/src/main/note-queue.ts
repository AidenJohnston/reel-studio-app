// Every note a creator sends becomes an entry in its reel's queue in app.json, flushed to disk before
// the send returns. Entries run one at a time, oldest first, each as a note job on whatever version is
// newest by then. An entry's id is the id the note is saved under in project.json.notes, so the commit
// that publishes the note is also the proof it ran: an entry leaves the queue only once its id is there
// (a note that changed nothing is saved too). The queue runs on by itself only after a saved note. Stop,
// a failure and a restart hold it until Resume, so nothing the creator stopped to rethink applies behind
// their back. A stopped note that was not saved waits again at the top, to edit or try again.
// A note shows in one place: a waiting row, or from the moment it starts, a "you" message in the chat.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { JobEvent, NoteAttachment, QueuedNote } from '../shared/api'
import type { JobManager } from './jobs'
import { toUserError } from './engine'
import { dropStaged, pruneStaging } from './attachments'
import type { ChatLine } from './style-consent'
import { noteStagingDir } from './paths'
import { listProjects, projectDir, readAppState, readJson, serialized, stamp, updateAppState, type AppState } from './store'

export interface NoteToRun {
  /** saved with the note in project.json.notes (ai applyNote `opts.id`) */
  id: string
  text: string
  attachments: NoteAttachment[]
}

/** Starts a note job (index.ts). `record` goes into the app.json write that marks the job running. */
export type StartNote = (slug: string, note: NoteToRun, record: (s: AppState) => void) => Promise<string>

const STARTED = { code: 'NOT_QUEUED', userMessage: 'That note already started, so it can no longer change.' }
export const STOPPED = 'Stopped. Nothing changed. Your note is waiting below: edit it, or press Resume to try it again.'
export const BACK_IN_QUEUE = 'That note is waiting below. Press Resume to try it again.'

/** The saved notes' ids, or null when project.json can't be read or its notes are not a list. */
async function committed(slug: string): Promise<{ version: number; ids: Set<string> } | null> {
  const p = await readJson<{ version?: number; notes?: { id?: unknown }[] } | null>(join(projectDir(slug), 'project.json'), null)
  if (!p || (p.notes !== undefined && !Array.isArray(p.notes))) return null
  return { version: Number(p.version) || 0, ids: new Set((p.notes ?? []).map((n) => (typeof n?.id === 'string' ? n.id : ''))) }
}

/** What the editor says when a queued note's job ends without its own reply. `savedAs`: the version it
 * was saved as, null when project.json does not have it (or, `readable` false, could not be read). */
function endLine(byStop: boolean, savedAs: number | null, readable: boolean, type: JobEvent['type']): ChatLine | null {
  if (byStop) {
    if (savedAs === null) return { from: 'editor', text: readable ? STOPPED : 'Stopped.' }
    return type === 'done' ? null : { from: 'editor', text: `That change was saved before you pressed Stop. It is Version ${savedAs}.`, version: savedAs }
  }
  return savedAs === null && type === 'error' ? { from: 'editor', text: BACK_IN_QUEUE } : null
}

/** Files the queue or the chat still shows. */
const referenced = (s: AppState): NoteAttachment[] => [...(s.queue ?? []), ...s.chat].flatMap((x) => x.attachments ?? [])

/** Entries that are not running wait again: they leave the chat and the queue holds. */
function backToWaiting(s: AppState): void {
  for (const q of s.queue ?? []) delete q.attempt
  const waiting = new Set((s.queue ?? []).map((q) => q.id))
  s.chat = s.chat.filter((m) => !(m.from === 'you' && waiting.has(m.id)))
  if (s.queue?.length) s.queueHeld = true
}

export function createNoteQueue(deps: { jobs: JobManager; startNote: StartNote; changed: (slug: string) => void; log: (s: string) => void }) {
  const { jobs, startNote } = deps
  const lane = <T>(slug: string, fn: () => Promise<T>): Promise<T> => serialized(`queue:${slug}`, fn)
  /** Jobs the creator pressed Stop on. A quit cancels jobs too, but its note must come back. */
  const stopped = new Set<string>()
  let quitting = false
  const staging = (slug: string): string => noteStagingDir(projectDir(slug))

  async function change(slug: string, fn: (s: AppState) => void): Promise<AppState> {
    const s = await updateAppState(slug, fn, { durable: true })
    deps.changed(slug)
    return s
  }

  /** Starts the oldest entry when nothing runs on the reel and the queue is not held. Returns its job id. */
  function pump(slug: string): Promise<string | null> {
    return lane(slug, async () => {
      if (quitting || jobs.forSlug(slug)) return null
      const st = await readAppState(slug)
      if (!st.queue?.length || st.queueHeld) return null
      // still marked started while nothing runs: a run that died before startup recovery cleared it
      if (st.queue[0].attempt) {
        await change(slug, backToWaiting)
        return null
      }
      const head = await committed(slug)
      if (!head) {
        await change(slug, (s) => void (s.queueHeld = true))
        return null
      }
      // an entry project.json already has is done: its job's end found project.json unreadable
      const next = (await change(slug, (s) => {
        s.queue = (s.queue ?? []).filter((q) => !head.ids.has(q.id))
        if (s.queue[0]) s.queue[0].attempt = { base: head.version }
      })).queue?.[0]
      if (!next) return null
      return startNote(slug, next, (s) => {
        s.job!.noteId = next.id
        if (!s.chat.some((m) => m.id === next.id)) {
          s.chat.push({ ...stamp({ from: 'you', text: next.text, ...(next.attachments.length ? { attachments: next.attachments } : {}) }), id: next.id })
        }
      }).catch(async (e) => {
        const err = toUserError(e)
        if (err.code === 'BUSY') {
          // a manual edit or another job took the video first: this note never started, and goes first
          // again once the video is free
          await change(slug, (s) => {
            if (s.queue?.[0]) delete s.queue[0].attempt
          })
          void jobs.whenFree(slug).then(() => pump(slug))
          return null
        }
        deps.log(`[queue] ${slug}: could not start the next note: ${err.code}`)
        await change(slug, (s) => {
          backToWaiting(s)
          s.chat.push(stamp({ from: 'editor', text: err.userMessage }))
        })
        return null
      })
    })
  }

  /** The entry, while it still waits; one that has started cannot change. */
  function stillWaiting(s: AppState, id: string): QueuedNote {
    const q = s.queue?.find((x) => x.id === id)
    if (!q || q.attempt) throw STARTED
    return q
  }

  return {
    /** A note from the Reel screen. `seenVersion`: the version on screen when it was written. */
    async send(slug: string, note: Omit<NoteToRun, 'id'>, seenVersion: number): Promise<{ jobId: string | null; queued?: boolean }> {
      const entry: QueuedNote = { id: randomUUID(), ...note, seenVersion }
      let first = false
      await lane(slug, () =>
        change(slug, (s) => {
          // a send to an empty queue starts it again: the hold is about notes that were already waiting
          first = !s.queue?.length
          if (first) s.queueHeld = false
          s.queue = [...(s.queue ?? []), entry]
        })
      )
      const started = await pump(slug)
      return started && first ? { jobId: started } : { jobId: null, queued: true }
    },

    edit(slug: string, id: string, text: string): Promise<void> {
      const t = text.trim()
      if (!t) throw { code: 'EMPTY', userMessage: 'Type what you would like changed first, or cancel this note.' }
      return lane(slug, () => change(slug, (s) => void (stillWaiting(s, id).text = t))).then(() => undefined)
    },

    cancel(slug: string, id: string): Promise<void> {
      return lane(slug, async () => {
        let attached: NoteAttachment[] = []
        const after = await change(slug, (s) => {
          attached = stillWaiting(s, id).attachments
          s.queue = (s.queue ?? []).filter((q) => q.id !== id)
        })
        await dropStaged(staging(slug), attached, referenced(after))
      })
    },

    move(slug: string, id: string, by: -1 | 1): Promise<void> {
      return lane(slug, () =>
        change(slug, (s) => {
          const q = s.queue!
          const i = q.indexOf(stillWaiting(s, id))
          const j = i + by
          if (j < 0 || j >= q.length || q[j].attempt) return
          ;[q[i], q[j]] = [q[j], q[i]]
        })
      ).then(() => undefined)
    },

    /** Stop on the Reel screen: the note running now goes back to the top of the queue, unless it was
     * saved already, and the queue is held. When that job has already ended (the screen was behind), the
     * notes waiting are held all the same. */
    async stop(jobId: string, slug?: string): Promise<void> {
      if (jobs.get(jobId)) {
        stopped.add(jobId)
        jobs.cancel(jobId)
      } else if (slug) {
        await lane(slug, () =>
          change(slug, (s) => {
            if (s.queue?.length) s.queueHeld = true
          })
        )
      }
    },

    /** The app is quitting: no note starts from now on. */
    quit(): void {
      quitting = true
    },

    /** Deletes a video inside its queue lane, after its job (if any) has ended, so no queue write lands in
     * the folder while it goes. A video still closed after that is refused (jobs.ts refuseIfBusy). */
    remove(slug: string, removeFolders: () => Promise<void>): Promise<void> {
      return lane(slug, async () => {
        const running = jobs.forSlug(slug)
        if (running) {
          stopped.add(running.id)
          jobs.cancel(running.id)
          await running.done
        }
        // a video kept closed stays: part of its engine may still be writing into the folder
        jobs.refuseIfBusy(slug)
        await removeFolders()
      })
    },

    /** Runs the waiting notes again, from the first, after Stop, a failure or a restart. */
    resume(slug: string): Promise<void> {
      return lane(slug, () => change(slug, (s) => void (s.queueHeld = false))).then(() => pump(slug)).then(() => undefined)
    },

    clear(slug: string): Promise<void> {
      return lane(slug, async () => {
        const before = (await readAppState(slug)).queue ?? []
        const after = await change(slug, (s) => {
          s.queue = (s.queue ?? []).filter((q) => q.attempt)
          s.queueHeld = false
        })
        await dropStaged(staging(slug), before.filter((q) => !q.attempt).flatMap((q) => q.attachments), referenced(after))
      })
    },

    /** Every job event (index.ts). Once a job on a reel has fully ended, its entry leaves the queue if
     * the note was saved; a stopped or failed one stays first, for Resume to try again. The next note runs
     * only after a job nobody stopped finished and saved its note; any other end holds the queue. When
     * project.json cannot be read, the note stays (unless stopped) and the next promotion reconciles it.
     * Decided in the reel's queue lane, so a note sent meanwhile waits for the decision. Resolves once
     * the queue has acted on it. */
    async onJobEvent(e: JobEvent): Promise<void> {
      if (!e.slug || (e.type !== 'done' && e.type !== 'error' && e.type !== 'cancelled')) return
      const slug = e.slug
      const ended = jobs.get(e.jobId)?.done ?? Promise.resolve()
      await lane(slug, async () => {
        await ended
        // read only now: a Stop can still land between the job's last event and its end
        const byStop = stopped.delete(e.jobId)
        const st = await readAppState(slug)
        const ran = st.queue?.find((q) => q.attempt)
        const head = ran ? await committed(slug) : null
        const savedAs = ran && head?.ids.has(ran.id) ? head.version : null
        const runOn = e.type === 'done' && !byStop && (savedAs !== null || !ran)
        if (!ran && runOn) return true
        await change(slug, (s) => {
          if (ran) {
            if (savedAs !== null) s.queue = (s.queue ?? []).filter((q) => q.id !== ran.id)
            const line = endLine(byStop, savedAs, head !== null, e.type)
            if (line) s.chat.push(stamp(line))
          }
          if (!runOn) backToWaiting(s)
        })
        return runOn
      })
        .then((runOn) => (runOn ? pump(slug) : null))
        .catch((err) => void deps.log(`[queue] ${slug}: ${String(err)}`))
    },

    /** At startup, after recoverInterrupted: an entry whose note project.json already has is done (the
     * app stopped between saving it and taking it off the queue); every other entry waits for Resume.
     * Staged files no entry or message needs are deleted. A video that can't be settled now is skipped;
     * a note it still marks started holds its queue when it would run (pump). */
    async recover(): Promise<void> {
      for (const p of await listProjects()) {
        try {
          const st = await readAppState(p.slug)
          if (st.queue?.length) {
            const head = await committed(p.slug)
            await updateAppState(p.slug, (s) => {
              s.queue = (s.queue ?? []).filter((q) => !head?.ids.has(q.id))
              backToWaiting(s)
            }, { durable: true })
          }
          await pruneStaging(staging(p.slug), referenced(await readAppState(p.slug)))
        } catch (e) {
          deps.log(`[queue] ${p.slug}: could not settle at startup: ${String(e)}`)
        }
      }
    }
  }
}

export type NoteQueue = ReturnType<typeof createNoteQueue>
