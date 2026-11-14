// Notes sent while a note runs (main/note-queue.ts), driven like the app drives them: the job lane, the
// mock AI's practice note (REELSTUDIO_MOCK_NOTE) and the stand-in engine's real renders. Each note waits
// at a gate until the test lets it go on, and every check waits for the queue to come to rest, so no
// result depends on how fast this computer's disk or engine is.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { createJobManager, WAITING_FOR_RENDER } from '../src/main/jobs'
import { createMockAI } from '../src/main/ai-mock'
import { createNoteQueue } from '../src/main/note-queue'
import { handEditJob } from '../src/main/hand-edit'
import { diffProject } from '../src/shared/hand-edit'
import { keptIds } from '../src/shared/cut'
import { withRenderSlot } from '../src/main/render-slot'
import { engineEnv, noteStagingDir, reelStudioRoot, setRootOverride } from '../src/main/paths'
import { projectDir, readAppState, readProject, readWords, recoverInterrupted, updateAppState } from '../src/main/store'
import type { JobEvent, QueuedNote } from '../src/shared/api'
import { FAKE_ENGINE, makeClip, PYTHON, setupPaths } from './helpers'

process.env.REELSTUDIO_MOCK_NOTE = '1'

const CANCELLED = { code: 'CANCELLED', userMessage: 'Stopped.' }

