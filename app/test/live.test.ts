// The job event contract (shared/api.ts JobUpdate -> JobEvent) end to end without Electron: what a job
// emits, what main adds (overall, secondsLeft, thinking kept across ticks, a playable `video` for every
// render), and how the renderer folds it (shared/live.ts).
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobEvent } from '../src/shared/api'
import { EMPTY_LIVE, PREVIEW_LABEL, liveFromDetail, reduceLive, type LiveState } from '../src/shared/live'
import { createLiveVideos, createNoteVideos, LIVE_DIR } from '../src/main/live-video'
import { protocol } from 'electron'
import { handleMediaProtocol } from '../src/main/media'
import { createJobManager } from '../src/main/jobs'
import { mediaUrl, pathFromMediaUrl } from '../src/main/media-url'
import { projectDir, readAppState } from '../src/main/store'
import { setupPaths } from './helpers'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

function serveMedia(req: Request, roots: () => string[], stagingRoots: () => string[] = () => []): Promise<Response> {
  handleMediaProtocol(roots, stagingRoots)
  const handler = vi.mocked(protocol.handle).mock.calls.at(-1)![1]
  return Promise.resolve(handler(req))
}

const J = { jobId: 'j1', slug: 's' }
const status = (over: Partial<Extract<JobEvent, { type: 'status' }>> = {}): JobEvent => ({
  ...J, type: 'status', message: 'Listening to your video', pct: 10, overall: 10, secondsLeft: 120, overdue: false, thinking: false, ...over
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

  it('first look plays, then the AI draft replaces it, never the other way round', () => {
    const look: JobEvent = { ...J, type: 'render', version: 0, draft: true, firstLook: true, video: 'reel-media://f/look' }
    const ai: JobEvent = { ...J, type: 'render', version: 0, draft: true, firstLook: false, video: 'reel-media://f/ai' }
    expect(fold([look]).preview).toEqual({ kind: 'first-look', video: 'reel-media://f/look' })
    expect(fold([look, ai]).preview).toEqual({ kind: 'ai-draft', video: 'reel-media://f/ai', version: 0 })
    expect(fold([ai, look]).preview?.kind).toBe('ai-draft')
    // a render with no playable file, and a final render, change nothing on screen
    expect(fold([{ ...look, video: null }]).preview).toBeNull()
    expect(fold([look, { ...J, type: 'render', version: 1, draft: false, firstLook: false, video: 'reel-media://f/v1' }]).preview?.kind).toBe('first-look')
    expect(PREVIEW_LABEL['first-look']).toBe("Here's a first look. I'm still adding pictures and music.")
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
    const old = fold([status({ overall: 80 }), { ...J, type: 'reply', text: 'old' }])
    const s = fold([status({ jobId: 'j2', overall: 5 })], old)
    expect(s).toMatchObject({ jobId: 'j2', overall: 5, reply: null })
  })

  it('a screen opened mid-job starts from projects:get', () => {
    expect(liveFromDetail({ id: 'j9', message: 'Checking the preview', overall: 61, secondsLeft: 40, overdue: false, thinking: true })).toMatchObject({
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

describe('job manager (main): the contract on the wire', () => {
  it('records an interrupted note on quit while preserving a real Stop', async () => {
    setupPaths()
    const jobs = createJobManager(() => undefined, () => undefined)
    const startNote = (slug: string) => {
      mkdirSync(projectDir(slug), { recursive: true })
      let started!: () => void
      const ready = new Promise<void>((resolve) => { started = resolve })
      const id = jobs.start(slug, 'note', (_emit, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject({ code: 'CANCELLED', userMessage: 'Stopped.' }), { once: true })
        started()
      }))
      return { id, ready }
    }
    const stopped = startNote('user-stop')
    const interrupted = startNote('app-quit')
    await Promise.all([stopped.ready, interrupted.ready])
    jobs.cancel(stopped.id)
    await jobs.cancelAll('quit')
    expect((await readAppState('app-quit')).chat.map((message) => message.text)).toEqual([
      'Reel Studio closed before I finished that change. Send your note again and I will pick it up.'
    ])
    expect((await readAppState('user-stop')).chat.map((message) => message.text)).toEqual([
      'Stopped. Your video has not changed.'
    ])
  })

  it('keeps inactive staging private through an alias in an allowed media folder', async () => {
    const { home } = setupPaths()
    const stage = join(home, '.staging', 'stopped')
    mkdirSync(stage, { recursive: true })
    writeFileSync(join(stage, 'draft.mp4'), 'private draft')
    const alias = join(home, 'draft.mp4')
    symlinkSync(join(stage, 'draft.mp4'), alias)
    const response = await serveMedia(new Request(mediaUrl(alias)), () => [home])
    expect(response.status).toBe(403)
  })

  it('serves a note draft only for its active staging job and revokes it before cleanup', async () => {
    const { root } = setupPaths()
    const slug = 'staged-note'
    const dir = projectDir(slug)
    const stage = join(dir, '.staging', 'note')
    mkdirSync(stage, { recursive: true })
    const draft = join(stage, 'draft.mp4')
    writeFileSync(draft, 'staged preview')
    const original = join(dir, 'versions', 'v1', 'export.mp4')
    mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
    writeFileSync(original, 'published video')
    const events: JobEvent[] = []
    const videos = createNoteVideos()
    const request = (url: string) => serveMedia(new Request(url, { headers: { Range: 'bytes=0-5' } }), () => [root], videos.roots)
    expect((await request(mediaUrl(draft))).status).toBe(403)
    let shown!: (e: Extract<JobEvent, { type: 'render' }>) => void
    const preview = new Promise<Extract<JobEvent, { type: 'render' }>>((resolve) => { shown = resolve })
    let finish!: () => void
    const rendering = new Promise<void>((resolve) => { finish = resolve })
    const jobs = createJobManager((e) => {
      events.push(e)
      if (e.type === 'render') shown(e)
    }, () => undefined, undefined, (_s, e, job) => videos.video(job.id, e))
    jobs.start(slug, 'note', async (emit, _signal, id) => {
      videos.set(id, dir, stage)
      try {
        emit({ type: 'render', version: 2, draft: true, file: draft })
        await rendering
        throw { code: 'RENDER_FAILED', userMessage: 'Send your note again.' }
      } finally {
        videos.set(id, dir, null)
        expect((await request(mediaUrl(draft))).status).toBe(403)
        rmSync(stage, { recursive: true })
      }
    })
    const event = await preview
    try {
      expect(pathFromMediaUrl(event.video!)).toBe(draft)
      const response = await request(event.video!)
      expect(response.status).toBe(206)
      expect(await response.text()).toBe('staged')
      expect(await videos.video('another-job', { type: 'render', version: 2, draft: true, file: draft })).toBeNull()
      expect(existsSync(join(dir, LIVE_DIR))).toBe(false)
    } finally { finish() }
    await jobs.forSlug(slug)?.done
    expect(events.at(-1)?.type).toBe('error')
    expect((await request(event.video!)).status).toBe(403)
    expect(videos.roots()).toEqual([])
    expect(readFileSync(original, 'utf8')).toBe('published video')
    expect(existsSync(join(dir, LIVE_DIR))).toBe(false)
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
      async (s, e) => (e.firstLook ? `reel-media://f/${s}/look` : null)
    )
    jobs.start(slug, 'first-edit', async (emit) => {
      emit({ type: 'status', message: 'Listening to your video', pct: 50, phase: 'listen' })
      emit({ type: 'heard', words: ['hello'] })
      emit({ type: 'render', version: 0, draft: true, firstLook: true, file: join(projectDir(slug), 'x.mp4') })
      emit({ type: 'status', message: 'Watching your video and planning the edit', phase: 'edit', thinking: true })
      await new Promise((r) => setTimeout(r, 80))
      emit({ type: 'tool', name: 'set_cut', summary: 'Kept your best takes' })
      emit({ type: 'reply', text: 'Done soon.' })
      return { summary: 'ok', version: 1, quiet: true }
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
    expect(events.filter((e) => e.type === 'status').every((e) => e.type === 'status' && typeof e.overall === 'number' && typeof e.pct === 'number')).toBe(true)
    // no time left before the video's length is known (it would only jump up later), then a number
    const statuses = events.filter((e) => e.type === 'status')
    expect(statuses[0]).toMatchObject({ secondsLeft: null })
    expect(statuses.some((e) => e.type === 'status' && typeof e.secondsLeft === 'number' && e.secondsLeft > 0)).toBe(true)
    expect(existsSync(projectDir(slug))).toBe(true)
  })
})
