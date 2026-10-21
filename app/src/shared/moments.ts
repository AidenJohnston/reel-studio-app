// A note asked "at a moment" (the change button under the player) names the moment in its own text:
// `At 0:14 (around "you don't need a mixer", words w80, w81, w82): cut this part`. The note path has
// no time field, and the project anchors everything on transcript word ids, so the words are resolved
// when the note is sent, from the render on screen (wordsAt), and the AI reads them as written.
// The marks on the scrub bar are read back from the chat. No Node or DOM imports (unit-tested).
import type { ChatMessage, MomentWord, NoteOutcome, Word } from './api'
import { clock } from './progress'

/** One kept span of a source on a render's output clock: an entry of `segmentsDetail` in the
 * engine's versions/vN/render.json (engine/reelengine/render_ctx.py Segment). */
export interface RenderSegment {
  source: string
  src_start: number
  src_end: number
  out_start: number
}

/**
 * The words that play within `radius` seconds of output time `t` in a render, in the order they
 * play. Each word lands where the render's own segments put its source time, so cuts, kept pauses
 * and versions all line up with the frame on screen. Empty when nothing is said near `t`.
 */
export function wordsAt(segments: RenderSegment[], words: Word[], t: number, radius = 1.1): MomentWord[] {
  const lo = t - radius
  const hi = t + radius
  const hits: { id: string; w: string; s: number }[] = []
  for (const seg of segments) {
    const shift = seg.out_start - seg.src_start
    for (const w of words) {
      if ((w.source ?? seg.source) !== seg.source || w.e <= seg.src_start || w.s >= seg.src_end) continue
      const s = Math.max(w.s, seg.src_start) + shift
      const e = Math.min(w.e, seg.src_end) + shift
      if (s < hi && e > lo) hits.push({ id: w.id, w: w.w, s })
    }
  }
  hits.sort((a, b) => a.s - b.s)
  // a word kept twice (a repeated take) is named once, where it first plays
  const out: MomentWord[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (seen.has(h.id)) continue
    seen.add(h.id)
    out.push({ id: h.id, w: h.w.trim() })
  }
  return out
}

// The quoted words never carry the parentheses or quotes that delimit them in the note.
const quoted = (words: MomentWord[]): string => words.map((x) => x.w.replace(/["()]/g, '')).join(' ')

export function momentNote(seconds: number, words: MomentWord[], text: string): string {
  return `At ${clock(seconds)} (around "${quoted(words)}", words ${words.map((x) => x.id).join(', ')}): ${text}`
}

const MOMENT = /^At (\d+):([0-5]\d)(?: \([^()]*\))?: /

/** Seconds into the reel a note points at, or null for a note about the whole reel. */
export function noteMoment(text: string): number | null {
  const m = MOMENT.exec(text)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** "At 1:00: zoom in" typed into the box: that time wins over the playhead, and is taken off the text. */
export function typedMoment(text: string): { at: number; rest: string } | null {
  const m = /^at (\d+):([0-5]\d)\b[:,]?\s*/i.exec(text.trim())
  return m ? { at: Number(m[1]) * 60 + Number(m[2]), rest: text.trim().slice(m[0].length) } : null
}

export type MarkState = 'making' | NoteOutcome

export interface NoteMark {
  id: string
  at: number
  /** what was asked, without the "At 0:14 (...): " prefix */
  text: string
  state: MarkState
}

/**
 * One mark per moment note, from the note's own job: being made while that job runs, else the
 * outcome the job recorded on the note. A note whose job ended without one (the app quit mid-change)
 * was stopped. Notes from before outcomes were recorded read the reply right after them, never one
 * that came after a later note.
 */
export function noteMarks(chat: ChatMessage[], runningJobId: string | null): NoteMark[] {
  const marks: NoteMark[] = []
  let newest = 0
  chat.forEach((m, i) => {
    if (m.from === 'editor') newest = Math.max(newest, m.version ?? 0)
    if (m.from !== 'you') return
    const at = noteMoment(m.text)
    if (at === null) return
    let state: MarkState
    if (m.jobId) state = m.jobId === runningJobId ? 'making' : (m.outcome ?? 'stopped')
    else {
      const next = chat.slice(i + 1).find((r) => r.from === 'you' || r.from === 'editor')
      state = next?.from === 'editor' && (next.version ?? 0) > newest ? 'done' : 'failed'
    }
    marks.push({ id: m.id, at, text: m.text.replace(MOMENT, ''), state })
  })
  return marks
}

const BUSIEST_FIRST: MarkState[] = ['making', 'failed', 'stopped', 'done']

/** Marks drawn closer than `minPx` on a `trackPx`-wide bar share one target; it shows its busiest state. */
export function groupMarks(marks: NoteMark[], duration: number, trackPx: number, minPx = 24): { at: number; state: MarkState; items: NoteMark[] }[] {
  const groups: { at: number; state: MarkState; items: NoteMark[] }[] = []
  for (const m of [...marks].sort((a, b) => a.at - b.at)) {
    const last = groups[groups.length - 1]
    if (!last || ((m.at - last.at) / duration) * trackPx >= minPx) {
      groups.push({ at: m.at, state: m.state, items: [m] })
      continue
    }
    last.items.push(m)
    if (BUSIEST_FIRST.indexOf(m.state) < BUSIEST_FIRST.indexOf(last.state)) last.state = m.state
  }
  return groups
}
