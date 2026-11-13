// Overall progress and "about N minutes left" for long jobs. The ai package tags its status events
// with a phase (listen, analyze, edit, final). Each phase's length comes from what it took on THIS
// computer before (speed-history.json), else from the defaults below. Engine phases still ahead with no
// history of their own are rescaled by how fast this job's finished engine phases ran; the AI wait
// never rescales them.
import { performance } from 'node:perf_hooks'
import type { JobKind, Phase } from '../shared/api'

export type { Phase } from '../shared/api'
type Timed = Exclude<Phase, 'firstLook'>
export type ProgressKind = JobKind | 'first-edit-basic'

export interface PhaseModel { base: number; perMin: number; n: number }
export interface SpeedHistory { v: 1; phases: Partial<Record<string, PhaseModel>> }

export function parseHistory(value: unknown): SpeedHistory {
  const out: SpeedHistory = { v: 1, phases: {} }
  if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1 ||
      !('phases' in value) || !value.phases || typeof value.phases !== 'object') return out
  for (const [key, model] of Object.entries(value.phases)) {
    if (!model || typeof model !== 'object') continue
    const { base, perMin, n } = model
    if (typeof base === 'number' && typeof perMin === 'number' && typeof n === 'number' &&
        [base, perMin, n].every((x) => Number.isFinite(x) && x >= 0)) out.phases[key] = { base, perMin, n }
  }
  return out
}

/** Seconds = base + perMin x minutes of raw video. Original defaults: status/speed.md, Windows RTX 4070. */
export const DEFAULTS: Record<string, Omit<PhaseModel, 'n'>> = {
  'first-edit:listen': { base: 6, perMin: 8 },
  'first-edit:analyze': { base: 2, perMin: 4 },
  // First-run fallback from one observation: Claude Sonnet took 128 s on a 39 s
  // clip on 2026-10-21. Local history always replaces this seed.
  'first-edit:edit': { base: 128, perMin: 0 },
  'first-edit:final': { base: 8, perMin: 25 },
  // Basic edits skip AI drafts. Checked against 5.41 s and 23.13 s finals
  // at 10.77 s and 39.23 s of video in the M4 Pro stage suite.
  'first-edit-basic:final': { base: 2, perMin: 40 },
  'note:edit': { base: 20, perMin: 4 },
  'note:final': { base: 6, perMin: 22 },
  'rerender:final': { base: 6, perMin: 22 }
}

function defaultModel(key: string): Omit<PhaseModel, 'n'> {
  return DEFAULTS[key] ?? DEFAULTS[key.replace('first-edit-basic:', 'first-edit:')] ?? { base: 10, perMin: 10 }
}

const PLAN: Record<string, Timed[]> = {
  'first-edit': ['listen', 'analyze', 'edit', 'final'],
  'first-edit-basic': ['listen', 'analyze', 'final'],
  note: ['edit', 'final'],
  rerender: ['final']
}

export { timeLeftText as formatEta } from '../shared/progress'

/** The highest a whole-job percent shows by itself (the engine's `render` stage); the rest is left to the creep. */
const AGGREGATE_CAP = 99 * 0.99
/** Once a job runs past what it was expected to take, the gap between the bar and 99% shrinks to
 * gap / (1 + seconds / CREEP_SECONDS): halved after this many seconds, then ever slower. Not a fixed half-life:
 * halving every 30 s rounds the bar to exactly 99 within half an hour, and this never gets there.
 * No measurement chose 30 s. From 98% the bar rises a quarter of a point in the first ten seconds. From 98.9%
 * only a tenth of a point is left, so no setting moves it visibly; the time-left line beside it has to say it. */
const CREEP_SECONDS = 30

export class ProgressTracker {
  private phases: Timed[]
  private cur = -1
  private phaseStart = 0
  private best = 0
  private jobStart: number | undefined
  private aggregate: { pct: number; at: number } | undefined
  /** Where the creep toward 99% started: when, and the gap then. Restarts whenever an estimate raises the bar. */
  private creep: { at: number; gap: number } | undefined
  private readonly spent: Partial<Record<Timed, number>> = {}

  constructor(
    private readonly kind: ProgressKind,
    private mediaSec: number,
    private history: SpeedHistory,
    private readonly now: () => number = () => performance.now()
  ) {
    this.phases = [...(PLAN[kind] ?? ['final'])]
    this.history = parseHistory(history)
  }

  setMedia(sec: number): void {
    if (sec > 0 && Number.isFinite(sec)) this.mediaSec = sec
  }

