// The note queue (main/note-queue.ts) under random sequences of what a creator and the computer can do on
// two reels: send, edit, cancel and reorder notes, Stop (also after a note was saved), a failed AI step,
// a failed render, a note that changes nothing, a crash on either side of a note's save, a restart, and
// Resume. The real queue, job manager, render slot and app.json/project.json run; the AI's work and the
// engine's render are stand-ins that wait at gates until the sequence says how they end, and after each
// step the test waits until the queue has acted on every job event and every job waits at a gate.
//
// Checked throughout, as the formal model of the same rules names them (queue-formal on Sam's fork):
//   NoDoubleCommit      a note id is saved once, and a note whose id is saved never starts again;
//   NoAdmittedLost      a sent note is waiting, saved, or one the creator cancelled or stopped;
//   AdmissionBeforeAck  a send resolves only once its note is in app.json;
//   OneRender           at most one render runs at a time across reels;
//   OneProjectJob       at most one note runs per reel;
//   HoldUntilResume     after Stop, a failure or a restart nothing starts until Resume. Deliberate
//                       difference from the model: a send to an empty queue also releases the hold
//                       (nothing it holds back is waiting);
//   NoDeadlock          a reel with waiting notes that is not held is running one, and a reel waits for
//                       the render slot only while something renders;
//   TypeOK              only the first entry can be marked started, and only while its job runs.
// Plus, from the model of the Reel screen: a waiting note is never also a message in the chat, and the
// order and text on disk match what the creator did.
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { createNoteQueue } from '../src/main/note-queue'
import { withRenderSlot } from '../src/main/render-slot'
import { clearStaleLocks } from '../src/main/owner'
import { projectDir, readAppState, readProject, recoverInterrupted, writeJson, writeProject } from '../src/main/store'
import type { RunEngine } from '../src/main/engine'
import { setupPaths } from './helpers'

const REELS = ['reel-a', 'reel-b'] as const
type Reel = 0 | 1
const reelOf = (slug: string): Reel => REELS.indexOf(slug as (typeof REELS)[number]) as Reel

type Cmd =
  | { t: 'send'; reel: Reel }
  | { t: 'edit'; reel: Reel; k: number }
  | { t: 'cancel'; reel: Reel; k: number }
  | { t: 'move'; reel: Reel; k: number; by: -1 | 1 }
  | { t: 'stop'; reel: Reel }
  /** the running note's AI work ends: on to its render, an AI error, or nothing to change (saved, no
   * render). A note held after its save finishes its bookkeeping instead. */
  | { t: 'think'; reel: Reel; how: 'ok' | 'fail' | 'unchanged' }
  /** the render in the engine ends: the note is saved (and its job ends, or stays in its bookkeeping), or
   * the render fails */
  | { t: 'render'; how: 'ok' | 'ok-held' | 'fail' }
  | { t: 'resume'; reel: Reel }
  /** the app dies (`afterSave`: right after a render's note was saved) and starts again */
  | { t: 'crash'; afterSave: boolean }

const reel = fc.constantFrom<Reel>(0, 1)
// mostly ok: a run that fails at every step never gets two reels rendering at once
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('send' as const), reel }), weight: 6 },
  { arbitrary: fc.record({ t: fc.constant('edit' as const), reel, k: fc.nat(3) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant('cancel' as const), reel, k: fc.nat(3) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant('move' as const), reel, k: fc.nat(3), by: fc.constantFrom<-1 | 1>(-1, 1) }), weight: 4 },
  { arbitrary: fc.record({ t: fc.constant('stop' as const), reel }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('think' as const), reel, how: fc.constantFrom('ok' as const, 'ok' as const, 'fail' as const, 'unchanged' as const) }), weight: 6 },
  { arbitrary: fc.record({ t: fc.constant('render' as const), how: fc.constantFrom('ok' as const, 'ok' as const, 'ok-held' as const, 'fail' as const) }), weight: 5 },
  { arbitrary: fc.record({ t: fc.constant('resume' as const), reel }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('crash' as const), afterSave: fc.boolean() }), weight: 2 }
)

type Release<T> = (how: T) => void
const CANCELLED = { code: 'CANCELLED', userMessage: 'Stopped.' }
const never = new Promise<never>(() => undefined)

function savedIds(slug: string): string[] {
  return (JSON.parse(readFileSync(join(projectDir(slug), 'project.json'), 'utf8')).notes ?? []).map((n: { id: string }) => n.id)
}

