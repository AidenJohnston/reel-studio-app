// Honest overall progress + "about N minutes left" for long jobs. The ai package tags its status
// events with a phase (listen, analyze, edit, final); each phase's length is estimated from what it
// took on THIS computer before (speed-history.json, scaled by minutes of video), falling back to
// measured defaults. Inside a phase the bar follows the engine's real percent, or time against the
// estimate while the AI is thinking, so it never freezes and never runs backwards.
import type { JobKind, Phase } from '../shared/api'

export type { Phase } from '../shared/api'
type Timed = Exclude<Phase, 'firstLook'>

export interface PhaseModel { base: number; perMin: number; n: number }
export interface SpeedHistory { v: 1; phases: Partial<Record<string, PhaseModel>> }

/** Seconds = base + perMin x minutes of raw video. From status/speed.md (Windows, RTX 4070, Claude Code). */
export const DEFAULTS: Record<string, Omit<PhaseModel, 'n'>> = {
  'first-edit:listen': { base: 6, perMin: 8 },
  'first-edit:analyze': { base: 2, perMin: 4 },
  'first-edit:edit': { base: 45, perMin: 12 },
  'first-edit:final': { base: 8, perMin: 25 },
  'note:edit': { base: 20, perMin: 4 },
  'note:final': { base: 6, perMin: 22 },
  'rerender:final': { base: 6, perMin: 22 }
}

const PLAN: Record<string, Timed[]> = {
  'first-edit': ['listen', 'analyze', 'edit', 'final'],
  note: ['edit', 'final'],
  rerender: ['final']
}

/** Phases where the reported percent is real work done (an engine command), not a milestone. */
const REAL_PCT = new Set<Phase>(['listen', 'analyze', 'final'])

export { timeLeftText as formatEta } from '../shared/progress'

export class ProgressTracker {
  private phases: Timed[]
  private cur = -1
  private phaseStart = 0
  private reported = 0
  private best = 0
  private heldAt: number | null = null
  private readonly spent: Partial<Record<Timed, number>> = {}

  constructor(
    private readonly kind: JobKind,
    private mediaSec: number,
    private history: SpeedHistory,
    private readonly now: () => number = Date.now
  ) {
    this.phases = [...(PLAN[kind] ?? ['final'])]
  }

  setHistory(h: SpeedHistory): void {
    if (h && typeof h === 'object' && h.phases) this.history = h
  }

  setMedia(sec: number): void {
    if (sec > 0) this.mediaSec = sec
  }

  estimate(phase: Timed): number {
    const key = `${this.kind}:${phase}`
    const h = this.history.phases[key]
    const d = DEFAULTS[key] ?? { base: 10, perMin: 10 }
    const m = h && h.n > 0 ? h : d
    return Math.max(2, m.base + m.perMin * (this.mediaSec / 60))
  }

  /** While the job waits for another reel's render (render-slot.ts) the bar and the clock stop: the
   * wait is not this phase running long, so afterwards the estimate neither jumps nor says "overdue". */
  hold(on: boolean): void {
    if (on === (this.heldAt !== null)) return
    if (on) this.heldAt = this.now()
    else {
      this.phaseStart += this.now() - this.heldAt!
      this.heldAt = null
    }
  }

  /** A status event: `phase` moves us forward (never back); `pct` is that step's own percent. */
  update(phase: Phase | undefined, pct: number | undefined): void {
    if (phase && phase !== 'firstLook') {
      let i = this.phases.indexOf(phase)
      if (i < 0) {
        // e.g. a fast note goes straight to final: drop the phases it skips
        this.phases.push(phase)
        i = this.phases.length - 1
      }
      if (i > this.cur) {
        const t = this.now()
        if (this.cur >= 0) this.spent[this.phases[this.cur]] = (t - this.phaseStart) / 1000
        // phases we jumped over (already transcribed; a fast note) cost nothing
        for (let k = Math.max(0, this.cur + 1); k < i; k++) this.spent[this.phases[k]] = 0
        this.cur = i
        this.phaseStart = t
        if (this.heldAt !== null) this.heldAt = t
        this.reported = 0
      }
    }
    if (this.cur >= 0 && typeof pct === 'number' && Number.isFinite(pct)) {
      this.reported = Math.max(this.reported, Math.min(100, Math.max(0, pct)) / 100)
    }
  }