function app(opts: { failRender?: boolean; holdRenders?: boolean; holdAfterSave?: boolean; afterEvent?: (e: JobEvent) => void; olderAI?: boolean } = {}) {
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
        const text = [note.text, ...(note.steers ?? []).map((x) => x.text)].join('\n')
        // an older AI package takes no added words: it never reads the box
        const steer = note.steer && !opts.olderAI ? { steer: note.steer } : {}
        const r = await ai.applyNote(projectDir(slug), text, emit, signal, { id: note.id, ...(owner ? { owner } : {}), ...steer })
        // the job's bookkeeping after the save (jobs.ts): Stop can land here, too late to undo the note
        if (opts.holdAfterSave) await gate(saved, slug)
        return { summary: r.summary, version: r.version }
      }, { record }),
    // as index.ts startHand
    startHand: async (slug, entry, record) => jobs.start(slug, 'rerender', handEditJob(slot.run, slug, entry), { record }),
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
  // fails if a note sent while Version 1 waits for its plan runs at once and makes a version from pictures nobody
  // approved, or is still waiting after Version 1 is made
  it('a note sent while Version 1 waits for its plan runs only after Version 1', async () => {
    setupPaths()
    const slug = await reel('plan-held')
    await updateAppState(slug, (s) => void (s.planHeld = true))
    const a = app()
    expect(await a.send(slug, 'warmer')).toEqual({ jobId: null, queued: true })
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect(await waitingTexts(slug)).toEqual(['warmer'])
    // Make Version 1: the hold goes in the write that starts it (plan-ipc.ts), and its end runs the note
    const v1 = a.jobs.start(slug, 'first-edit', async () => ({ summary: 'Version 1.' }), { record: (s) => void delete s.planHeld })
    await a.jobs.get(v1)?.done
    await a.runAll(slug)
    expect(await replies(slug)).toContain('Done: "warmer". It is Version 2.')
    expect(await waitingTexts(slug)).toEqual([])
  }, 60000)

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

  it('Stop puts the note back at the top, holds it with the notes behind it, and nothing starts until Resume', async () => {
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
    expect(await waitingTexts(slug)).toEqual(['first', 'second', 'third'])
    // the stopped note keeps its line, which the notes show as stopped with Try again (and leave out its row);
    // the notes behind it never ran, so they are only waiting
    expect(await yours(slug)).toEqual(['first'])
    expect((await readAppState(slug)).chat.find((m) => m.from === 'you')?.outcome).toBe('stopped')
    expect(await replies(slug)).toEqual([])
    expect((await readProject(slug)).version).toBe(1)

    // retried without retyping, as the creator edited it
    await a.queue.edit(slug, (await readAppState(slug)).queue![0].id, 'first, but softer')
    await a.queue.resume(slug)
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(4)
    expect(await replies(slug)).toContain('Done: "first, but softer". It is Version 2.')
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
    // as the Reel screen sends it: with the video, since the job may be gone by the time it lands
    const a = app({ afterEvent: (e) => void (e.type === 'done' && a.queue.stop(e.jobId, slug)) })
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.think(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readProject(slug)).version).toBe(2)
    expect(await waitingTexts(slug)).toEqual(['second'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('a note that fails holds the queue instead of skipping to the next one, and shows once, as failed', async () => {
    setupPaths()
    const slug = await reel('fails')
    const a = app({ failRender: true })
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.think(slug)
    expect(a.jobs.forSlug(slug)).toBeUndefined()
    expect((await readAppState(slug)).queueHeld).toBe(true)
    expect(await waitingTexts(slug)).toEqual(['first', 'second'])
    // it keeps its line, shown as failed with Try again; the reply is the job's own error, with nothing after it
    expect(await yours(slug)).toEqual(['first'])
    expect((await readAppState(slug)).chat.find((m) => m.from === 'you')?.outcome).toBe('failed')
    expect((await readAppState(slug)).chat.at(-1)?.from).toBe('editor')
    expect((await replies(slug)).at(-1)).not.toMatch(/waiting below/)
    expect((await readProject(slug)).version).toBe(1)
    // "edit it, or try again": the line Try again reuses says the edited words, and so does the note that runs
    await a.queue.edit(slug, (await readAppState(slug)).queue![0].id, 'first, but softer')
    expect(await yours(slug)).toEqual(['first, but softer'])
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
    expect((await replies(slug)).at(-1)).toMatch(/is still running on this reel/)
    expect(await waitingTexts(slug)).toEqual(['first'])
    expect((await readAppState(slug)).queueHeld).toBe(true)
  }, 60000)

  it('deleting a video kept closed is refused, and its folders stay', async () => {
    setupPaths()
    const slug = 'closed-delete'
    mkdirSync(projectDir(slug), { recursive: true })
    const a = app()
    a.jobs.keepClosed(slug)
    let removed = false
    await expect(a.queue.remove(slug, async () => void (removed = true))).rejects.toMatchObject({ code: 'ENGINE_STILL_RUNNING' })
    expect(removed).toBe(false)
  })

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

  it('fails if a hand edit made while a note runs is lost, or lands on the version before the note', async () => {
    setupPaths()
    const slug = await reel('hand-behind-note')
    const a = app()
    expect((await a.send(slug, 'first')).jobId).toBeTruthy()
    // Edit it myself, opened on Version 1 while the note runs: subtitles higher
    const v1 = await readProject(slug)
    const kept = new Set(keptIds(await readWords(projectDir(slug), v1), v1.cut?.keep))
    const edited = { ...v1, captions: { ...v1.captions!, style: { ...v1.captions!.style, position: 0.66 } } }
    expect(await a.queue.sendHand(slug, { edit: diffProject(v1, edited, kept, kept), changes: 1 }, 'subtitles moved up', 1)).toEqual({ jobId: null, queued: true })
    await a.runAll(slug)
    const style = (n: number) => JSON.parse(readFileSync(join(projectDir(slug), 'versions', `v${n}`, 'project.json'), 'utf8')).captions.style
    expect((await readProject(slug)).version).toBe(3)
    expect(style(2).position).not.toBe(0.66)
    expect(style(3).position).toBe(0.66)
    expect((await readAppState(slug)).queue).toEqual([])
    expect((await readAppState(slug)).versionsMade?.find((m) => m.version === 3)).toMatchObject({ by: 'hand', summary: 'subtitles moved up' })
  }, 60000)

  it('fails if a hand edit saved just before a crash runs again, or is reported as still waiting', async () => {
    setupPaths()
    const slug = await reel('hand-crash-after')
    const v1 = await readProject(slug)
    const kept = new Set(keptIds(await readWords(projectDir(slug), v1), v1.cut?.keep))
    const hand = { edit: diffProject(v1, { ...v1, captions: { ...v1.captions!, style: { ...v1.captions!.style, position: 0.66 } } }, kept, kept), changes: 1 }
    const run = createEngineRunner({ python: () => PYTHON, env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE }) })
    // the edit is saved as Version 2, then the app closes before the queue hears it ended
    await handEditJob(run, slug, { ...entry('h1', 'subtitles moved up', true), hand })(() => undefined, new AbortController().signal, { id: 'job-1', owner: null })
    await updateAppState(slug, (s) => {
      s.job = { id: 'job-1', kind: 'rerender', startedAt: '', noteId: 'h1' }
      s.queue = [{ ...entry('h1', 'subtitles moved up', true), hand }, entry('q2', 'second')]
    })
    await recoverInterrupted()
    await app().queue.recover()
    expect(await waitingTexts(slug)).toEqual(['second'])
    expect((await readProject(slug)).version).toBe(2)
  }, 60000)
})