/** What the rules say each reel's queue holds. `running`: the note whose job is alive, saved or not. */
class Model {
  order: string[][] = [[], []]
  text = new Map<string, string>()
  running: (string | null)[] = [null, null]
  held = [false, false]
}

/** One run of the app: a job manager, a render slot and a queue over the shared folders. */
function boot(problems: string[]) {
  const think = new Map<string, Release<'ok' | 'fail' | 'unchanged'>>()
  const bookkeeping = new Map<string, () => void>()
  const engine: { slug: string; release: Release<'ok' | 'ok-held' | 'fail' | 'save-and-die'> }[] = []
  /** notes whose job reached the AI, in order, checked against the model once the step is done */
  const started: { reel: Reel; id: string; text: string }[] = []
  const active = new Set<string>()
  let rendering = 0
  let waitingForSlot = 0
  let dying = false

  const fakeEngine: RunEngine = async (_command, args, _onProgress, signal) => {
    const slug = REELS.find((s) => args[1] === projectDir(s))!
    if (++rendering > 1) problems.push(`OneRender: ${rendering} renders at once`)
    try {
      return await new Promise((resolve, reject) => {
        engine.push({ slug, release: (how) => (how === 'fail' ? reject({ code: 'RENDER_FAILED', userMessage: 'The render failed.' }) : resolve(how)) })
        signal?.addEventListener('abort', () => reject(CANCELLED), { once: true })
      })
    } finally {
      rendering--
      engine.splice(engine.findIndex((e) => e.slug === slug), 1)
    }
  }
  const runEngine = withRenderSlot(fakeEngine, (owner, waiting) => {
    waitingForSlot += waiting ? 1 : -1
    jobs.waitingForRender(owner, waiting)
  }).run

  async function save(slug: string, id: string, text: string, newVersion: boolean): Promise<number> {
    const p = await readProject(slug)
    const version = (p.version ?? 0) + (newVersion ? 1 : 0)
    await writeProject(slug, { ...p, version, notes: [...(p.notes ?? []), { id, version, text, applied: [], at: '' }] })
    return version
  }

  const pending = new Set<Promise<void>>()
  const jobs = createJobManager((e) => {
    const p = queue.onJobEvent(e)
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }, () => undefined)
  const queue = createNoteQueue({
    jobs,
    changed: () => undefined,
    log: () => undefined,
    startNote: async (slug, note, record) =>
      jobs.start(slug, 'note', async (_emit, signal, { owner }) => {
        if (active.has(slug)) problems.push(`OneProjectJob: two notes run on ${slug}`)
        active.add(slug)
        try {
          if (savedIds(slug).includes(note.id)) problems.push(`NoDoubleCommit: saved note ${note.text} started again`)
          started.push({ reel: reelOf(slug), id: note.id, text: note.text })
          const thought = await new Promise<string>((resolve, reject) => {
            think.set(slug, (how) => (how === 'fail' ? reject({ code: 'AI_FAILED', userMessage: 'The AI failed.' }) : resolve(how)))
            signal.addEventListener('abort', () => reject(CANCELLED), { once: true })
          }).finally(() => think.delete(slug))
          if (thought === 'unchanged') {
            await save(slug, note.id, note.text, false)
            return { summary: 'It already looks right.' }
          }
          const how = await runEngine('render', ['--project', projectDir(slug), '--owner', owner!], undefined, signal)
          const version = await save(slug, note.id, note.text, true)
          if (how === 'save-and-die') {
            dying = true
            await never
          }
          // bookkeeping after the save (jobs.ts), where a Stop is too late to undo the note
          if (how === 'ok-held') await new Promise<void>((resolve) => bookkeeping.set(slug, resolve)).finally(() => bookkeeping.delete(slug))
          return { summary: `Version ${version}`, version }
        } finally {
          active.delete(slug)
        }
      }, { record })
  })

  return {
    jobs,
    queue,
    think,
    bookkeeping,
    engine,
    started,
    /** At rest: the queue has acted on every job event, and every job waits at a gate the sequence opens. */
    atRest: () => pending.size === 0 && think.size + bookkeeping.size + engine.length + waitingForSlot === jobs.runningCount(),
    slotLeaked: () => waitingForSlot > 0 && engine.length === 0,
    dying: () => dying
  }
}

async function settle(app: ReturnType<typeof boot>): Promise<void> {
  for (let i = 0; i < 20_000; i++) {
    await new Promise((r) => setTimeout(r, 1))
    if (app.atRest()) return
  }
  throw new Error('the queue never came to rest')
}