  /** How much slower than estimated this computer is running THIS job (1 = on time, 0.6-3): what the
   * finished phases really took against their estimates, and the current phase once it overruns. Every
   * estimate still ahead is scaled by it, so time left recalibrates continuously instead of being wrong. */
  private pace(): number {
    let est = 0
    let real = 0
    for (let i = 0; i < this.cur; i++) {
      const sec = this.spent[this.phases[i]]
      if (!sec) continue // skipped phases say nothing about speed
      est += this.estimate(this.phases[i])
      real += sec
    }
    let pace = est > 0 ? real / est : 1
    if (this.cur >= 0) {
      const elapsed = (this.now() - this.phaseStart) / 1000
      pace = Math.max(pace, elapsed / this.estimate(this.phases[this.cur]))
    }
    return Math.min(3, Math.max(0.6, pace))
  }

  /** Share of the current phase done. Time always moves it (a stalled step still creeps, never freezes):
   * linear up to the estimate, then ever slower toward the end of the phase. */
  private fraction(): number {
    if (this.cur < 0) return 0
    const p = this.phases[this.cur]
    const x = (this.now() - this.phaseStart) / 1000 / this.estimate(p)
    // past the estimate: 0.9 -> 1 as 1 - 0.1/x (0.95 at twice the estimate), slower and slower but never flat
    const byTime = x <= 1 ? 0.9 * x : 1 - 0.1 / x
    // engine steps report real work, AI milestones are rough; time keeps both moving
    const byPct = REAL_PCT.has(p) ? this.reported : Math.min(0.95, this.reported)
    return Math.min(0.99, Math.max(byPct, byTime * (REAL_PCT.has(p) ? 0.8 : 1)))
  }

  /** 0-99 overall percent (monotonic) and seconds left. etaSec null + overdue = past every estimate on the
   * last step: say "almost there" rather than a number that keeps being wrong. */
  snapshot(): { overall: number; etaSec: number | null; overdue: boolean } {
    const est = this.phases.map((p, i) => (i < this.cur ? 0 : this.estimate(p)))
    const doneEst = this.phases.reduce((a, p, i) => a + (i < this.cur ? this.estimate(p) : 0), 0)
    const total = this.phases.reduce((a, p) => a + this.estimate(p), 0)
    if (this.heldAt !== null) return { overall: this.best, etaSec: null, overdue: false }
    if (this.cur < 0) return { overall: this.best, etaSec: Math.round(total), overdue: false }
    const f = this.fraction()
    const curEst = est[this.cur]
    const elapsed = (this.now() - this.phaseStart) / 1000
    const pace = this.pace()
    const later = est.slice(this.cur + 1).reduce((a, b) => a + b, 0) * pace
    // the current step: from its real rate when an engine reports one, else its estimate at this job's pace
    const real = REAL_PCT.has(this.phases[this.cur]) && this.reported > 0.05
    const curLeft = real ? (elapsed / this.reported) * (1 - this.reported) : Math.max(0, curEst * pace - elapsed)
    const last = this.cur === this.phases.length - 1
    const overall = Math.min(99, ((doneEst + f * curEst) / total) * 100)
    this.best = Math.max(this.best, overall)
    // not rounded: a long overrun moves it by tiny amounts, and tiny is still moving
    const out = { overall: this.best }
    // the last step ran past its estimate and the numbers say "seconds": they were wrong once, don't repeat them
    if (last && elapsed > curEst && curLeft < 30) return { ...out, etaSec: null, overdue: true }
    return { ...out, etaSec: Math.max(5, Math.round(curLeft + later)), overdue: false }
  }

  /** At the end of a successful job: what each phase really took, for next time. */
  finish(): Partial<Record<Timed, number>> {
    if (this.cur >= 0 && this.spent[this.phases[this.cur]] === undefined) {
      this.spent[this.phases[this.cur]] = (this.now() - this.phaseStart) / 1000
    }
    return { ...this.spent }
  }
}

/** Folds one finished job into the history: the per-minute rate moves 30% toward what it measured. */
export function learn(history: SpeedHistory, kind: JobKind, mediaSec: number, spent: Partial<Record<Timed, number>>): SpeedHistory {
  const out: SpeedHistory = { v: 1, phases: { ...history.phases } }
  const min = Math.max(0.1, mediaSec / 60)
  for (const [phase, sec] of Object.entries(spent)) {
    if (!sec || sec <= 0) continue      // skipped phases teach nothing
    const key = `${kind}:${phase}`
    const d = DEFAULTS[key] ?? { base: 10, perMin: 10 }
    const prev = out.phases[key] ?? { ...d, n: 0 }
    const measuredPerMin = Math.max(0, (sec - prev.base) / min)
    const a = prev.n === 0 ? 0.5 : 0.3
    out.phases[key] = { base: prev.base, perMin: Math.round((prev.perMin * (1 - a) + measuredPerMin * a) * 100) / 100, n: prev.n + 1 }
  }
  return out
}
