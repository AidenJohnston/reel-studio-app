// The job event contract (shared/api.ts JobUpdate -> JobEvent) end to end without Electron: what a job
// emits, what main adds (overall, secondsLeft, thinking kept across ticks, a playable `video` for every
// render), and how the renderer folds it (shared/live.ts).
import { describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobEvent } from '../src/shared/api'
import { EMPTY_LIVE, STILL_WORKING, liveFromDetail, reduceLive, timeLeftWords, type LiveState } from '../src/shared/live'
import { createLiveMoments, createLiveVideos, LIVE_DIR } from '../src/main/live-video'
import { createJobManager } from '../src/main/jobs'
import { pathFromMediaUrl } from '../src/main/media-url'
import { projectDir, readAppState } from '../src/main/store'
import { setupPaths } from './helpers'

const J = { jobId: 'j1', slug: 's' }
const status = (over: Partial<Extract<JobEvent, { type: 'status' }>> = {}): JobEvent => ({
  ...J, type: 'status', message: 'Listening to your video', pct: 10, overall: 10, secondsLeft: 120, overdue: false, thinking: false, waiting: false, waitingForRender: false, ...over
})
const fold = (events: JobEvent[], s: LiveState = EMPTY_LIVE): LiveState => events.reduce(reduceLive, s)

describe('reduceLive (the renderer side of the contract)', () => {
  it('status: bar never goes back, time left and thinking follow the latest event', () => {
    const s = fold([status({ overall: 30 }), status({ overall: 20, secondsLeft: 60, thinking: true, message: 'Watching your video and planning the edit' })])
    expect(s.overall).toBe(30)
    expect(s.secondsLeft).toBe(60)
    expect(s.thinking).toBe(true)
    expect(s.message).toBe('Watching your video and planning the edit')
    // the AI answered with a tool call: no longer thinking
    expect(fold([{ ...J, type: 'tool', name: 'set_captions', summary: 'Added subtitles' }], s)).toMatchObject({ thinking: false, tools: ['Added subtitles'] })
  })

  it('clears a shown ETA when the next status has no usable estimate', () => {
    const s = fold([status({ secondsLeft: 120 }), status({ secondsLeft: null })])
    expect(s.secondsLeft).toBeNull()
    expect(timeLeftWords(s)).toBeNull()
  })

  it('first look plays, then the AI draft replaces it, never the other way round', () => {
    const look: JobEvent = { ...J, type: 'render', version: 0, draft: true, firstLook: true, video: 'reel-media://f/look' }
    const ai: JobEvent = { ...J, type: 'render', version: 0, draft: true, firstLook: false, video: 'reel-media://f/ai' }
    expect(fold([look]).preview).toEqual({ kind: 'first-look', video: 'reel-media://f/look' })
    expect(fold([look, ai]).preview).toEqual({ kind: 'ai-draft', video: 'reel-media://f/ai', version: 0 })
    expect(fold([ai, look]).preview?.kind).toBe('ai-draft')
    // a render with no playable file, and a final render, change nothing on screen
    expect(fold([{ ...look, video: null }]).preview).toBeNull()
    expect(fold([look, { ...J, type: 'render', version: 1, draft: false, firstLook: false, video: 'reel-media://f/v1' }]).preview?.kind).toBe('first-look')
  })

  it('heard words, a fast reply, and the end', () => {
    const s = fold([
      { ...J, type: 'heard', words: ['so', 'today'] },
      { ...J, type: 'reply', text: 'I made the captions a bit smaller.' },
      { ...J, type: 'done', summary: 'x', version: 2 }
    ])
    expect(s.words).toEqual(['so', 'today'])
    expect(s.reply).toBe('I made the captions a bit smaller.')
    expect(s.end).toEqual({ kind: 'done', version: 2 })
    expect(s.overall).toBe(100)
  })

  it('an event from a different job starts from scratch', () => {
    const old = fold([status({ overall: 80 }), { ...J, type: 'reply', text: 'old' }, { ...J, type: 'moment', kind: 'still', t: 1, image: 'reel-media://f/m0', run: 1 }])
    const s = fold([status({ jobId: 'j2', overall: 5 })], old)
    expect(s).toMatchObject({ jobId: 'j2', overall: 5, reply: null, moments: [] })
  })

  it('fails if a newer edit\'s pictures mix with an older one\'s, or outlast the draft that shows the change', () => {
    const still = (n: number, run = 1): JobEvent => ({ ...J, type: 'moment', kind: 'still', t: n, image: `reel-media://f/m${n}`, run })
    const win: JobEvent = { ...J, type: 'moment', kind: 'window', from: 3, to: 5, video: 'reel-media://f/w', run: 1 }
    const one = fold([still(1), still(2), still(3), win])
    expect(one.moments).toEqual([
      { kind: 'still', image: 'reel-media://f/m1', t: 1, run: 1 }, { kind: 'still', image: 'reel-media://f/m2', t: 2, run: 1 },
      { kind: 'still', image: 'reel-media://f/m3', t: 3, run: 1 }, { kind: 'window', video: 'reel-media://f/w', from: 3, to: 5, run: 1 }
    ])
    // the next reply's run: its pictures replace the last run's
    expect(fold([still(4, 2)], one).moments).toEqual([{ kind: 'still', image: 'reel-media://f/m4', t: 4, run: 2 }])
    // the draft of the change takes the pictures' place
    const drafted = fold([{ ...J, type: 'render', version: 0, draft: true, firstLook: false, video: 'reel-media://f/d' }], one)
    expect(drafted).toMatchObject({ moments: [], preview: { kind: 'ai-draft', video: 'reel-media://f/d' } })
  })

  it('a screen opened mid-job starts from projects:get', () => {
    expect(liveFromDetail({ id: 'j9', message: 'Checking the preview', overall: 61, secondsLeft: 40, overdue: false, thinking: true, waiting: false })).toMatchObject({
      jobId: 'j9', overall: 61, secondsLeft: 40, thinking: true, preview: null
    })
  })
})