async function run(cmds: Cmd[]): Promise<void> {
  setupPaths()
  for (const s of REELS) {
    mkdirSync(projectDir(s), { recursive: true })
    await writeJson(join(projectDir(s), 'project.json'), { title: s, version: 1, notes: [] })
  }
  const model = new Model()
  const problems: string[] = []
  let app = boot(problems)
  const gone = new Set<string>()

  const left = (r: Reel, id: string): void => {
    model.order[r] = model.order[r].filter((x) => x !== id)
  }
  const failed = (r: Reel): void => {
    model.held[r] = true
    model.running[r] = null
  }

  for (const c of cmds) {
    let slug: string = 'reel' in c ? REELS[c.reel] : ''
    let r: Reel = 'reel' in c ? c.reel : 0
    // the running note too: changing it must be refused
    const pick = (k: number): string | undefined => model.order[r][k % Math.max(1, model.order[r].length)]
    const refused = async (change: Promise<unknown>): Promise<boolean> => {
      const err = await change.then(() => null, (e) => e)
      if (err?.code !== 'NOT_QUEUED') problems.push(`changing the running note was ${err ? err.code : 'allowed'}`)
      return true
    }
    switch (c.t) {
      case 'send': {
        const text = `note ${model.text.size + 1}`
        if (!model.order[r].length) model.held[r] = false
        const before = new Set(((await readAppState(slug)).queue ?? []).map((q) => q.id))
        await app.queue.send(slug, { text, attachments: [] }, 1)
        const added = ((await readAppState(slug)).queue ?? []).filter((q) => !before.has(q.id))
        if (added.length !== 1) {
          problems.push(`AdmissionBeforeAck: a send resolved with ${added.length} new notes in app.json`)
          break
        }
        model.order[r].push(added[0].id)
        model.text.set(added[0].id, text)
        break
      }
      case 'edit': {
        const id = pick(c.k)
        if (!id || (id === model.running[r] && (await refused(app.queue.edit(slug, id, 'changed while running'))))) break
        const text = `${model.text.get(id)}+`
        await app.queue.edit(slug, id, text)
        model.text.set(id, text)
        break
      }
      case 'cancel': {
        const id = pick(c.k)
        if (!id || (id === model.running[r] && (await refused(app.queue.cancel(slug, id))))) break
        await app.queue.cancel(slug, id)
        left(r, id)
        gone.add(id)
        break
      }
      case 'move': {
        const id = pick(c.k)
        if (!id || (id === model.running[r] && (await refused(app.queue.move(slug, id, c.by))))) break
        await app.queue.move(slug, id, c.by)
        const o = model.order[r]
        const i = o.indexOf(id)
        const j = i + c.by
        if (j >= 0 && j < o.length && o[j] !== model.running[r]) [o[i], o[j]] = [o[j], o[i]]
        break
      }
      case 'stop': {
        // a reel with nothing running stops the one rendering: the Stop that frees the slot for the other
        if (!app.jobs.forSlug(slug) && app.engine[0]) {
          r = reelOf(app.engine[0].slug)
          slug = REELS[r]
        }
        const job = app.jobs.forSlug(slug)
        if (!job) break
        const id = model.running[r]
        app.queue.stop(job.id)
        model.held[r] = true
        // already saved: the job finishes its bookkeeping and its note leaves the queue then
        if (app.bookkeeping.has(slug)) break
        model.running[r] = null
        if (id && model.order[r].includes(id)) {
          left(r, id)
          gone.add(id)
        }
        break
      }
      case 'think': {
        const end = app.bookkeeping.get(slug)
        if (end) {
          left(r, model.running[r]!)
          model.running[r] = null
          end()
          break
        }
        const release = app.think.get(slug)
        if (!release) break
        if (c.how === 'fail') failed(r)
        else if (c.how === 'unchanged') {
          left(r, model.running[r]!)
          model.running[r] = null
        }
        release(c.how)
        break
      }
      case 'render': {
        const e = app.engine[0]
        if (!e) break
        const er = reelOf(e.slug)
        if (c.how === 'fail') failed(er)
        else if (c.how === 'ok') {
          left(er, model.running[er]!)
          model.running[er] = null
        }
        e.release(c.how)
        break
      }
      case 'resume':
        model.held[r] = false
        await app.queue.resume(slug)
        break
      case 'crash': {
        const e = app.engine[0]
        if (c.afterSave && e) {
          e.release('save-and-die')
          for (let i = 0; i < 20_000 && !app.dying(); i++) await new Promise((res) => setTimeout(res, 1))
        }
        // the old run's jobs wait at their gates forever, as a dead process would; a saved note is done
        for (const x of [0, 1] as Reel[]) {
          model.order[x] = model.order[x].filter((id) => !savedIds(REELS[x]).includes(id))
          model.running[x] = null
          model.held[x] = true
        }
        await clearStaleLocks([])
        await recoverInterrupted()
        app = boot(problems)
        await app.queue.recover()
        break
      }
    }
    await settle(app)

    for (const s of app.started.splice(0)) {
      if (model.held[s.reel]) problems.push(`HoldUntilResume: ${s.text} started while ${REELS[s.reel]} was held`)
      if (model.order[s.reel][0] !== s.id) problems.push(`${s.text} started out of order`)
      if (model.text.get(s.id) !== s.text) problems.push(`${s.text} lost an edit`)
      model.running[s.reel] = s.id
    }
    if (app.slotLeaked()) problems.push('NoDeadlock: a reel waits for the render slot but nothing renders')
    const saved = [...savedIds(REELS[0]), ...savedIds(REELS[1])]
    if (new Set(saved).size !== saved.length) problems.push('NoDoubleCommit: a note was saved twice')
    for (const x of [0, 1] as Reel[]) {
      const s = await readAppState(REELS[x])
      const queue = s.queue ?? []
      const onDisk = queue.map((q) => q.id)
      const names = (ids: string[]): string => ids.map((id) => model.text.get(id)).join(', ')
      if (JSON.stringify(onDisk) !== JSON.stringify(model.order[x])) problems.push(`${REELS[x]} queue is [${names(onDisk)}], model says [${names(model.order[x])}]`)
      for (const q of queue) if (q.text !== model.text.get(q.id)) problems.push(`${q.text} on disk, model says ${model.text.get(q.id)}`)
      const running = !!app.jobs.forSlug(REELS[x])
      // only the note whose job is still finishing up may be queued once saved
      if (queue.some((q) => saved.includes(q.id) && !(q.attempt && running))) problems.push('a saved note is still queued')
      if (queue.some((q, i) => q.attempt && (i > 0 || !running))) problems.push(`TypeOK: ${REELS[x]} marks a note started that is not running first`)
      const waiting = new Set(queue.filter((q) => !q.attempt).map((q) => q.id))
      if (s.chat.some((m) => m.from === 'you' && waiting.has(m.id))) problems.push('a waiting note also shows in the chat')
      if (queue.length && !running) {
        if (!s.queueHeld) problems.push(`NoDeadlock: ${REELS[x]} has waiting notes, is not held, and runs nothing`)
        if (!model.held[x]) problems.push(`${REELS[x]} should be running its next note`)
      }
    }
    for (const id of model.text.keys()) {
      if (![...model.order[0], ...model.order[1], ...saved].includes(id) && !gone.has(id)) problems.push(`NoAdmittedLost: ${model.text.get(id)} was lost`)
    }
    if (problems.length) break
  }
  expect(problems).toEqual([])
}