  private default(phase: Timed): number {
    const d = defaultModel(`${this.kind}:${phase}`)
    return Math.max(2, d.base + d.perMin * (this.mediaSec / 60))
  }

  private local(phase: Timed): PhaseModel | undefined {
    const h = this.history.phases[`${this.kind}:${phase}`]
    return h && h.n > 0 && Number.isFinite(h.base + h.perMin * (this.mediaSec / 60)) ? h : undefined
  }

  estimate(phase: Timed): number {
    const h = this.local(phase)
    return h ? Math.max(0.01, h.base + h.perMin * (this.mediaSec / 60)) : this.default(phase)
  }

  private factor(): number | undefined {
    const factors = this.phases
      .slice(0, this.cur)
      // AI response latency does not measure engine throughput.
      .filter((p) => p !== 'edit')
      .map((p) => {
        const sec = this.spent[p]
        const d = this.default(p)
        return sec !== undefined && sec > 0 && Number.isFinite(sec) ? sec / d : null
      })
      .filter((x): x is number => x !== null && Number.isFinite(x))
      .sort((a, b) => a - b)
    if (!factors.length) return undefined
    const middle = Math.floor(factors.length / 2)
    return factors.length % 2 ? factors[middle] : (factors[middle - 1] + factors[middle]) / 2
  }

  private phaseEstimate(phase: Timed): number {
    if (this.local(phase)) return this.estimate(phase)
    return this.default(phase) * (phase === 'edit' ? 1 : this.factor() ?? 1)
  }

  /** A status event. `phase` moves the job forward, never back; phases it jumps over cost nothing.
   * A step's own percent is ignored, because engine substeps each reach 100%. `aggregate` marks a
   * whole-job percent (the engine's `render` stage), which then drives the bar and time left. */
  update(phase: Phase | undefined, pct: number | undefined, aggregate = false): void {
    const t = this.now()
    if (aggregate && pct !== undefined && Number.isFinite(pct)) {
      this.jobStart ??= t
      if (!this.aggregate || pct > this.aggregate.pct) this.aggregate = { pct: Math.max(0, Math.min(100, pct)), at: t }
    }
    if (!phase || phase === 'firstLook') return
    let i = this.phases.indexOf(phase)
    if (i < 0) {
      this.phases.push(phase)
      i = this.phases.length - 1
    }
    if (i <= this.cur) return
    this.jobStart ??= t
    this.recordPhase(t)
    for (let k = Math.max(0, this.cur + 1); k < i; k++) this.spent[this.phases[k]] = 0
    this.cur = i
    this.phaseStart = t
  }