describe('live videos (main): a draft plays from a copy the engine never overwrites', () => {
  it('first look keeps its own file; AI drafts alternate; finals play in place; outside paths are ignored', async () => {
    const { home } = setupPaths()
    const dir = join(home, 'p')
    const preview = join(dir, 'versions', 'preview')
    mkdirSync(preview, { recursive: true })
    const draft = join(preview, 'draft.mp4')
    writeFileSync(draft, 'first-look')
    const live = createLiveVideos()
    const look = await live(dir, { type: 'render', version: 0, draft: true, firstLook: true, file: draft })
    const lookFile = pathFromMediaUrl(look!)
    expect(lookFile).toBe(join(dir, LIVE_DIR, 'first-look.mp4'))
    writeFileSync(draft, 'ai-1') // the engine overwrites draft.mp4 with the AI's preview
    const a = pathFromMediaUrl((await live(dir, { type: 'render', version: 0, draft: true, file: draft }))!)
    writeFileSync(draft, 'ai-2')
    const b = pathFromMediaUrl((await live(dir, { type: 'render', version: 0, draft: true }))!) // no file: preview/draft.mp4
    expect(readFileSync(lookFile, 'utf8')).toBe('first-look')
    expect(readFileSync(a, 'utf8')).toBe('ai-1')
    expect(readFileSync(b, 'utf8')).toBe('ai-2')
    expect(a).not.toBe(b)
    // a final is never overwritten: no copy
    const v1 = join(dir, 'versions', 'v1', 'export.mp4')
    mkdirSync(join(dir, 'versions', 'v1'))
    writeFileSync(v1, 'final')
    expect(pathFromMediaUrl((await live(dir, { type: 'render', version: 1, draft: false }))!)).toBe(v1)
    // a path outside the project is not trusted: falls back to the project's own preview
    expect(pathFromMediaUrl((await live(dir, { type: 'render', version: 0, draft: true, file: join(home, 'elsewhere.mp4') }))!)).toMatch(/look-[ab]\.mp4$/)
    expect(await live(join(home, 'empty'), { type: 'render', version: 0, draft: true })).toBeNull()
  })
})