// Sequences every run checks first: each is a way the queue once went wrong, or nearly did.
const send = (reel: Reel): Cmd => ({ t: 'send', reel })
const think = (reel: Reel, how: 'ok' | 'fail' | 'unchanged' = 'ok'): Cmd => ({ t: 'think', reel, how })
const EXAMPLES: Cmd[][] = [
  // a waiting note moved in front of the running one
  [send(0), send(0), { t: 'move', reel: 0, k: 1, by: -1 }],
  // Stop after the note was saved: the next note must not start
  [send(0), send(0), think(0), { t: 'render', how: 'ok-held' }, { t: 'stop', reel: 0 }, think(0)],
  // Stop on the reel that renders while the other waits for the slot
  [send(0), send(1), think(0), think(1), { t: 'stop', reel: 0 }, { t: 'render', how: 'ok' }],
  // a crash right after a note was saved: it must not run again
  [send(0), send(0), think(0), { t: 'crash', afterSave: true }, { t: 'resume', reel: 0 }, think(0), { t: 'render', how: 'ok' }],
  // a note that changes nothing lets the next one run
  [send(0), send(0), think(0, 'unchanged'), think(0), { t: 'render', how: 'ok' }]
]

describe('note queue rules', () => {
  it('hold over random sends, edits, reorders, Stops, failures and crashes on two reels', async () => {
    await fc.assert(fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 50 }), run), { numRuns: 200, examples: EXAMPLES.map((e) => [e]) })
  }, 600_000)
})
