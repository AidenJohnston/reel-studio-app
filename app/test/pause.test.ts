import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { createJobManager } from '../src/main/jobs'
import { createPauser, pauseFor, quitQuestion } from '../src/main/pause'
import { projectDir, readAppState, updateAppState } from '../src/main/store'
import { setupPaths } from './helpers'
import { pauseLine, pausedSentence, pausedWords } from '../src/shared/pause'

describe('pauseFor: what pauses instead of failing (ux-foundation-b.md 3.4, 7)', () => {
  const ctx = { kind: 'first-edit' as const, online: true, slept: false, editor: 'Claude' }
  // fails if a plan limit, no internet or sleep is reported as "Didn't finish", or a real failure is called a pause
  it('pauses Version 1 for a plan limit, no internet or sleep, and nothing else', () => {
    const until = '2026-10-23T20:40:00.000Z'
    expect(pauseFor({ code: 'cli_limited', resetsAt: until }, ctx)).toEqual({ reason: 'limit', until, editor: 'Claude' })
    expect(pauseFor({ code: 'chatgpt_usage_limit' }, ctx)).toEqual({ reason: 'limit', until: null, editor: 'Claude' })
    expect(pauseFor({ code: 'cli_limited', resetsAt: 'soon' }, ctx)).toMatchObject({ until: null })
    expect(pauseFor({ code: 'cli_error' }, { ...ctx, online: false })).toMatchObject({ reason: 'offline' })
    expect(pauseFor({ code: 'cli_timeout' }, { ...ctx, slept: true })).toMatchObject({ reason: 'sleep' })
    expect(pauseFor({ code: 'ENGINE_FAILED' }, ctx)).toBeNull()
    expect(pauseFor(new Error('boom'), ctx)).toBeNull()
  })
  it('pauses a note only for a plan limit: offline, a note says it did not finish (B section 7)', () => {
    const note = { ...ctx, kind: 'note' as const, online: false, slept: true }
    expect(pauseFor({ code: 'cli_limited' }, note)).toMatchObject({ reason: 'limit' })
    expect(pauseFor({ code: 'cli_error' }, note)).toBeNull()
  })
})

describe('createPauser: it goes on by itself', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const setup = () => {
    let online = true
    const resumed: string[] = []
    const p = createPauser({ online: () => online, resume: async (s) => void resumed.push(s), log: () => undefined, marginMs: 30_000 })
    return { p, resumed, goOffline: () => (online = false), goOnline: () => (online = true) }
  }

  // fails if a reel paused at its plan limit continues before the reset, or never does
  it('continues a plan limit 30 s after its reset time, or after a minute when none was given', () => {
    const { p, resumed } = setup()
    const now = Date.now()
    p.schedule('a', { reason: 'limit', until: new Date(now + 120_000).toISOString(), editor: null }, now)
    p.schedule('b', { reason: 'limit', until: null, editor: null }, now)
    vi.advanceTimersByTime(59_000)
    expect(resumed).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(resumed).toEqual(['b'])
    vi.advanceTimersByTime(90_000)
    expect(resumed).toEqual(['b', 'a'])
  })

  // fails if a server that keeps sending a reset already past (or none) is retried at once, or forever
  it('a past, missing or near reset backs off 1, 2, 5, 15 minutes, then waits for Resume; a finished job starts over', () => {
    const { p, resumed } = setup()
    const at: number[] = []
    const t0 = Date.now()
    const stale = new Date(t0 - 3_600_000).toISOString()
    for (let i = 0; i < 6; i++) {
      p.schedule('r', { reason: 'limit', until: i % 2 ? stale : new Date(Date.now() + 5_000).toISOString(), editor: null })
      const before = resumed.length
      vi.advanceTimersByTime(16 * 60_000)
      if (resumed.length > before) at.push(Math.round((Date.now() - t0) / 60_000))
    }
    // tries 1-4 fired after 1, 2, 5 and 15 minutes (each schedule starts a 16-minute step); then nothing more
    expect(resumed).toEqual(['r', 'r', 'r', 'r'])
    expect(p.pending()).toEqual([])
    p.settled('r')
    p.schedule('r', { reason: 'limit', until: stale, editor: null })
    vi.advanceTimersByTime(60_000)
    expect(resumed).toHaveLength(5)
  })

  // fails if "Waiting for internet" never notices the network is back, or sleep never continues on wake
  it('continues no-internet once online, sleep on wake (or once online), a quit at once; a cancelled one never', () => {
    const { p, resumed, goOffline, goOnline } = setup()
    goOffline()
    p.slept()
    p.schedule('net', { reason: 'offline', until: null, editor: null })
    p.schedule('nap', { reason: 'sleep', until: null, editor: null })
    p.schedule('gone', { reason: 'offline', until: null, editor: null })
    p.cancel('gone')
    vi.advanceTimersByTime(20_000)
    expect(resumed).toEqual([])
    p.woke() // awake but still offline: sleep now waits for the network too
    goOnline()
    vi.advanceTimersByTime(5_000)
    expect(resumed.sort()).toEqual(['nap', 'net'])
    p.schedule('quit', { reason: 'quit', until: null, editor: null })
    expect(resumed).toContain('quit')
    expect(p.pending()).toEqual([])
  })

  // fails if a sleep pause that lands after the wake (a request that timed out on waking) waits for another wake
  it('continues a sleep pause scheduled after the wake once online, without another wake', () => {
    const { p, resumed } = setup()
    p.slept()
    p.woke()
    p.schedule('late', { reason: 'sleep', until: null, editor: null })
    vi.advanceTimersByTime(5_000)
    expect(resumed).toEqual(['late'])
  })
})

