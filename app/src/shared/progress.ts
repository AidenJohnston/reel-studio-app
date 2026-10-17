// Working-screen progress, shared by the renderer (the bar, time left) and main (Dock / taskbar
// progress). Keep free of Node and DOM imports.

/** The steps of a first edit, in plain words, with how much of the total time each one usually takes. */
export const STAGES: { label: string; match: RegExp; weight: number }[] = [
  { label: 'Copying your video', match: /copy|getting started/i, weight: 4 },
  { label: 'Listening to your video', match: /listen|transcri|speech/i, weight: 30 },
  { label: 'Picking your best takes', match: /take|retake|cut|pause/i, weight: 10 },
  { label: 'Adding subtitles', match: /caption|subtitle/i, weight: 5 },
  { label: 'Adding pictures', match: /b-roll|broll|image|picture|library|animation/i, weight: 12 },
  { label: 'Adding music', match: /music|song/i, weight: 5 },
  { label: 'Making your cover', match: /cover/i, weight: 4 },
  { label: 'Putting it all together', match: /together|render|making your video|finish|final|check|look|done/i, weight: 30 }
]

const TOTAL = STAGES.reduce((a, s) => a + s.weight, 0)
const BEFORE = STAGES.map((_, i) => STAGES.slice(0, i).reduce((a, s) => a + s.weight, 0))

export function stageIndex(message: string, current: number): number {
  const i = STAGES.findIndex((s) => s.match.test(message))
  return i < 0 ? current : Math.max(current, i)
}

/**
 * Overall percent from the step we are in plus that step's own percent, each step counted by its
 * usual share of the time. Engines and the AI report percent per step (it restarts at 0 and hits
 * 100 many times), so the raw number alone would jump to the end and sit there. Never goes backwards.
 */
export function overallProgress(stage: number, pct: number, prev: number): number {
  const s = Math.max(0, Math.min(STAGES.length - 1, stage))
  const inStage = Math.max(0, Math.min(100, pct)) / 100
  const v = ((BEFORE[s] + STAGES[s].weight * inStage * 0.95) / TOTAL) * 100
  return Math.max(prev, Math.min(99, v))
}

/**
 * "About 3 minutes left", from how fast the bar has moved so far. Says nothing until there is
 * enough to go on, rounds so it does not flicker, and never says "0 minutes".
 */
export function timeLeftText(secondsLeft: number | null): string | null {
  if (secondsLeft === null || !isFinite(secondsLeft) || secondsLeft < 0) return null
  if (secondsLeft < 20) return 'Almost done'
  if (secondsLeft < 60) return 'Less than a minute left'
  const mins = Math.round(secondsLeft / 60)
  if (mins <= 1) return 'About a minute left'
  if (mins < 60) return `About ${mins} minutes left`
  return 'More than an hour left'
}

/** Seconds left from the bar's speed so far. null = too early to say. */
export function estimateSecondsLeft(pct: number, elapsedSec: number): number | null {
  if (pct < 6 || elapsedSec < 8) return null
  return (elapsedSec / pct) * (100 - pct)
}

/** "0:16" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
