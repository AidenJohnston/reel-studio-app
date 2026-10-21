import { describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { DEFAULTS, ProgressTracker, learn, migrateHistory, type SpeedHistory } from '../src/main/progress'
import { timeLeftText as formatEta } from '../src/shared/progress'
import { createJobManager } from '../src/main/jobs'

const empty = (): SpeedHistory => ({ v: 1, phases: {} })

describe('honest progress', () => {
  it('moves through phases, never backwards, and keeps moving on time alone while the AI thinks', () => {
    let now = 0
    const t = new ProgressTracker('first-edit', 60, empty(), () => now)
    const seen: number[] = []
    const snap = (): void => { seen.push(t.snapshot().overall) }
    t.update('listen', 10); snap()
    now += 5000; t.update('listen', 90); snap()
    t.update('analyze', 0); snap()
    now += 3000; t.update('edit', 8); snap()
    for (let i = 0; i < 20; i++) { now += 2000; snap() }   // no events: the model is thinking
    t.update('edit', 30); snap()                              // a lower step percent never pulls it back
    t.update('final', 5); snap()
    now += 20000; t.update('final', 80); snap()
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen[seen.length - 1]).toBeGreaterThan(80)
    expect(seen[seen.length - 1]).toBeLessThan(100)
    // time alone moved it during the thinking stretch
    expect(seen[24]).toBeGreaterThan(seen[4])
  })

  it('estimates time left from the video length, and never says 0 while still working', () => {
    let now = 0
    const short = new ProgressTracker('first-edit', 44, empty(), () => now)
    const long = new ProgressTracker('first-edit', 240, empty(), () => now)
    short.update('listen', 0); long.update('listen', 0)
    expect(short.snapshot().etaSec).toBeNull()
    expect(long.snapshot().etaSec).toBeNull()
    now += 10_000
    short.update('analyze', 0); long.update('analyze', 0)
    expect(long.estimate('final')).toBeGreaterThan(short.estimate('final'))
    const note = new ProgressTracker('note', 44, empty(), () => now)
    note.update('edit', 5)
    now += 10 * 60 * 1000                                     // way past the estimate
    expect(note.snapshot().etaSec).toBeNull()
  })

  it('a stalled step never freezes the bar (grandma 2: stuck at 10% for a minute)', () => {
    let now = 0
    const t = new ProgressTracker('first-edit', 90, empty(), () => now)
    t.update('listen', 0)                                     // the speech model is still loading: no percent
    const seen: number[] = []
    for (let i = 0; i < 60; i++) { now += 10_000; seen.push(t.snapshot().overall) }   // 10 minutes, nothing reported
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
  })

  it('keeps an unmeasured final overrun neutral', () => {
    let now = 0
    const t = new ProgressTracker('rerender', 60, empty(), () => now)
    t.update('final', 5)
    expect(t.snapshot()).toMatchObject({ overdue: false })
    expect(t.snapshot()).toMatchObject({ etaSec: 28, approximate: true })
    now += 10 * 60_000
    expect(t.snapshot()).toMatchObject({ etaSec: null, overdue: false })
  })

  it('recalibrates remaining engine defaults from a slow first step', () => {
    let now = 0
    const onTime = new ProgressTracker('first-edit-basic', 60, empty(), () => now)
    onTime.update('listen', 0)
    now += onTime.estimate('listen') * 1000
    onTime.update('analyze', 0)
    const a = onTime.snapshot().etaSec!
    now = 0
    const slow = new ProgressTracker('first-edit-basic', 60, empty(), () => now)
    slow.update('listen', 0)
    now += slow.estimate('listen') * 2 * 1000
    slow.update('analyze', 0)
    expect(slow.snapshot().etaSec!).toBeGreaterThan(a * 1.5)
  })

  it('a fast note (straight to the final render) is estimated as the render alone', () => {
    const now = 0
    const fast = new ProgressTracker('note', 60, empty(), () => now)
    fast.update('final', 10)
    const full = new ProgressTracker('note', 60, empty(), () => now)
    full.update('edit', 5)
    expect(fast.snapshot().etaSec).toBe(28)
    expect(full.snapshot().etaSec).toBe(52)
    expect(fast.estimate('final')).toBeLessThan(full.estimate('edit') + full.estimate('final'))
  })

  it('learns from what a phase really took on this computer', () => {
    const h = learn(empty(), 'note', 120, { edit: 0, final: 6 + 2 * 60 })
    const d = DEFAULTS['note:final']
    expect(h.phases['note:final']!.n).toBe(1)
    expect(h.phases['note:final']!.base).toBe(0)
    expect(h.phases['note:final']!.perMin).toBeGreaterThan(d.perMin)   // measured 60 s/min vs 22 default
    expect(h.phases['note:edit']).toBeUndefined()                       // a skipped phase teaches nothing
    const t = new ProgressTracker('note', 120, h)
    const t0 = new ProgressTracker('note', 120, empty())
    expect(t.estimate('final')).toBeGreaterThan(t0.estimate('final'))
  })

  it('formats time left in plain words', () => {
    expect(formatEta(null)).toBeNull()
    expect(formatEta(10)).toBe('Almost done')
    expect(formatEta(40)).toBe('Less than a minute left')
    expect(formatEta(75)).toBe('About a minute left')
    expect(formatEta(130)).toBe('About 2 minutes left')
  })

  it('the job manager adds overall + secondsLeft, re-broadcasts while idle, and saves what it measured', async () => {
    const events: any[] = []
    let saved: SpeedHistory | null = null
    const jobs = createJobManager((e) => events.push(e), () => undefined, {
      loadHistory: async () => empty(),
      saveHistory: async (h) => { saved = h },
      mediaSeconds: async () => 60,
      tickMs: 20
    })
    jobs.start(null, 'rerender', async (emit) => {
      emit({ type: 'status', message: 'Making your video', pct: 10, phase: 'final' })
      await new Promise((r) => setTimeout(r, 120))
      emit({ type: 'status', message: 'Making your video', pct: 90, phase: 'final' })
      return { summary: 'ok' }
    })
    await new Promise((r) => setTimeout(r, 300))
    const statuses = events.filter((e) => e.type === 'status')
    expect(statuses.length).toBeGreaterThan(4)                 // ticks while nothing happened
    expect(statuses.every((e) => typeof e.overall === 'number' && 'secondsLeft' in e && typeof e.thinking === 'boolean')).toBe(true)
    expect(events.at(-1).type).toBe('done')
    // slug null: no project to measure, so nothing learned (mediaSeconds is per project)
    expect(saved).toBeNull()
  })

  it('replays Aiden within 30% first-run and 10% with local history', async () => {
    const fixture = (await import('./fixtures/aiden-progress.json')).default
    const replay = (history: SpeedHistory) => {
      let now = 0
      const tracker = new ProgressTracker('first-edit-basic', fixture.mediaSeconds, history, () => now)
      const rows = fixture.events.map((e) => {
        now = e.at * 1000
        const phase = e.phase
        if (phase !== null && phase !== 'listen' && phase !== 'analyze' && phase !== 'final') throw new Error(`Unexpected phase: ${phase}`)
        tracker.update(phase ?? undefined, e.pct)
        return { at: e.at, ...tracker.snapshot() }
      })
      now = fixture.duration * 1000
      return { rows, spent: tracker.finish() }
    }
    const first = replay(empty())
    const second = replay(learn(empty(), 'first-edit-basic', fixture.mediaSeconds, first.spent))
    for (const [run, tolerance] of [[first, 0.3], [second, 0.1]] as const) {
      const afterListen = fixture.events.find((e) => e.phase === 'analyze')!
      const row = run.rows.find((r) => r.at === afterListen.at)!
      expect(row.etaSec).not.toBeNull()
      expect(Math.abs(row.etaSec! - (fixture.duration - row.at)) / (fixture.duration - row.at)).toBeLessThanOrEqual(tolerance)
    }
    expect(first.spent.edit).toBeUndefined()
  })

  it('does not let substep percentages pin the bar and excludes AI editing from the basic plan', () => {
    let now = 0
    const t = new ProgressTracker('rerender', 60, empty(), () => now)
    t.update('final', 0); now += 1000; t.update('final', 100)
    const pinned = t.snapshot().overall
    t.update('final', 16); expect(t.snapshot().overall).toBe(pinned)
    now += 1000; t.update('final', 20); expect(t.snapshot().overall).toBeGreaterThan(pinned)
    const basic = new ProgressTracker('first-edit-basic', 60, empty(), () => now)
    const ai = new ProgressTracker('first-edit', 60, empty(), () => now)
    basic.update('listen', 0); ai.update('listen', 0); now += 14_000; basic.update('analyze', 0); ai.update('analyze', 0)
    expect(basic.snapshot().etaSec).toBeLessThan(ai.snapshot().etaSec!)
    expect(ai.snapshot().etaMaxSec).toBeGreaterThan(ai.snapshot().etaSec!)
  })

  it('keeps overruns neutral without measured near-completion or known media length', () => {
    let now = 0
    const first = new ProgressTracker('first-edit', 60, empty(), () => now)
    const unknown = new ProgressTracker('rerender', 0, empty(), () => now)
    const measured = new ProgressTracker('rerender', 60, learn(empty(), 'rerender', 60, { final: 10 }), () => now)
    first.update('listen', 0); unknown.update('final', 0); measured.update('final', 0)
    now = 15_000
    expect(first.snapshot()).toMatchObject({ etaSec: null, overdue: false })
    expect(unknown.snapshot()).toMatchObject({ etaSec: null, overdue: false })
    expect(measured.snapshot()).toMatchObject({ etaSec: null, overdue: true })
  })

  it('does not use AI note latency to estimate rendering without engine history', () => {
    let now = 0
    const note = new ProgressTracker('note', 60, empty(), () => now)
    note.update('edit', 0)
    now = 300_000
    note.update('final', 0)
    expect(note.snapshot()).toMatchObject({ etaSec: 28, approximate: true, overdue: false })
    const history = learn(empty(), 'note', 60, { final: 28 })
    const known = new ProgressTracker('note', 60, history, () => now)
    known.update('edit', 0)
    now += 300_000
    known.update('final', 0)
    expect(known.snapshot()).toMatchObject({ etaSec: 28, approximate: false, overdue: false })
  })

  it('times phases monotonically and rejects nonpositive clock samples', () => {
    let wall = 30_000
    let monotonic = 0
    const date = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    try {
      const tracker = new ProgressTracker('first-edit-basic', 60, empty())
      tracker.update('listen', 0)
      wall -= 30_000; monotonic += 10_000
      tracker.update('analyze', 0)
      expect(tracker.finish().listen).toBe(10)
      let invalid = 30_000
      const injected = new ProgressTracker('first-edit-basic', 60, empty(), () => invalid)
      injected.update('listen', 0)
      invalid -= 30_000
      injected.update('analyze', 0)
      expect(injected.finish().listen).toBeUndefined()
      expect(injected.snapshot()).toMatchObject({ etaSec: null, overdue: false })
    } finally {
      date.mockRestore()
      clock.mockRestore()
    }
  })

  it('anchors an unmeasured AI range on the live run and widens it during editing', () => {
    let now = 0
    const tracker = new ProgressTracker('first-edit', 39, empty(), () => now)
    tracker.update('listen', 0)
    now = 10_000; tracker.update('edit', 0)
    const first = tracker.snapshot()
    expect(first.etaSec).toBeGreaterThanOrEqual(128)
    now += 100_000
    const later = tracker.snapshot()
    expect(later.etaSec).toBeGreaterThanOrEqual(first.etaSec!)
    expect(later.etaMaxSec).toBeGreaterThan(first.etaMaxSec!)
    const history = learn(empty(), 'first-edit', 39, { edit: 128 })
    expect(new ProgressTracker('first-edit', 39, history).estimate('edit')).toBeCloseTo(128, 1)
  })

  it('continues advancing during the observed 100-second AI stretch', () => {
    let now = 0
    const tracker = new ProgressTracker('first-edit', 39, empty(), () => now)
    tracker.update('listen', 0)
    now = 10_000; tracker.update('analyze', 0)
    now += 300; tracker.update('edit', 0)
    now = 41_000
    const before = tracker.snapshot().overall
    now = 141_000
    expect(tracker.snapshot().overall - before).toBeGreaterThan(10)
    const last = tracker.snapshot().overall
    now += 1000
    expect(tracker.snapshot().overall).toBeGreaterThan(last)
  })

  it('keeps approximate estimates for notes, rerenders, and legacy history', () => {
    for (const kind of ['note', 'rerender'] as const) {
      const tracker = new ProgressTracker(kind, 120, empty(), () => 0)
      tracker.update(kind === 'note' ? 'edit' : 'final', 0)
      expect(tracker.snapshot().etaSec).toBeGreaterThan(0)
      expect(tracker.snapshot()).toMatchObject({ approximate: true, overdue: false })
    }
    const legacy: SpeedHistory = { v: 1, phases: { 'rerender:final': { base: 6, perMin: 22, n: 3 } } }
    const migrated = migrateHistory(legacy, 120)
    expect(migrated.phases['rerender:final']).toMatchObject({ base: 0, perMin: 25, n: 3 })
    expect(migrateHistory(migrated, 60)).toBe(migrated)
    let now = 0
    const tracker = new ProgressTracker('rerender', 120, migrated, () => now)
    tracker.update('final', 0)
    expect(tracker.snapshot()).toMatchObject({ etaSec: 50, approximate: true })
    now = 60_000
    expect(tracker.snapshot()).toMatchObject({ etaSec: null, overdue: false })
    expect(learn(migrated, 'rerender', 120, { final: 40 }).phases['rerender:final']).toEqual({ base: 0, perMin: 20, n: 4 })
  })

  it('uses explicitly aggregate percentages for the bar and ETA without accepting substep resets', () => {
    let now = 0
    const tracker = new ProgressTracker('rerender', 60, empty(), () => now)
    tracker.update('final', 0, true)
    now = 10_000
    tracker.update('final', 50, true)
    expect(tracker.snapshot()).toMatchObject({ overall: 50, etaSec: 10, approximate: true })
    tracker.update('final', 100)
    tracker.update('final', 5)
    expect(tracker.snapshot()).toMatchObject({ overall: 50, etaSec: 10 })
  })
})