describe('a pause in app.json', () => {
  // fails if an export (or a script) while a note waits for its plan's reset wipes the pause, so nothing continues it
  it('stays through an export and goes when the paused work itself starts again', async () => {
    setupPaths()
    const slug = 'paused-reel'
    mkdirSync(projectDir(slug), { recursive: true })
    const paused = { reason: 'limit' as const, until: '2026-10-23T20:40:00.000Z', editor: 'Claude' }
    await updateAppState(slug, (s) => void ((s.status = 'ready'), (s.paused = paused)))
    const jobs = createJobManager(() => undefined, () => undefined)
    const run = async (kind: 'export' | 'note') => jobs.get(jobs.start(slug, kind, async () => ({ summary: 'ok', quiet: true })))!.done
    await run('export')
    expect((await readAppState(slug)).paused).toEqual(paused)
    await run('note')
    expect((await readAppState(slug)).paused).toBeUndefined()
  })
})

describe('the words of a pause', () => {
  const now = new Date(2026, 9, 23, 14, 0)
  it('say when it continues, or what it waits for, and whose plan', () => {
    const at = new Date(2026, 9, 23, 15, 40).toISOString()
    const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(pausedWords({ reason: 'limit', until: at, editor: 'Claude' }, now, 'Mac')).toBe(`Continues at ${time}`)
    expect(pausedWords({ reason: 'limit', until: new Date(2026, 9, 24, 9).toISOString(), editor: null }, now, 'Mac')).toBe('Continues tomorrow')
    expect(pausedWords({ reason: 'offline', until: null, editor: null }, now, 'Mac')).toBe('Waiting for internet')
    expect(pausedWords({ reason: 'sleep', until: null, editor: null }, now, 'PC')).toBe('Continues when your PC wakes')
    expect(pausedSentence({ reason: 'limit', until: at, editor: 'Claude' }, now, 'Mac')).toBe(`Your Claude plan is at its limit, so this continues when it resets at ${time}.`)
    expect(pausedSentence({ reason: 'limit', until: null, editor: null }, now, 'Mac')).toBe('Your plan is at its limit, so this continues when it resets.')
  })
  // fails if a paused card says only that it is paused, without why or what happens next
  it('on a card, say why it stopped and what happens next, for each reason', () => {
    const at = new Date(2026, 9, 23, 15, 40).toISOString()
    const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const line = (p: Parameters<typeof pauseLine>[0]) => pauseLine(p, now, 'Mac')
    expect(line(null)).toEqual({ why: 'You paused it', next: 'resumes where it stopped' })
    expect(line({ reason: 'limit', until: at, editor: 'Claude' })).toEqual({ why: 'Claude plan limit', next: `continues at ${time}` })
    expect(line({ reason: 'limit', until: new Date(2026, 9, 24, 9).toISOString(), editor: null })).toEqual({ why: 'Plan limit', next: 'continues tomorrow' })
    expect(line({ reason: 'limit', until: null, editor: null })).toEqual({ why: 'Plan limit', next: 'continues when it resets' })
    expect(line({ reason: 'offline', until: null, editor: null })).toEqual({ why: 'No internet', next: 'continues once online' })
    expect(line({ reason: 'sleep', until: null, editor: null })).toEqual({ why: 'Your Mac slept', next: 'continues when it wakes' })
    expect(line({ reason: 'quit', until: null, editor: null })).toEqual({ why: 'Reel Studio closed', next: 'continuing now' })
  })
  it('asks once before a quit, counting the reels being made', () => {
    expect(quitQuestion(0)).toBeNull()
    expect(quitQuestion(1)?.message).toBe('1 reel is still being made. Quit and continue it next time?')
    expect(quitQuestion(2)?.message).toBe('2 reels are still being made. Quit and continue them next time?')
  })
})
