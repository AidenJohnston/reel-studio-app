// The live state of a running job, folded from job events (the contract in shared/api.ts). The ONLY
// reader of job events in the renderer: the Working screen and the Reel screen's note progress both
// use it, so a field the job flow adds is wired in one place. Pure (no DOM, no Node): unit-tested.
import type { JobEvent } from './api'
import { timeLeftText } from './progress'

/** What the user is watching while the reel is made. */
export type Preview =
  /** The quick no-AI draft: the cut + subtitles (+ a song), made while the AI still edits. */
  | { kind: 'first-look'; video: string }
  /** The AI's own draft render (it is checking it). */
  | { kind: 'ai-draft'; video: string; version: number }

export interface LiveState {
  jobId: string | null
  message: string
  /** 0-99, never backwards. */
  overall: number
  /** Seconds left for the whole job. null = too early to say. */
  secondsLeft: number | null
  secondsMaxLeft?: number
  approximate?: boolean
  /** Measured work is nearly done, but the current phase ran past its estimate: say "Still working, almost there", no number. */
  overdue: boolean
  /** Waiting on the AI's answer: show "thinking", not "stuck". */
  thinking: boolean
  /** Words heard so far (in order). */
  words: string[]
  /** The newest thing to play while working. */
  preview: Preview | null
  /** Latest things the AI did ("Picked a song: ..."), newest last, at most 4. */
  tools: string[]
  /** A note's reply, known before its render is done (fast notes). */
  reply: string | null
  /** The job ended. */
  end: { kind: 'done'; version?: number } | { kind: 'error'; code: string; userMessage: string } | { kind: 'cancelled' } | null
}

export const EMPTY_LIVE: LiveState = {
  jobId: null,
  message: 'Getting started',
  overall: 0,
  secondsLeft: null,
  overdue: false,
  thinking: false,
  words: [],
  preview: null,
  tools: [],
  reply: null,
  end: null
}

/** Labels the Working screen puts under the preview. */
export const PREVIEW_LABEL: Record<Preview['kind'], string> = {
  'first-look': "Here's a first look. I'm still adding pictures and music.",
  'ai-draft': "Here's my edit so far. I'm checking it now."
}

/** Folds one event in. Events for another job (an older one still talking) start fresh state. */
export function reduceLive(s: LiveState, e: JobEvent): LiveState {
  const base: LiveState = s.jobId && s.jobId !== e.jobId ? { ...EMPTY_LIVE, jobId: e.jobId } : { ...s, jobId: e.jobId }
  switch (e.type) {
    case 'status':
      return {
        ...base,
        message: e.message || base.message,
        overall: Math.max(base.overall, e.overall),
        // Keep the last estimate when an overrun cannot supply a new one.
        secondsLeft: e.secondsLeft ?? base.secondsLeft,
        secondsMaxLeft: e.secondsLeft === null ? base.secondsMaxLeft : e.secondsMaxLeft,
        approximate: e.approximate,
        overdue: e.overdue,
        thinking: e.thinking
      }
    case 'tool':
      return { ...base, thinking: false, tools: [...base.tools.slice(-3), e.summary] }
    case 'heard':
      return { ...base, words: e.words }
    case 'render':
      if (!e.draft || !e.video) return base
      // the AI's draft replaces the first look, never the other way round (the first look can only come first)
      if (e.firstLook) return base.preview?.kind === 'ai-draft' ? base : { ...base, preview: { kind: 'first-look', video: e.video } }
      return { ...base, preview: { kind: 'ai-draft', video: e.video, version: e.version } }
    case 'reply':
      return { ...base, reply: e.text }
    case 'done':
      return { ...base, overall: 100, secondsLeft: 0, overdue: false, thinking: false, end: { kind: 'done', version: e.version } }
    case 'error':
      return { ...base, thinking: false, end: { kind: 'error', code: e.code, userMessage: e.userMessage } }
    case 'cancelled':
      return { ...base, thinking: false, end: { kind: 'cancelled' } }
  }
}

/** State from `projects:get` when a screen opens on a job that is already running. */
export function liveFromDetail(job: { id: string; message: string; overall: number; secondsLeft: number | null; secondsMaxLeft?: number; approximate?: boolean; overdue: boolean; thinking: boolean }): LiveState {
  return { ...EMPTY_LIVE, jobId: job.id, message: job.message, overall: job.overall, secondsLeft: job.secondsLeft, secondsMaxLeft: job.secondsMaxLeft, approximate: job.approximate, overdue: job.overdue, thinking: job.thinking }
}

/** Keep Aiden's rounded wording; uncertain AI work uses the larger budget. */
export function timeLeftWords(s: Pick<LiveState, 'secondsLeft' | 'secondsMaxLeft' | 'approximate' | 'overdue'>): string | null {
  if (s.overdue) return STILL_WORKING
  return timeLeftText(s.secondsMaxLeft ?? s.secondsLeft)
}

export const STILL_WORKING = 'Still working, almost there'
