// The job event contract (shared/api.ts JobUpdate -> JobEvent) end to end without Electron: what a job
// emits, what main adds (overall, secondsLeft, thinking kept across ticks, a playable `video` for every
// render), and how the renderer folds it (shared/live.ts).
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobEvent } from '../src/shared/api'
import { EMPTY_LIVE, PREVIEW_LABEL, liveFromDetail, reduceLive, type LiveState } from '../src/shared/live'
import { createLiveVideos, LIVE_DIR } from '../src/main/live-video'
import { createJobManager } from '../src/main/jobs'
import { pathFromMediaUrl } from '../src/main/media-url'
import { projectDir } from '../src/main/store'
import { setupPaths } from './helpers'

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

  it('fails if a render still reporting after Stop puts "Making Version 5" back over the stopped note', async () => {
    const events: JobEvent[] = []
    const jobs = createJobManager((e) => events.push(e), () => undefined)
    const id = jobs.start(null, 'note', (emit, signal) => new Promise((_, reject) => {
      emit({ type: 'status', message: 'Making Version 5', pct: 40, phase: 'final' })
      signal.addEventListener('abort', () => {
        // the engine runner settles on Stop at once; lines the killed render already wrote still arrive
        reject({ code: 'CANCELLED', userMessage: 'Stopped.' })
        setTimeout(() => emit({ type: 'status', message: 'Making Version 5', pct: 60, phase: 'final' }), 0)
      })
    }))
    const done = jobs.get(id)!.done
    jobs.cancel(id)
    await done
    await new Promise((r) => setTimeout(r, 20))
    expect(events.at(-1)?.type).toBe('cancelled')
  })
})
