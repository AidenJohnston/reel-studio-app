import { describe, expect, it } from 'vitest'
import { DEFAULTS, ProgressTracker, learn, type SpeedHistory } from '../src/main/progress'
import { timeLeftText as formatEta } from '../src/shared/progress'
import { createJobManager } from '../src/main/jobs'
import { unlocked } from './helpers'

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
    expect(long.snapshot().etaSec!).toBeGreaterThan(short.snapshot().etaSec!)
    const note = new ProgressTracker('note', 44, empty(), () => now)
    note.update('edit', 5)
    now += 10 * 60 * 1000                                     // way past the estimate
    expect(note.snapshot().etaSec!).toBeGreaterThan(0)
  })

  it('a stalled step never freezes the bar (grandma 2: stuck at 10% for a minute)', () => {
    let now = 0
    const t = new ProgressTracker('first-edit', 90, empty(), () => now)
    t.update('listen', 0)                                     // the speech model is still loading: no percent
    const seen: number[] = []
    for (let i = 0; i < 60; i++) { now += 10_000; seen.push(t.snapshot().overall) }   // 10 minutes, nothing reported
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
  })

  it('past the estimate on the last step: no number, "almost there" (grandma 2: "less than a minute" for 3.5 min)', () => {
    let now = 0
    const t = new ProgressTracker('rerender', 60, empty(), () => now)
    t.update('final', 5)
    expect(t.snapshot()).toMatchObject({ overdue: false })
    expect(t.snapshot().etaSec).toBeGreaterThan(0)
    now += 10 * 60_000
    expect(t.snapshot()).toMatchObject({ etaSec: null, overdue: true })
    // a real engine percent that says "lots left" is still a number
    const r = new ProgressTracker('rerender', 60, empty(), () => now)
    r.update('final', 10)
    now += 10 * 60_000
    expect(r.snapshot().overdue).toBe(false)
    expect(r.snapshot().etaSec).toBeGreaterThan(60)
  })

  it('recalibrates: a slow first step makes every later estimate longer', () => {
    let now = 0
    const onTime = new ProgressTracker('first-edit', 60, empty(), () => now)
    onTime.update('listen', 0)
    now += onTime.estimate('listen') * 1000
    onTime.update('analyze', 0)
    const a = onTime.snapshot().etaSec!
    now = 0
    const slow = new ProgressTracker('first-edit', 60, empty(), () => now)
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

  it('learns from what a phase really took on this computer', () => {
    const h = learn(empty(), 'note', 120, { edit: 0, final: 6 + 2 * 60 })
    const d = DEFAULTS['note:final']
    expect(h.phases['note:final']!.n).toBe(1)
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
    const jobs = createJobManager((e) => events.push(e), () => undefined, unlocked, {
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
})