describe('live moments (main): a still or window plays from a copy the next run never touches', () => {
  it('copies each into work/live under rotating names, and refuses files outside the preview folder', async () => {
    const { home } = setupPaths()
    const dir = join(home, 'pm')
    const moments = join(dir, 'versions', 'preview', 'moments')
    mkdirSync(moments, { recursive: true })
    const still = join(moments, 'still_000072.png')
    const live = createLiveMoments()
    const names: string[] = []
    for (const body of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(still, body)            // the engine draws the same frame again on its next run
      const f = pathFromMediaUrl((await live(dir, { type: 'moment', kind: 'still', t: 2.4, file: still, run: 1 }))!)
      expect(readFileSync(f, 'utf8')).toBe(body)
      names.push(f)
    }
    expect(new Set(names.slice(0, 4)).size).toBe(4)   // a run's three stills and the one before never share a copy
    expect(names[4]).toBe(names[0])
    const win = join(dir, 'versions', 'preview', 'window_1.0-3.0.mp4')
    writeFileSync(win, 'w')
    expect(pathFromMediaUrl((await live(dir, { type: 'moment', kind: 'window', from: 1, to: 3, file: win, run: 1 }))!)).toMatch(/moment-window-[ab]\.mp4$/)
    // a note draws into its own folder (tools.ts previewArgs), which goes when the note ends
    const noteStill = join(dir, 'work', 'notes', 'n1', 'moments', 'still_000010.png')
    mkdirSync(join(dir, 'work', 'notes', 'n1', 'moments'), { recursive: true })
    writeFileSync(noteStill, 'n')
    expect(readFileSync(pathFromMediaUrl((await live(dir, { type: 'moment', kind: 'still', t: 0.3, file: noteStill, run: 1 }))!), 'utf8')).toBe('n')
    const outside = join(home, 'elsewhere.png')
    writeFileSync(outside, 'x')
    expect(await live(dir, { type: 'moment', kind: 'still', t: 1, file: outside, run: 1 })).toBeNull()
    expect(await live(dir, { type: 'moment', kind: 'still', t: 1, file: join(dir, 'project.json'), run: 1 })).toBeNull()
  })
})

