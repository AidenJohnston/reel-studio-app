// Notes sent while a note runs (main/note-queue.ts), driven like the app drives them: the job lane, the
// mock AI's practice note (REELSTUDIO_MOCK_NOTE) and the stand-in engine's real renders. Each note waits
// at a gate until the test lets it go on, and every check waits for the queue to come to rest, so no
// result depends on how fast this computer's disk or engine is.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { createJobManager, WAITING_FOR_RENDER } from '../src/main/jobs'
import { createMockAI } from '../src/main/ai-mock'
import { BACK_IN_QUEUE, createNoteQueue, STOPPED } from '../src/main/note-queue'
import { withRenderSlot } from '../src/main/render-slot'
import { engineEnv, noteStagingDir, reelStudioRoot, setRootOverride } from '../src/main/paths'
import { projectDir, readAppState, readProject, recoverInterrupted, updateAppState } from '../src/main/store'
import type { JobEvent, QueuedNote } from '../src/shared/api'
import { FAKE_ENGINE, makeClip, PYTHON, setupPaths } from './helpers'

process.env.REELSTUDIO_MOCK_NOTE = '1'

const CANCELLED = { code: 'CANCELLED', userMessage: 'Stopped.' }

function app(opts: { failRender?: boolean; holdRenders?: boolean; holdAfterSave?: boolean; afterEvent?: (e: JobEvent) => void } = {}) {
  const engine = createEngineRunner({
    python: () => PYTHON,
    env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE, ...(opts.failRender ? { FAKE_ENGINE_FAIL: 'render' } : {}) })
  })
  /** gates the test opens: a note before its AI work, a render before the engine, a note after its save */
  const thinking = new Map<string, () => void>()
  const renders = new Map<string, () => void>()
  const saved = new Map<string, () => void>()
  let slotWaiters = 0
  let rendering = 0
  let mostRendering = 0
  const gate = (at: Map<string, () => void>, slug: string, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      at.set(slug, resolve)
      signal?.addEventListener('abort', () => reject(CANCELLED), { once: true })
    }).finally(() => at.delete(slug))

  const counted: typeof engine = async (command, args, onProgress, signal) => {
    if (command !== 'render') return engine(command, args, onProgress, signal)
    const slug = args[args.indexOf('--project') + 1].split(/[\\/]/).pop()!
    mostRendering = Math.max(mostRendering, ++rendering)
    try {
      if (opts.holdRenders) await gate(renders, slug, signal)
      return await engine(command, args, onProgress, signal)
    } finally {
      rendering--
    }
  }
  const events: JobEvent[] = []
  const pending = new Set<Promise<void>>()
  const slot = withRenderSlot(counted, (owner, waiting) => {
    slotWaiters += waiting ? 1 : -1
    jobs.waitingForRender(owner, waiting)
  })
  const jobs = createJobManager((e) => {
    events.push(e)
    const p = queue.onJobEvent(e)
    pending.add(p)
    void p.finally(() => pending.delete(p))
    opts.afterEvent?.(e)
  }, () => undefined)
  const ai = createMockAI({ host: { runEngine: slot.run, renderAnimation: async () => '', reelStudioRoot }, settingsDir: join(reelStudioRoot(), 'ai') })
  // as index.ts startNote
  const queue = createNoteQueue({
    jobs,
    startNote: async (slug, note, record) =>
      jobs.start(slug, 'note', async (emit, signal, { owner }) => {
        await gate(thinking, slug, signal)
        const r = await ai.applyNote(projectDir(slug), note.text, emit, signal, { id: note.id, ...(owner ? { owner } : {}) })
        // the job's bookkeeping after the save (jobs.ts): Stop can land here, too late to undo the note
        if (opts.holdAfterSave) await gate(saved, slug)
        return { summary: r.summary, version: r.version }
      }, { record }),
    changed: () => undefined,
    log: () => undefined
  })

  /** Resolves once the queue has acted on every job event and every running job waits at a gate. */
  async function settled(): Promise<void> {
    for (let i = 0; i < 20_000; i++) {
      await new Promise((r) => setTimeout(r, 1))
      const parked = thinking.size + renders.size + saved.size + slotWaiters
      if (!pending.size && parked === jobs.runningCount()) return
    }
    throw new Error(`the queue never came to rest: ${jobs.runningCount()} jobs, ${thinking.size + renders.size + saved.size} at gates, ${slotWaiters} waiting for the slot`)
  }
  /** Opens a gate, then waits for the queue to come to rest. */
  const open = async (at: Map<string, () => void>, slug: string): Promise<void> => {
    const go = at.get(slug)
    if (!go) throw new Error(`nothing waits at that gate on ${slug}`)
    go()
    await settled()
  }
  const send = async (slug: string, text: string) => {
    const r = await queue.send(slug, { text, attachments: [] }, 1)
    await settled()
    return r
  }
  /** Lets each note on the reel run to its end, one after another, until nothing runs there. */
  const runAll = async (slug: string): Promise<void> => {
    await settled()
    while (jobs.forSlug(slug)) {
      const at = [thinking, renders, saved].find((g) => g.has(slug))
      if (!at) throw new Error(`a note runs on ${slug} but waits at no gate`)
      await open(at, slug)
    }
  }
  return {
    ai, jobs, queue, events, send, settled, runAll,
    think: (slug: string) => open(thinking, slug),
    render: (slug: string) => open(renders, slug),
    finishSave: (slug: string) => open(saved, slug),
    waitingAt: { thinking, renders, saved },
    mostRendering: () => mostRendering
  }
}

