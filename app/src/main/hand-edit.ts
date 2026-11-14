// A change made in "Edit it myself", run when its turn in the reel's queue comes (note-queue.ts). It lands on
// the newest project.json, whatever notes ran before it, and like a note it is all-or-nothing: the edited
// project is rendered from a private copy (work/hand/<id>/edit.json) and replaces project.json in one write
// only after its final render, with the edit's id in `handEdits` (the queue's proof it ran, as a note's id in
// `notes` is). A failure, Stop or quit before that leaves the project as it was.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { QueuedNote } from '../shared/api'
import { versionMessage } from '../shared/describe'
import { applyHandEdit } from '../shared/hand-edit'
import type { JobFn } from './jobs'
import type { RunEngine } from './engine'
import { projectDir, readProject, readWords, writeJson, writeProject } from './store'

export const HAND_MESSAGE = 'Making your changes'
/** Enough ids to outlast any queue; older ones only grow project.json. */
const HANDS_KEPT = 20

export function handEditJob(runEngine: RunEngine, slug: string, entry: QueuedNote & { hand: NonNullable<QueuedNote['hand']> }): JobFn {
  return async (emit, signal, { id, owner }) => {
    const dir = projectDir(slug)
    const work = join(dir, 'work', 'hand', entry.id)
    const file = join(work, 'edit.json')
    const rel = ['work', 'hand', entry.id, 'edit.json'].join('/')
    const own = (args: string[]): string[] => (owner ? [...args, '--owner', owner] : args)
    // an engine that would not stop may still write in work/hand/<id>: its folder stays, as the job keeps the project (jobs.ts)
    let stuck = false
    try {
      emit({ type: 'status', message: HAND_MESSAGE, pct: 1, phase: 'final', aggregate: true })
      const base = await readProject(slug)
      await fs.mkdir(work, { recursive: true })
      await writeJson(file, applyHandEdit(base, entry.hand.edit, await readWords(dir, base)))
      const look: any = await runEngine(
        'render',
        own(['--project', dir, '--project-file', rel, '--draft', '--no-cover']),
        (p) => p.stage === 'render' && emit({ type: 'status', message: HAND_MESSAGE, pct: Math.round(p.pct * 0.3), phase: 'final', aggregate: true }),
        signal
      )
      emit({ type: 'render', version: Number(look?.version ?? 0), draft: true, ...(look?.file ? { file: String(look.file) } : {}) })
      const r: any = await runEngine(
        'render',
        // the job's id goes in the version's receipt (engine render --job-id)
        own(['--project', dir, '--project-file', rel, '--job-id', id]),
        (p) => p.stage === 'render' && emit({ type: 'status', message: HAND_MESSAGE, pct: 30 + Math.round(p.pct * 0.7), phase: 'final', aggregate: true }),
        signal
      )
      if (signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
      const done = JSON.parse(await fs.readFile(file, 'utf8'))
      const version = Number(r?.version ?? done.version)
      done.handEdits = [...(Array.isArray(done.handEdits) ? done.handEdits : []), entry.id].slice(-HANDS_KEPT)
      // Durable: the queue's record that this edit ran is written durably right after (jobs.ts, note-queue.ts), so
      // the edit itself must be on disk first, or a power cut could keep the record and lose the edit. Stop that
      // arrives during this write still keeps the project as it was.
      await writeProject(slug, done, { durable: true, signal })
      emit({ type: 'render', version, draft: false, ...(r?.file ? { file: String(r.file) } : {}) })
      return { summary: versionMessage(version, entry.text), version, made: { by: 'hand', summary: entry.text } }
    } catch (e) {
      stuck = (e as { code?: unknown } | null)?.code === 'ENGINE_STUCK'
      throw e
    } finally {
      if (!stuck) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