describe('Add now: a waiting note goes into the one running', () => {
  const idOf = async (slug: string, text: string): Promise<string> => (await readAppState(slug)).queue!.find((q) => q.text === text)!.id

  it('added while it runs: one version does both, and the added words show under the running note', async () => {
    setupPaths()
    const slug = await reel('steer-in-time')
    const a = app()
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    const second = await idOf(slug, 'second')
    expect(await a.queue.steer(slug, second)).toEqual({ added: true })
    expect(await waitingTexts(slug)).toEqual(['first'])
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(2)
    expect((await readProject(slug)).notes?.at(-1)?.text).toBe('first\nsecond')
    expect(await replies(slug)).toEqual(['Done: "first". Also: "second". It is Version 2.'])
    const line = (await readAppState(slug)).chat.find((m) => m.id === second)
    expect(line).toMatchObject({ from: 'you', text: 'second', steerOf: await firstId(slug) })
    expect(await waitingTexts(slug)).toEqual([])
  }, 60000)

  it('too late (the running note was already saved): it stays first in line and runs next as its own version', async () => {
    setupPaths()
    const slug = await reel('steer-late')
    const a = app({ holdAfterSave: true })
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.think(slug)
    expect(a.waitingAt.saved.has(slug)).toBe(true)
    expect(await a.queue.steer(slug, await idOf(slug, 'second'))).toEqual({ added: false })
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(3)
    expect(await replies(slug)).toEqual(['Done: "first". It is Version 2.', 'Done: "second". It is Version 3.'])
  }, 60000)

  it('sent with steer while a note runs, it is added straight away; with nothing running it just runs', async () => {
    setupPaths()
    const slug = await reel('steer-send')
    const a = app()
    expect((await a.queue.send(slug, { text: 'alone', attachments: [] }, 1, { steer: true })).jobId).toBeTruthy()
    await a.settled()
    expect(await a.queue.send(slug, { text: 'more', attachments: [] }, 1, { steer: true })).toEqual({ jobId: null, added: true })
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(2)
    expect((await readProject(slug)).notes?.at(-1)?.text).toBe('alone\nmore')
  }, 60000)

  it('Stop after adding: the note waits with what was added, and Try again reads both', async () => {
    setupPaths()
    const slug = await reel('steer-stop')
    const a = app()
    const { jobId } = await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.queue.steer(slug, await idOf(slug, 'second'))
    a.queue.stop(jobId!)
    await a.settled()
    const q = (await readAppState(slug)).queue!
    expect(q.map((x) => [x.text, x.steers?.map((y) => y.text)])).toEqual([['first', ['second']]])
    await a.queue.resume(slug)
    await a.runAll(slug)
    expect((await readProject(slug)).version).toBe(2)
    expect((await readProject(slug)).notes?.at(-1)?.text).toBe('first\nsecond')
  }, 60000)

  it('an editor that never read the added words (an older AI package): they wait first in line after the note is saved', async () => {
    setupPaths()
    const slug = await reel('steer-unread')
    const a = app({ olderAI: true })
    await a.send(slug, 'first')
    await a.send(slug, 'second')
    await a.send(slug, 'third')
    const second = await idOf(slug, 'second')
    await a.queue.steer(slug, second)
    await a.think(slug)
    // saved without it: the line under the note goes, and it waits as its own note, before the one behind it
    expect((await readAppState(slug)).chat.some((m) => m.steerOf)).toBe(false)
    await a.runAll(slug)
    expect(await replies(slug)).toEqual(['Done: "first". It is Version 2.', 'Done: "second". It is Version 3.', 'Done: "third". It is Version 4.'])
  }, 60000)

  it.each([
    ['the editor never read it', 'first', ['second']],
    ['the editor read it', 'first\nsecond', []]
  ])('a crash after a note was saved with a note added to it (%s): at the next start the added note waits again only if unread', async (_, savedText, waiting) => {
    setupPaths()
    const slug = await reel(`steer-crash-${waiting.length}`)
    const file = join(projectDir(slug), 'project.json')
    const p = JSON.parse(readFileSync(file, 'utf8'))
    p.notes = [...(p.notes ?? []), { id: 'q1', version: 1, text: savedText, applied: [], at: new Date().toISOString() }]
    writeFileSync(file, JSON.stringify(p))
    await updateAppState(slug, (s) => {
      s.queue = [{ ...entry('q1', 'first', true), steers: [{ id: 'q2', text: 'second' }] }]
      s.chat.push({ id: 'q2', from: 'you', text: 'second', at: new Date().toISOString(), steerOf: 'q1' })
    })
    await app().queue.recover()
    const st = await readAppState(slug)
    expect((st.queue ?? []).map((q) => q.text)).toEqual(waiting)
    expect(st.chat.some((m) => m.steerOf === 'q1')).toBe(waiting.length === 0)
  }, 60000)

  it('a note with files cannot be added, and stays in line', async () => {
    setupPaths()
    const slug = await reel('steer-refused')
    const a = app()
    const { jobId } = await a.send(slug, 'first')
    await updateAppState(slug, (s) => {
      s.queue!.push({ ...entry('with-files', 'put this here'), attachments: [{ asset: 'work/assets/attach-1.png', name: 'a.png', kind: 'image', bytes: 1 }] })
    })
    await expect(a.queue.steer(slug, 'with-files')).rejects.toMatchObject({ code: 'HAS_FILES' })
    expect(await waitingTexts(slug)).toEqual(['first', 'put this here'])
    a.queue.stop(jobId!)
    await a.settled()
  }, 60000)
})

const firstId = async (slug: string): Promise<string> => (await readAppState(slug)).chat.find((m) => m.from === 'you' && m.text === 'first')!.id