describe('job manager (main): the contract on the wire', () => {
  it('fails if a failed export lands in the editor chat or marks the video as failed', async () => {
    setupPaths()
    const slug = 'export-fails'
    mkdirSync(projectDir(slug), { recursive: true })
    const jobs = createJobManager(() => undefined, () => undefined)
    jobs.start(slug, 'export', async () => { throw { code: 'ENOSPC', userMessage: 'Your disk is full.' } })
    await jobs.forSlug(slug)?.done
    expect(await readAppState(slug)).toMatchObject({ chat: [], lastError: null })
  })

  it('fails if pictures of a change arrive out of order, after their draft, or after Stop', async () => {
    setupPaths()
    const slug = 'stopped'
    mkdirSync(projectDir(slug), { recursive: true })
    const events: JobEvent[] = []
    let releaseSlow = (): void => undefined
    const slow = new Promise<void>((r) => (releaseSlow = r))
    const jobs = createJobManager(
      (e) => events.push(e),
      () => undefined,
      undefined,
      async (_s, e) => `reel-media://f/draft-${e.version}`,
      undefined,
      undefined,
      undefined,
      async (_s, e) => {
        if (e.kind === 'still' && e.t === 1) await slow // the first copy is the slow one
        return `reel-media://f/${e.kind}-${e.kind === 'still' ? e.t : e.from}`
      }
    )
    let stopped = (): void => undefined
    const id = jobs.start(slug, 'note', async (emit, signal) => {
      emit({ type: 'moment', kind: 'still', t: 1, file: 'a.png', run: 1 })
      emit({ type: 'moment', kind: 'still', t: 2, file: 'b.png', run: 1 })
      emit({ type: 'render', version: 0, draft: true, file: 'draft.mp4' })
      setTimeout(releaseSlow, 30)
      await new Promise<void>((r) => (stopped = r))
      // Stop was pressed: the engine writes one more line before it is gone, then the job ends
      await new Promise<void>((r) => signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true }))
      emit({ type: 'moment', kind: 'still', t: 3, file: 'c.png', run: 2 })
      await new Promise((r) => setTimeout(r, 20))
      throw { code: 'CANCELLED', userMessage: 'Stopped.' }
    })
    // Stop once the draft is on screen, not after a fixed wait: start() reads and writes the project before the job
    // runs, and on a loaded Windows runner that took longer than the 30 ms the slow copy waits, so a timed Stop came
    // before the pictures and they were (rightly) dropped
    await vi.waitFor(() => expect(events.some((e) => e.type === 'render')).toBe(true), { timeout: 5000 })
    jobs.cancel(id)
    stopped()
    await jobs.forSlug(slug)?.done
    await new Promise((r) => setTimeout(r, 30))
    const shown = events.filter((e) => e.type === 'moment' || e.type === 'render')
    expect(shown.map((e) => (e.type === 'moment' ? (e.kind === 'still' ? e.t : e.from) : 'draft'))).toEqual([1, 2, 'draft'])
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' })
  })

  // #147 (bcdaeeb5): on Windows a stopped engine prints progress for about a second while it dies; a status after
  // `cancelled` put the job back on the Reel screen with every export button disabled
  it('says nothing more about a job once it is cancelled, even when its engine still prints progress', async () => {
    setupPaths()
    const slug = 'stopped'
    mkdirSync(projectDir(slug), { recursive: true })
    const events: JobEvent[] = []
    const jobs = createJobManager((e) => events.push(e), () => undefined, {
      loadHistory: async () => ({ v: 1, phases: {} }),
      saveHistory: async () => undefined,
      mediaSeconds: async () => 30,
      tickMs: 15
    })
    const held: { emit?: (e: { type: 'status'; message: string; pct: number; phase: 'final' }) => void } = {}
    let running!: () => void
    const started = new Promise<void>((r) => (running = r))
    const id = jobs.start(slug, 'rerender', async (emit, signal) => {
      held.emit = emit
      emit({ type: 'status', message: 'Making the full-quality video', pct: 1, phase: 'final' })
      const stopped = new Promise((r) => signal.addEventListener('abort', r, { once: true }))
      running()
      await stopped
      throw { code: 'CANCELLED', userMessage: 'Stopped.' }
    })
    await started
    jobs.cancel(id)
    await jobs.forSlug(slug)?.done
    // the runner rejected at once; the dying engine's last progress line arrives after the job ended
    held.emit!({ type: 'status', message: 'Putting it all together', pct: 40, phase: 'final' })
    await new Promise((r) => setTimeout(r, 60))
    const end = events.findIndex((e) => e.type === 'cancelled')
    expect(end).toBeGreaterThan(-1)
    expect(events.slice(end + 1)).toEqual([])
  })

  it('keeps thinking across the once-a-second repeats, adds video to renders before done, passes reply + heard', async () => {
    setupPaths()
    const slug = 'wire'
    mkdirSync(projectDir(slug), { recursive: true })
    const events: JobEvent[] = []
    const jobs = createJobManager(
      (e) => events.push(e),
      () => undefined,
      { loadHistory: async () => ({ v: 1, phases: {} }), saveHistory: async () => undefined, mediaSeconds: async () => 30, tickMs: 15 },
      async (s, e) => (e.firstLook ? `reel-media://f/${s}/look` : null),
      undefined,
      undefined,
      undefined,
      async (s, e) => (e.kind === 'still' ? `reel-media://f/${s}/still` : null)
    )
    jobs.start(slug, 'first-edit', async (emit) => {
      emit({ type: 'status', message: 'Listening to your video', pct: 50, phase: 'listen' })
      emit({ type: 'heard', words: ['hello'] })
      emit({ type: 'render', version: 0, draft: true, firstLook: true, file: join(projectDir(slug), 'x.mp4') })
      emit({ type: 'status', message: 'Watching your video and planning the edit', phase: 'edit', thinking: true })
      await new Promise((r) => setTimeout(r, 80))
      emit({ type: 'tool', name: 'set_cut', summary: 'Kept your best takes' })
      emit({ type: 'reply', text: 'Done soon.' })
      emit({ type: 'moment', kind: 'still', t: 2.4, file: join(projectDir(slug), 'versions', 'preview', 'moments', 'still_000072.png'), run: 1 })
      emit({ type: 'moment', kind: 'window', from: 1, to: 3, file: join(projectDir(slug), 'gone.mp4'), run: 1 })   // no copy: not sent
      return { summary: 'ok', version: 1, chat: [] }
    })
    await jobs.forSlug(slug)?.done
    const i = events.findIndex((e) => e.type === 'status' && e.thinking)
    const t = events.findIndex((e) => e.type === 'tool')
    const between = events.slice(i, t).filter((e) => e.type === 'status')
    expect(between.length).toBeGreaterThan(2)                        // repeats happened while thinking
    expect(between.every((e) => e.type === 'status' && e.thinking)).toBe(true)
    expect(events.slice(t).filter((e) => e.type === 'status').every((e) => e.type === 'status' && !e.thinking)).toBe(true)
    const render = events.find((e) => e.type === 'render')
    expect(render).toEqual({ jobId: expect.any(String), slug, type: 'render', version: 0, draft: true, firstLook: true, video: `reel-media://f/${slug}/look` })
    expect(events.findIndex((e) => e.type === 'render')).toBeLessThan(events.findIndex((e) => e.type === 'done'))
    expect(events.find((e) => e.type === 'heard')).toMatchObject({ words: ['hello'] })
    expect(events.find((e) => e.type === 'reply')).toMatchObject({ text: 'Done soon.' })
    expect(events.filter((e) => e.type === 'moment')).toEqual([{ jobId: expect.any(String), slug, type: 'moment', kind: 'still', t: 2.4, image: `reel-media://f/${slug}/still`, run: 1 }])
    expect(events.findIndex((e) => e.type === 'moment')).toBeLessThan(events.findIndex((e) => e.type === 'done'))
    expect(events.filter((e) => e.type === 'status').every((e) => e.type === 'status' && typeof e.overall === 'number' && typeof e.pct === 'number')).toBe(true)
    // no time left before the video's length is known (it would only jump up later), then a number
    const statuses = events.filter((e) => e.type === 'status')
    expect(statuses[0]).toMatchObject({ secondsLeft: null })
    expect(statuses.some((e) => e.type === 'status' && typeof e.secondsLeft === 'number' && e.secondsLeft > 0)).toBe(true)
    expect(existsSync(projectDir(slug))).toBe(true)
  })

  it('fails if a reopened screen and the open one disagree, or an overrun keeps an old estimate', async () => {
    setupPaths()
    const slug = 'eta-reopen'
    mkdirSync(projectDir(slug), { recursive: true })
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const wall = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const events: JobEvent[] = []
    let open = EMPTY_LIVE
    const jobs = createJobManager((e) => { events.push(e); open = reduceLive(open, e) }, () => undefined, {
      loadHistory: async () => ({ v: 1, phases: {} }), saveHistory: async () => undefined,
      mediaSeconds: async () => 60
    })
    const seen: { open: string | null; reopened: string | null }[] = []
    jobs.start(slug, 'rerender', async (emit) => {
      const status = () => emit({ type: 'status', message: 'Updating your video', phase: 'final', pct: 0 })
      const look = () => seen.push({ open: timeLeftWords(open), reopened: timeLeftWords(liveFromDetail(jobs.forSlug(slug)!)) })
      status()
      await Promise.resolve()
      status()
      look()
      now = 120_000
      status()
      look()
      return { summary: 'ok', chat: [] }
    })
    try {
      await jobs.forSlug(slug)!.done
      expect(seen[0].open).toMatch(/left/)
      for (const s of seen) expect(s.reopened).toBe(s.open)
      expect(seen[1].open).toBe(STILL_WORKING)
      expect(events.filter((e) => e.type === 'status').at(-1)).toMatchObject({ secondsLeft: null, overdue: true })
    } finally {
      clock.mockRestore()
      wall.mockRestore()
    }
  })

  it('a manual edit and a note never run on one video at once', async () => {
    setupPaths()
    const slug = 'one-lane'
    mkdirSync(projectDir(slug), { recursive: true })
    const jobs = createJobManager(() => undefined, () => undefined)
    let release!: () => void
    let saving!: () => void
    const inside = new Promise<void>((r) => (saving = r))
    const editing = jobs.hold(slug, () => { saving(); return new Promise<void>((r) => (release = r)) })
    await inside
    expect(readFileSync(join(projectDir(slug), 'work', '.owner.lock'), 'utf8')).toBeTruthy()
    expect(() => jobs.start(slug, 'note', async () => ({ summary: 'ok' }))).toThrow(expect.objectContaining({ code: 'BUSY' }))
    release()
    await editing
    let finish!: (r: { summary: string }) => void
    const note = new Promise<{ summary: string }>((r) => (finish = r))
    jobs.start(slug, 'note', () => note)
    await expect(jobs.hold(slug, async () => 'saved')).rejects.toMatchObject({ code: 'BUSY' })
    finish({ summary: 'ok' })
    await jobs.forSlug(slug)?.done
    await expect(jobs.hold(slug, async () => 'saved')).resolves.toBe('saved')
  })

  it('when a job\'s last event arrives the job is gone and the video let go, so a screen reloading on it shows no job', async () => {
    setupPaths()
    const slug = 'last-event'
    mkdirSync(projectDir(slug), { recursive: true })
    const seen: { type: string; running: boolean; locked: boolean }[] = []
    const jobs = createJobManager((e) => {
      if (e.type !== 'done' && e.type !== 'error' && e.type !== 'cancelled') return
      seen.push({ type: e.type, running: !!jobs.forSlug(slug), locked: existsSync(join(projectDir(slug), 'work', '.owner.lock')) })
    }, () => undefined)
    jobs.start(slug, 'note', async () => ({ summary: 'ok' }))
    await jobs.forSlug(slug)?.done
    jobs.start(slug, 'note', async () => { throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' } })
    await jobs.forSlug(slug)?.done
    const id = jobs.start(slug, 'note', (_emit, signal) => new Promise((_r, reject) => {
      const stop = (): void => reject({ code: 'CANCELLED', userMessage: 'Stopped.' })
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop)
    }))
    const stopping = jobs.forSlug(slug)?.done
    jobs.cancel(id)
    await stopping
    expect(seen).toEqual(['done', 'error', 'cancelled'].map((type) => ({ type, running: false, locked: false })))
  })

  it('fails if a preview still being copied when Stop lands arrives after the job is cancelled', async () => {
    setupPaths()
    const slug = 'late-render'
    mkdirSync(projectDir(slug), { recursive: true })
    const events: JobEvent[] = []
    let resolveVideo!: () => void
    const videoReady = new Promise<void>((resolve) => { resolveVideo = resolve })
    let resolveRenderStarted!: () => void
    const renderStarted = new Promise<void>((resolve) => { resolveRenderStarted = resolve })
    const jobs = createJobManager((e) => events.push(e), () => undefined, undefined, async () => {
      resolveRenderStarted()
      await videoReady
      return 'reel-media://f/late'
    })
    const id = jobs.start(slug, 'note', (emit, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject({ code: 'CANCELLED', userMessage: 'Stopped.' }))
      emit({ type: 'render', version: 2, draft: true, file: join(projectDir(slug), 'x.mp4') })
    }))
    const done = jobs.get(id)!.done
    await renderStarted
    jobs.cancel(id)
    // the copy finishes well after Stop: the job waits for it before it ends, and never shows it
    setTimeout(resolveVideo, 20)
    await done
    await new Promise((r) => setTimeout(r, 0))
    expect(events.at(-1)?.type).toBe('cancelled')
    expect(events.some((e) => e.type === 'render')).toBe(false)
  })

  it('fails if a render still reporting after Stop puts its step back over the stopped note', async () => {
    const events: JobEvent[] = []
    const jobs = createJobManager((e) => events.push(e), () => undefined)
    const id = jobs.start(null, 'note', (emit, signal) => new Promise((_, reject) => {
      emit({ type: 'status', message: 'Making the final video', pct: 40, phase: 'final' })
      signal.addEventListener('abort', () => {
        // the engine runner settles on Stop at once; lines the killed render already wrote still arrive
        reject({ code: 'CANCELLED', userMessage: 'Stopped.' })
        setTimeout(() => emit({ type: 'status', message: 'Making the final video', pct: 60, phase: 'final' }), 0)
      })
    }))
    const done = jobs.get(id)!.done
    jobs.cancel(id)
    await done
    await new Promise((r) => setTimeout(r, 20))
    expect(events.at(-1)?.type).toBe('cancelled')
  })

  it('asks for the video length only after init, not while a clip is being prepared inside it', async () => {
    setupPaths()
    const slug = 'prepared'
    mkdirSync(projectDir(slug), { recursive: true })
    let step = ''
    const asked: string[] = []
    const jobs = createJobManager(() => undefined, () => undefined, {
      loadHistory: async () => ({ v: 1, phases: {} }),
      saveHistory: async () => undefined,
      mediaSeconds: async () => {
        asked.push(step)
        return 30
      },
      tickMs: 15
    })
    jobs.start(slug, 'first-edit', async (emit) => {
      step = 'prepare'
      emit({ type: 'status', message: 'Preparing your video', pct: 40, phase: 'prepare' })
      step = 'listen'
      emit({ type: 'status', message: 'Listening to your video', pct: 10, phase: 'listen' })
      return { summary: 'ok', chat: [] }   // beta's job result: no chat line (#29), not `quiet`
    })
    await jobs.forSlug(slug)?.done
    expect(asked).toEqual(['listen'])
  })
})
