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
  // First-run fallback from one observation: Claude Sonnet via CLIProxyAPI took
  // 128 s on IMG_7303, 39 s, on 2026-10-21. Local history always replaces this seed.
  'first-edit:edit': { base: 128, perMin: 0 },
  'first-edit:final': { base: 8, perMin: 25 },
  // Basic edits skip AI drafts. Checked against Aiden 5.41 s and IMG_7303 23.13 s finals
  // at 10.77 s and 39.23 s of video in the M4 Pro stage suite.
  'first-edit-basic:final': { base: 2, perMin: 40 },
  'note:edit': { base: 20, perMin: 4 },
  'note:final': { base: 6, perMin: 22 },
  'rerender:final': { base: 6, perMin: 22 }
}

const PLAN: Record<string, Timed[]> = {
  'first-edit': ['listen', 'analyze', 'edit', 'final'],
  'first-edit-basic': ['listen', 'analyze', 'final'],
  note: ['edit', 'final'],
  rerender: ['final']
}

export { timeLeftText as formatEta } from '../shared/progress'

export class ProgressTracker {
  private phases: Timed[]
  private cur = -1
  private phaseStart = 0
  private best = 0
  private jobStart: number | undefined
  private aggregate: { pct: number; at: number } | undefined
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
    const key = `${this.kind}:${phase}`
    const d = DEFAULTS[key] ?? DEFAULTS[key.replace('first-edit-basic:', 'first-edit:')] ?? { base: 10, perMin: 10 }
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

  snapshot(): { overall: number; etaSec: number | null; overdue: boolean } {
    if (this.cur < 0) return { overall: this.best, etaSec: null, overdue: false }
    const estimates = this.phases.map((p) => this.spent[p] === 0 ? 0 : this.phaseEstimate(p))
    const done = this.phases.slice(0, this.cur).reduce((sum, phase) => sum + (this.spent[phase] ?? 0), 0)
    const current = estimates[this.cur]
    const elapsed = Math.max(0, (this.now() - this.phaseStart) / 1000)
    const later = estimates.slice(this.cur + 1).reduce((a, b) => a + b, 0)
    const remaining = Math.max(0, current - elapsed) + later
    const observed = this.factor() !== undefined
    const unknownEdit = this.phases.slice(this.cur).includes('edit') && !this.local('edit')
    const aiBudget = unknownEdit && observed ? this.phaseEstimate('edit') : 0
    const aiElapsed = this.phases[this.cur] === 'edit' ? elapsed : 0
    const other = this.phases[this.cur] === 'edit' ? later : remaining - aiBudget
    const displayRemaining = aiBudget ? Math.max(1, aiBudget - aiElapsed) + other : remaining
    const phaseBudget = Math.max(current, elapsed)
    const aggregateLeft = this.aggregate && this.aggregate.pct > 0 && this.jobStart !== undefined && this.aggregate.at > this.jobStart
      ? (this.aggregate.at - this.jobStart) / 1000 * 100 / this.aggregate.pct - (this.now() - this.jobStart) / 1000
      : undefined
    const total = done + elapsed + Math.max(0, aggregateLeft ?? displayRemaining)
    // Leave a gap below the phase ceiling, shrinking it as an overrun continues.
    const phaseEnd = (done + current * (1 - 0.01 * current / phaseBudget)) / (done + current + later) * 99
    const overall = Math.min(99, aggregateLeft === undefined ? phaseEnd : 99, (done + elapsed) / total * 100)
    this.best = Math.max(this.best, overall, Math.min(99, this.aggregate?.pct ?? 0))
    const remainingPhases = this.phases.slice(this.cur)
    const approximate = remainingPhases.some((p) => !this.local(p))
    const out = { overall: this.best }
    if (!(this.mediaSec > 0)) return { ...out, etaSec: null, overdue: false }
    if (aggregateLeft !== undefined) {
      return { ...out, etaSec: aggregateLeft > 0 ? Math.max(1, aggregateLeft) : null, overdue: false }
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

  finish(): Partial<Record<Timed, number>> {
    if (this.cur >= 0 && this.spent[this.phases[this.cur]] === undefined) this.recordPhase(this.now())
    return { ...this.spent }
  }
}

export function learn(history: SpeedHistory, kind: ProgressKind, mediaSec: number, spent: Partial<Record<Timed, number>>): SpeedHistory {
  const out: SpeedHistory = { v: 1, phases: { ...history.phases } }
  if (!(mediaSec > 0) || !Number.isFinite(mediaSec)) return out
  const min = mediaSec / 60
  for (const [phase, sec] of Object.entries(spent)) {
    if (!sec || sec <= 0 || !Number.isFinite(sec)) continue
    const key = `${kind}:${phase}`
    const previous = out.phases[key]
    // Fixed startup and AI latency must not become a per-minute cost after a short clip.
    // A measured phase can be faster than the fallback startup cost, as in the basic-edit fixture.
    const base = Math.min(sec, (DEFAULTS[key] ?? DEFAULTS[key.replace('first-edit-basic:', 'first-edit:')])?.base ?? 10)
    const prev = previous && previous.n > 0 && previous.base === base ? previous : undefined
    const measured = Math.max(0, sec - base) / min
    if (!Number.isFinite(measured)) continue
    const a = prev ? 0.3 : 1
    out.phases[key] = { base, perMin: (prev?.perMin ?? measured) * (1 - a) + measured * a, n: (prev?.n ?? 0) + 1 }
  }
  return out
}