async function reel(slug: string): Promise<string> {
  const dir = projectDir(slug)
  mkdirSync(dir, { recursive: true })
  const clip = makeClip(join(dir, '..', `${slug}.mp4`))
  const run = createEngineRunner({ python: () => PYTHON, env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE }) })
  await run('init', ['--project', dir, '--title', slug, '--slug', slug, clip])
  await run('render', ['--project', dir])
  return slug
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 20_000 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
  if (!ok()) throw new Error('it never happened')
}
const replies = async (slug: string): Promise<string[]> => (await readAppState(slug)).chat.filter((m) => m.from === 'editor').map((m) => m.text)
const yours = async (slug: string): Promise<string[]> => (await readAppState(slug)).chat.filter((m) => m.from === 'you').map((m) => m.text)
const waitingTexts = async (slug: string): Promise<string[]> => ((await readAppState(slug)).queue ?? []).map((q) => q.text)
const entry = (id: string, text: string, started = false): QueuedNote => ({
  id, text, attachments: [], seenVersion: 1, ...(started ? { attempt: { base: 1 } } : {})
})

describe('note queue', () => {
  it('notes sent while one runs each run after it, in order, and each makes its own version', async () => {
    setupPaths()
    const slug = await reel('in-order')
    const a = app()
    expect((await a.send(slug, 'first')).jobId).toBeTruthy()
    expect(await a.send(slug, 'second')).toEqual({ jobId: null, queued: true })
    expect(await a.send(slug, 'third')).toEqual({ jobId: null, queued: true })
    await a.runAll(slug)
    expect(await replies(slug)).toEqual(['Done: "first". It is Version 2.', 'Done: "second". It is Version 3.', 'Done: "third". It is Version 4.'])
    expect((await readProject(slug)).version).toBe(4)
    expect(await waitingTexts(slug)).toEqual([])
  }, 60000)

  it('Stop says so, holds the waiting notes, and nothing starts until Resume', async () => {
    setupPaths()
    const slug = await reel('stop')
    const a = app()
    const { jobId } = await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.send(slug, 'third')
    a.queue.stop(jobId!)
    await a.settled()
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readAppState(slug)).queueHeld).toBe(true)
    expect(await waitingTexts(slug)).toEqual(['second', 'third'])
    expect(await replies(slug)).toEqual([STOPPED])
    expect((await readProject(slug)).version).toBe(1)

    await a.queue.resume(slug)
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(3)
  }, 60000)

  it('Stop pressed after the note was saved keeps it, and still holds the notes behind it', async () => {
    setupPaths()
    const slug = await reel('stop-late')
    const a = app({ holdAfterSave: true })
    const { jobId } = await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.think(slug)
    expect(a.waitingAt.saved.has(slug)).toBe(true)
    a.queue.stop(jobId!)
    await a.finishSave(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readProject(slug)).version).toBe(2)
    expect(await waitingTexts(slug)).toEqual(['second'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('Stop pressed just as the note finishes still holds the notes behind it', async () => {
    setupPaths()
    const slug = await reel('stop-at-end')
    const a = app({ afterEvent: (e) => void (e.type === 'done' && a.queue.stop(e.jobId)) })
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.think(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readProject(slug)).version).toBe(2)
    expect(await waitingTexts(slug)).toEqual(['second'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('a note that fails holds the queue instead of skipping to the next one, and shows only as waiting', async () => {
    setupPaths()
    const slug = await reel('fails')
    const a = app({ failRender: true })
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.think(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readAppState(slug)).queueHeld).toBe(true)
    expect(await waitingTexts(slug)).toEqual(['first', 'second'])
    expect(await yours(slug)).toEqual([])
    expect((await replies(slug)).at(-1)).toBe(BACK_IN_QUEUE)
    expect((await readProject(slug)).version).toBe(1)
  }, 60000)

  it('a crash before a note is saved: it and the notes behind it come back once, waiting for Resume', async () => {
    setupPaths()
    const slug = await reel('crash-before')
    await updateAppState(slug, (s) => {
      s.job = { id: 'job-1', kind: 'note', startedAt: '', noteId: 'q1' }
      s.chat = [{ id: 'q1', from: 'you', text: 'first', at: '' }]
      s.queue = [entry('q1', 'first', true), entry('q2', 'second')]
    })
    // the next start
    await recoverInterrupted()
    const a = app()
    await a.queue.recover()
    expect(await a.send(slug, 'third')).toEqual({ jobId: null, queued: true })
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect(await waitingTexts(slug)).toEqual(['first', 'second', 'third'])
    expect(await yours(slug)).toEqual([])

    await a.queue.resume(slug)
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(4)
    expect(await yours(slug)).toEqual(['first', 'second', 'third'])
  }, 60000)

  it('a crash after a note is saved but before it left the queue: it is not run a second time', async () => {
    setupPaths()
    const slug = await reel('crash-after')
    const a = app()
    await a.ai.applyNote(projectDir(slug), 'first', () => undefined, undefined, { id: 'q1' })
    await updateAppState(slug, (s) => {
      s.job = { id: 'job-1', kind: 'note', startedAt: '', noteId: 'q1' }
      s.queue = [entry('q1', 'first', true), entry('q2', 'second')]
    })
    await recoverInterrupted()
    await a.queue.recover()
    expect(await replies(slug)).toEqual(['I made your change. It is Version 2.'])
    expect(await waitingTexts(slug)).toEqual(['second'])

    await a.queue.resume(slug)
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(3)
  }, 60000)

  it('a note project.json already has never runs again, and nothing starts while project.json cannot be read', async () => {
    setupPaths()
    const slug = await reel('saved-unseen')
    const a = app()
    await a.ai.applyNote(projectDir(slug), 'first', () => undefined, undefined, { id: 'q1' })
    const good = await readProject(slug)
    await updateAppState(slug, (s) => {
      s.queue = [entry('q1', 'first'), entry('q2', 'second')]
      s.queueHeld = true
    })
    await rename(join(projectDir(slug), 'project.json'), join(projectDir(slug), 'project.json.bak'))
    await a.queue.resume(slug)
    await a.settled()
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readAppState(slug)).queueHeld).toBe(true)

    await rename(join(projectDir(slug), 'project.json.bak'), join(projectDir(slug), 'project.json'))
    await a.queue.resume(slug)
    await a.runAll(slug)
    expect(await replies(slug)).toEqual(['Done: "second". It is Version 3.'])
    expect(await waitingTexts(slug)).toEqual([])
    const ids = (p: typeof good): (string | undefined)[] => (p.notes ?? []).map((n) => n.id)
    expect(ids(await readProject(slug))).toEqual([...ids(good), expect.any(String)])
  }, 60000)

  it('notes on two reels plan at once, but only one renders at a time, and the waiting one says so and holds its bar', async () => {
    setupPaths()
    const [one, two] = [await reel('reel-one'), await reel('reel-two')]
    const a = app({ holdRenders: true })
    await a.send(one, 'brighter')
    await a.send(two, 'brighter')
    expect([...a.waitingAt.thinking.keys()].sort()).toEqual([one, two])
    await a.think(one)
    expect(a.waitingAt.renders.has(one)).toBe(true)
    const seen = a.events.length
    await a.think(two)
    const waiting = a.events.slice(seen).filter((e) => e.type === 'status' && e.slug === two && e.waitingForRender)
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.every((e) => e.type === 'status' && e.message === WAITING_FOR_RENDER && e.secondsLeft === null && !e.overdue)).toBe(true)
    expect(a.waitingAt.renders.has(two)).toBe(false)

    await a.render(one)
    expect(a.waitingAt.renders.has(two)).toBe(true)
    await a.render(two)
    expect(a.mostRendering()).toBe(1)
    expect((await readProject(one)).version).toBe(2)
    expect((await readProject(two)).version).toBe(2)
  }, 60000)

  it('a note sent while a manual edit saves runs when the edit is done, without Resume', async () => {
    setupPaths()
    const slug = await reel('busy')
    const a = app()
    let finishEdit!: () => void
    const editing = a.jobs.hold(slug, () => new Promise<void>((r) => (finishEdit = r)))
    await a.send(slug, 'first')
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    finishEdit()
    await editing
    await until(() => a.waitingAt.thinking.has(slug))
    expect((await readAppState(slug)).queueHeld).toBeFalsy()
  }, 60000)

  it('a note sent to a video kept closed by an engine that would not stop says why, and waits', async () => {
    setupPaths()
    const slug = await reel('closed')
    const a = app()
    a.jobs.keepClosed(slug)
    await a.send(slug, 'first')
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await replies(slug)).at(-1)).toMatch(/Restart your computer/)
    expect(await waitingTexts(slug)).toEqual(['first'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('a note still marked started by a run that crashed never starts again without Resume', async () => {
    setupPaths()
    const slug = await reel('stale')
    await updateAppState(slug, (s) => void (s.queue = [entry('q1', 'first', true)]))
    const a = app()
    await a.send(slug, 'second')
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect(await waitingTexts(slug)).toEqual(['first', 'second'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('Stop pressed after its note already finished (the screen was behind) still holds the notes waiting', async () => {
    setupPaths()
    const slug = await reel('stop-late-screen')
    const a = app()
    const { jobId } = await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.send(slug, 'third')
    await a.think(slug)
    expect(await waitingTexts(slug)).toEqual(['second', 'third'])
    await a.queue.stop(jobId!, slug)
    await a.think(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect(await waitingTexts(slug)).toEqual(['third'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('while Reel Studio quits, a note that finishes does not start the next one', async () => {
    setupPaths()
    const slug = await reel('quitting')
    const a = app()
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    a.queue.quit()
    await a.think(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect(await waitingTexts(slug)).toEqual(['second'])
  }, 60000)

  it('startup holds every video with waiting notes, even when another video cannot be read', async () => {
    setupPaths()
    const [bad, good] = [await reel('aaa-unreadable'), await reel('zzz-waiting')]
    writeFileSync(join(projectDir(bad), 'app.json'), '{"chat": [')
    await updateAppState(good, (s) => void (s.queue = [entry('q1', 'first', true)]))
    await app().queue.recover()
    const st = await readAppState(good)
    expect(st.queueHeld).toBe(true)
    expect(st.queue?.[0].attempt).toBeUndefined()
  }, 60000)

  it('a file staged for a video in one storage folder survives startup in another folder with a video of the same name', async () => {
    setupPaths()
    const slug = await reel('bread')
    const staged = join(noteStagingDir(projectDir(slug)), 'work', 'assets', 'attach-1a2b3c4d-logo.png')
    mkdirSync(join(staged, '..'), { recursive: true })
    writeFileSync(staged, 'png')
    const asset = { asset: 'work/assets/attach-1a2b3c4d-logo.png', name: 'logo.png', kind: 'image' as const, bytes: 3 }
    await updateAppState(slug, (s) => void (s.queue = [{ ...entry('q1', 'first'), attachments: [asset] }]))
    setRootOverride(join(reelStudioRoot(), '..', 'Other root', 'Reel Studio'))
    await reel('bread')
    await app().queue.recover()
    expect(existsSync(staged)).toBe(true)
  }, 60000)
})

