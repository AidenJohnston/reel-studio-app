import { describe, expect, it } from 'vitest'
import { DEFAULTS, ProgressTracker, learn, type SpeedHistory } from '../src/main/progress'
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

  it('fails if a long final overrun freezes the bar or claims completion', () => {
    let now = 0
    const t = new ProgressTracker('rerender', 60, empty(), () => now)
    t.update('final', 5)
    expect(t.snapshot()).toMatchObject({ etaSec: 28, overdue: false })
    const budget = t.snapshot().etaSec! * 1000
    now = 2 * budget
    const earlier = t.snapshot().overall
    now = 10 * budget
    expect(t.snapshot()).toMatchObject({ etaSec: null, overdue: true })
    expect(t.snapshot().overall).toBeGreaterThan(earlier)
    expect(t.snapshot().overall).toBeLessThan(99)
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
    expect(fast.snapshot().etaSec!).toBeLessThan(full.snapshot().etaSec!)
  })

  it('retains the fixed base while learning the per-minute cost', () => {
    const legacy: SpeedHistory = { v: 1, phases: { 'note:final': { base: 6, perMin: 22, n: 3 } } }
    expect(new ProgressTracker('note', 120, legacy).estimate('final')).toBe(50)
    const h = learn(legacy, 'note', 120, { edit: 0, final: 6 + 2 * 60 })
    const d = DEFAULTS['note:final']
    expect(h.phases['note:final']!.base).toBe(6)
    expect(new ProgressTracker('note', 120, h).estimate('final')).toBeCloseTo(72.8)
    expect(h.phases['note:final']!.perMin).toBeGreaterThan(d.perMin)   // measured 60 s/min vs 22 default
    expect(h.phases['note:edit']).toBeUndefined()                       // a skipped phase teaches nothing
    const t = new ProgressTracker('note', 120, h)
    const t0 = new ProgressTracker('note', 120, empty())
    expect(t.estimate('final')).toBeGreaterThan(t0.estimate('final'))
  })

  it('does not scale fixed AI latency from a short clip to a long clip', () => {
    const history = learn(empty(), 'first-edit', 5, { edit: 128, final: 10 })
    const long = new ProgressTracker('first-edit', 600, history)
    expect(history.phases['first-edit:edit']!.base).toBe(128)
    expect(long.estimate('edit')).toBe(128)
    expect(long.estimate('final')).toBeCloseTo(248)
  })

  it('does not say almost there during an AI overrun with a render ahead', () => {
    let now = 0
    const tracker = new ProgressTracker('first-edit', 600, empty(), () => now)
    tracker.update('listen', 0)
    now = tracker.estimate('listen') * 1000
    tracker.update('edit', 0)
    now += 200_000
    expect(tracker.snapshot()).toMatchObject({ etaSec: null, overdue: false })
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

  it('fails if the recorded basic edit includes AI time or loses completed phase timings', async () => {
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

  it('fails if nested 100% events finish the render bar', () => {
    let now = 0
    const t = new ProgressTracker('rerender', 60, empty(), () => now)
    t.update('final', 0)
    now = 1000
    t.update('final', 100)
    expect(t.snapshot().overall).toBeLessThan(5)
    now = 2000
    t.update('final', 16)
    expect(t.snapshot().overall).toBeGreaterThan(5)
    now = 10_000
    t.update('final', 50, true)
    expect(t.snapshot()).toMatchObject({ overall: 50, etaSec: 10 })
  })

  it('fails if AI latency slows the following render estimate', () => {
    let now = 0
    const t = new ProgressTracker('note', 60, empty(), () => now)
    t.update('edit', 0)
    now = 300_000
    t.update('final', 0)
    expect(t.snapshot().etaSec).toBe(28)
  })

  it('fails if invalid saved timings produce a non-finite estimate', () => {
    const t = new ProgressTracker('rerender', 60, { v: 1, phases: {
      'rerender:final': { base: 6, perMin: Infinity, n: 1 }
    } }, () => 0)
    t.update('final', 0)
    expect(t.snapshot().etaSec).toBe(28)
  })
})
