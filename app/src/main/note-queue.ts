// Every note a creator sends becomes an entry in its reel's queue in app.json, flushed to disk before
// the send returns. Entries run one at a time, oldest first, each as a note job on whatever version is
// newest by then. An entry's id is the id the note is saved under in project.json.notes, so the commit
// that publishes the note is also the proof it ran: an entry leaves the queue only once its id is there.
// The queue runs on by itself only after a committed note. Stop, a failure and a restart hold it until
// "Run next", so nothing the creator stopped to rethink applies behind their back.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { JobEvent, NoteAttachment, QueuedNote } from '../shared/api'
import type { JobManager } from './jobs'
import { toUserError } from './engine'
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

async function committed(slug: string): Promise<{ version: number; ids: Set<string> } | null> {
  const p = await readJson<{ version?: number; notes?: { id?: string }[] } | null>(join(projectDir(slug), 'project.json'), null)
  return p && { version: Number(p.version) || 0, ids: new Set((p.notes ?? []).map((n) => n.id ?? '')) }
}

export function createNoteQueue(deps: { jobs: JobManager; startNote: StartNote; changed: (slug: string) => void; log: (s: string) => void }) {
  const { jobs, startNote } = deps
  const lane = <T>(slug: string, fn: () => Promise<T>): Promise<T> => serialized(`queue:${slug}`, fn)
  /** Jobs the creator pressed Stop on. A quit cancels jobs too, but its note must come back. */
  const stopped = new Set<string>()

  async function change(slug: string, fn: (s: AppState) => void): Promise<void> {
    await updateAppState(slug, fn, { durable: true })
    deps.changed(slug)
  }

  /** Starts the oldest entry when nothing runs on the reel and the queue is not held. Returns its job id. */
  function pump(slug: string): Promise<string | null> {
    return lane(slug, async () => {
      if (jobs.forSlug(slug)) return null
      const st = await readAppState(slug)
      const next = st.queue?.[0]
      if (!next || st.queueHeld) return null
      const head = await committed(slug)
      if (!head) {
        await change(slug, (s) => void (s.queueHeld = true))
        return null
      }
      await change(slug, (s) => void (s.queue![0].attempt = { base: head.version }))
      return startNote(slug, next, (s) => {
        s.job!.noteId = next.id
        if (!s.chat.some((m) => m.id === next.id)) {
          s.chat.push({ ...stamp({ from: 'you', text: next.text, ...(next.attachments.length ? { attachments: next.attachments } : {}) }), id: next.id })
        }
      }).catch(async (e) => {
        deps.log(`[queue] ${slug}: could not start the next note: ${toUserError(e).code}`)
        await change(slug, (s) => {
          delete s.queue![0].attempt
          s.queueHeld = true
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
      return lane(slug, () => change(slug, (s) => void (stillWaiting(s, id).text = t)))
    },

    cancel(slug: string, id: string): Promise<void> {
      return lane(slug, () =>
        change(slug, (s) => {
          stillWaiting(s, id)
          s.queue = s.queue!.filter((q) => q.id !== id)
        })
      )
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
      )
    },

    /** Stop on the Reel screen: the note running now is dropped and the ones behind it are held. */
    stop(jobId: string): void {
      stopped.add(jobId)
      jobs.cancel(jobId)
    },

    runNext(slug: string): Promise<void> {
      return lane(slug, () => change(slug, (s) => void (s.queueHeld = false))).then(() => void pump(slug))
    },

    clear(slug: string): Promise<void> {
      return lane(slug, () =>
        change(slug, (s) => {
          s.queue = (s.queue ?? []).filter((q) => q.attempt)
          s.queueHeld = false
        })
      )
    },

    /** Every job event (index.ts). Once a job on a reel has fully ended, its entry leaves the queue if
     * the note was saved or stopped; a failed one stays first, for "Run next" to try again. The next
     * note runs only after a finished job; any other end holds the queue.
     * Decided in the reel's queue lane, so a note sent meanwhile waits for the decision. */
    onJobEvent(e: JobEvent): void {
      if (!e.slug || (e.type !== 'done' && e.type !== 'error' && e.type !== 'cancelled')) return
      const slug = e.slug
      const ended = jobs.get(e.jobId)?.done ?? Promise.resolve()
      const byStop = stopped.delete(e.jobId)
      void lane(slug, async () => {
        await ended
        const st = await readAppState(slug)
        const ran = st.queue?.find((q) => q.attempt)
        const saved = !!ran && !!(await committed(slug))?.ids.has(ran.id)
        const drop = saved || (byStop && !!ran)
        const runOn = e.type === 'done' && (saved || !ran)
        if (!ran && runOn) return true
        await change(slug, (s) => {
          s.queue = (s.queue ?? []).filter((q) => !(drop && q.id === ran!.id))
          for (const q of s.queue) delete q.attempt
          if (!runOn && s.queue.length) s.queueHeld = true
        })
        return runOn
      })
        .then((runOn) => (runOn ? pump(slug) : null))
        .catch((err) => deps.log(`[queue] ${slug}: ${String(err)}`))
    },

    /** At startup, after recoverInterrupted: an entry whose note project.json already has is done (the
     * app stopped between saving it and taking it off the queue); every other entry waits for "Run next". */
    async recover(): Promise<void> {
      for (const p of await listProjects()) {
        if (!(await readAppState(p.slug)).queue?.length) continue
        const head = await committed(p.slug)
        await updateAppState(p.slug, (s) => {
          s.queue = (s.queue ?? []).filter((q) => !head?.ids.has(q.id))
          for (const q of s.queue) delete q.attempt
          s.queueHeld = s.queue.length > 0
        }, { durable: true })
      }
    }
  }
}

export type NoteQueue = ReturnType<typeof createNoteQueue>
