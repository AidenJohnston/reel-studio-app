// The steps of a first edit as the person sees them, in the order the work really happens. Main folds every
// status event into these (jobs.ts); the screens only draw them. Keep free of Node and DOM imports.
import type { Phase } from './api'

export type StepId = 'copy' | 'listen' | 'retakes' | 'edit' | 'sound' | 'subtitles' | 'video' | 'cover' | 'check'
/** skipped = passed over without its work ever starting; stopped = started, then the editor gave up. */
export type StepState = 'todo' | 'now' | 'done' | 'skipped' | 'stopped'
export interface Step {
  id: StepId
  state: StepState
  /** what the step found, once known ("214 words") */
  result?: string
}

export const STEP_LABEL: Record<StepId, string> = {
  copy: 'Copying your video',
  listen: 'Listening to your video',
  retakes: 'Cutting pauses and repeated starts',
  edit: 'Picking takes and pictures',
  sound: 'Mixing your sound',
  subtitles: 'Adding subtitles',
  video: 'Putting your reel together',
  cover: 'Making your cover',
  check: 'Checking your reel'
}

const ORDER = Object.keys(STEP_LABEL) as StepId[]

/** What a row says beside its label when its work did not happen. */
export function stepNote(s: Step): string | null {
  if (s.state === 'stopped') return 'Stopped: your editor gave up'
  if (s.state !== 'skipped') return null
  return s.id === 'edit' ? 'Skipped: no editor' : 'Skipped'
}

// The final render's own messages (engine render.py), in the order it says them.
const FINAL: [RegExp, StepId][] = [
  [/caption|subtitle/i, 'subtitles'],
  [/making your video/i, 'video'],
  [/cover/i, 'cover'],
  [/checking your video/i, 'check']
]
const BEFORE_PHASES: [RegExp, StepId][] = [
  [/copy/i, 'copy'],
  [/listen/i, 'listen'],
  [/retake|pause|best takes|first cut/i, 'retakes']
]

/**
 * `phase` is the job's current phase (it carries over to events that name none); `noAI` marks the simple edit's
 * own events (ai editor.ts deterministicEdit). Rows only move forward. A row is done only if its work started;
 * one jumped over says so.
 */
export function createFirstEditSteps() {
  let cur = 0
  const started = new Set<StepId>(['copy'])
  let stopped: StepId | null = null
  const results: Partial<Record<StepId, string>> = {}

  const target = (e: { message: string; phase?: Phase }): StepId | null => {
    switch (e.phase) {
      case 'prepare':          // a clip re-encoded at import (#146) is part of bringing the video in
        return 'copy'
      case 'listen':
        return 'listen'
      case 'analyze':
        return 'retakes'
      case 'edit':
        return 'edit'
      case 'final':
        return FINAL.find(([re]) => re.test(e.message))?.[1] ?? 'sound'
      default:
        return BEFORE_PHASES.find(([re]) => re.test(e.message))?.[1] ?? null
    }
  }

  return {
    update(e: { message: string; phase?: Phase; noAI?: boolean }): void {
      if (e.noAI && ORDER[cur] === 'edit') stopped = 'edit'
      const id = target(e)
      if (!id) return
      const i = ORDER.indexOf(id)
      if (i <= cur) return
      cur = i
      started.add(id)
    },
    result(id: StepId, text: string): void {
      results[id] = text
    },
    steps(): Step[] {
      return ORDER.map((id, i) => ({
        id,
        state: i === cur ? 'now' : i > cur ? 'todo' : id === stopped ? 'stopped' : started.has(id) ? 'done' : 'skipped',
        ...(results[id] ? { result: results[id] } : {})
      }))
    }
  }
}