  /** 0-99 overall percent (never decreasing) and seconds left. etaSec null with overdue means the last
   * phase outlived its estimate ("Still working, almost there"); null without it means no honest number. */
  snapshot(): { overall: number; etaSec: number | null; overdue: boolean } {
    if (this.cur < 0) return { overall: this.best, etaSec: null, overdue: false }
    const estimates = this.phases.map((p) => this.spent[p] === 0 ? 0 : this.phaseEstimate(p))
    const done = this.phases.slice(0, this.cur).reduce((sum, phase) => sum + (this.spent[phase] ?? 0), 0)
    const current = estimates[this.cur]
    const elapsed = Math.max(0, (this.now() - this.phaseStart) / 1000)
    const later = estimates.slice(this.cur + 1).reduce((a, b) => a + b, 0)
    const remaining = Math.max(0, current - elapsed) + later
    // A first AI step with no local history is a guess: once an engine phase has shown this computer's
    // speed, time left budgets the AI step separately from the engine work around it.
    const observed = this.factor() !== undefined
    const unknownEdit = this.phases.slice(this.cur).includes('edit') && !this.local('edit')
    const aiBudget = unknownEdit && observed ? this.phaseEstimate('edit') : 0
    const aiElapsed = this.phases[this.cur] === 'edit' ? elapsed : 0
    const other = this.phases[this.cur] === 'edit' ? later : remaining - aiBudget
    const displayRemaining = aiBudget ? Math.max(1, aiBudget - aiElapsed) + other : remaining
    const phaseBudget = Math.max(current, elapsed)
    // A whole-job percent, when the engine sends one, projects the rest from the job's own pace.
    const projected = this.aggregate && this.aggregate.pct > 0 && this.jobStart !== undefined && this.aggregate.at > this.jobStart
      ? (this.aggregate.at - this.jobStart) / 1000 * 100 / this.aggregate.pct
      : undefined
    const jobElapsed = this.jobStart === undefined ? 0 : (this.now() - this.jobStart) / 1000
    const aggregateLeft = projected === undefined ? undefined : projected - jobElapsed
    const total = done + elapsed + Math.max(0, aggregateLeft ?? displayRemaining)
    // Leave a gap below the phase ceiling, shrinking it as an overrun continues. A whole-job percent shows at
    // most AGGREGATE_CAP.
    const ceiling = projected === undefined
      ? (done + current * (1 - 0.01 * current / phaseBudget)) / (done + current + later) * 99
      : AGGREGATE_CAP
    const raised = Math.min(ceiling, Math.max((done + elapsed) / total * 100, this.aggregate?.pct ?? 0))
    // Past the projection, or at the cap a whole-job percent cannot pass, time alone moves the bar, whatever a
    // later engine report does to the projection. Lower down, a report that has fallen behind the bar holds it
    // instead: creeping from there would race the bar toward 99 with most of the job still to do.
    const pastEstimate = projected === undefined ? remaining <= 0 : aggregateLeft! <= 0 || this.best >= AGGREGATE_CAP
    if (!pastEstimate || raised > this.best) this.creep = undefined
    this.best = Math.max(this.best, raised)
    if (pastEstimate) {
      const t = this.now()
      this.creep ??= { at: t, gap: 99 - this.best }
      this.best = Math.max(this.best, 99 - this.creep.gap / (1 + (t - this.creep.at) / 1000 / CREEP_SECONDS))
    }
    const remainingPhases = this.phases.slice(this.cur)
    const approximate = remainingPhases.some((p) => !this.local(p))
    const out = { overall: this.best }
    if (!(this.mediaSec > 0)) return { ...out, etaSec: null, overdue: false }
    if (aggregateLeft !== undefined) {
      return { ...out, etaSec: aggregateLeft > 0 ? Math.max(1, aggregateLeft) : null, overdue: aggregateLeft <= 0 && this.cur === this.phases.length - 1 }
    }
    if (unknownEdit && observed) {
      if (aiElapsed > aiBudget) return { ...out, etaSec: null, overdue: false }
      return { ...out, etaSec: displayRemaining, overdue: false }
    }
    if (elapsed > current) return { ...out, etaSec: null, overdue: this.cur === this.phases.length - 1 }
    if (approximate && !observed && this.kind !== 'note' && this.kind !== 'rerender') return { ...out, etaSec: null, overdue: false }
    return { ...out, etaSec: Math.max(1, remaining), overdue: false }
  }

  private recordPhase(t: number): void {
    if (this.cur < 0) return
    const sec = (t - this.phaseStart) / 1000
    if (sec > 0 && Number.isFinite(sec)) this.spent[this.phases[this.cur]] = sec
  }

  /** Seconds each phase took, for learn(); the current phase ends now. */
  finish(): Partial<Record<Timed, number>> {
    if (this.cur >= 0 && this.spent[this.phases[this.cur]] === undefined) this.recordPhase(this.now())
    return { ...this.spent }
  }
}

/** Folds one finished job's phase times into the history. The AI step's wait hardly depends on clip
 * length, so `edit` is learned as flat seconds. An engine phase keeps its default's shape (a fixed
 * start plus a cost per minute of video) and learns one speed factor, so a short clip neither turns
 * startup time into a per-minute cost nor makes a long video look free. With earlier history, the
 * new time counts for 30%; both are compared at this clip's length, whatever shape the old entry has. */
export function learn(history: SpeedHistory, kind: ProgressKind, mediaSec: number, spent: Partial<Record<Timed, number>>): SpeedHistory {
  const out: SpeedHistory = { v: 1, phases: { ...history.phases } }
  if (!(mediaSec > 0) || !Number.isFinite(mediaSec)) return out
  const min = mediaSec / 60
  for (const [phase, sec] of Object.entries(spent)) {
    if (!sec || sec <= 0 || !Number.isFinite(sec)) continue
    const key = `${kind}:${phase}`
    const previous = out.phases[key]
    const before = previous && previous.n > 0 ? previous.base + previous.perMin * min : NaN
    const known = Number.isFinite(before)
    const blended = known ? before * 0.7 + sec * 0.3 : sec
    const n = (known ? previous!.n : 0) + 1
    if (phase === 'edit') {
      out.phases[key] = { base: blended, perMin: 0, n }
      continue
    }
    const d = defaultModel(key)
    const speed = blended / (d.base + d.perMin * min)
    if (!Number.isFinite(speed)) continue
    out.phases[key] = { base: d.base * speed, perMin: d.perMin * speed, n }
  }
  return out
}
