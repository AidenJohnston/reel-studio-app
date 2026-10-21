// A note asked "Just here" (the change button under the player) carries its moment beside its text:
// the time, and the transcript word ids on screen then, read from the render being watched (wordsAt).
// The person sees "0:08 · cut this part". The AI reads the moment written into the note text
// (aiNoteText), because the project anchors everything on word ids. The marks on the scrub bar go
// the other way: each note's word ids, placed on the render on screen. No Node or DOM imports.
import type { ChatMessage, MomentWord, NoteMoment, NoteOutcome, PlacedWord, Word } from './api'
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
 * Every word a render plays, on that render's output clock, in the order it plays. Each word lands
 * where the render's own segments put its source time, so cuts, kept pauses and versions all line
 * up with the frame on screen. A word kept twice (a repeated take) is listed twice.
 */
export function placeWords(segments: RenderSegment[], words: Word[]): PlacedWord[] {
  const out: PlacedWord[] = []
  for (const seg of segments) {
    const shift = seg.out_start - seg.src_start
    for (const w of words) {
      if ((w.source ?? seg.source) !== seg.source || w.e <= seg.src_start || w.s >= seg.src_end) continue
      out.push({ id: w.id, w: w.w.trim(), s: Math.max(w.s, seg.src_start) + shift, e: Math.min(w.e, seg.src_end) + shift })
    }
  }
  return out.sort((a, b) => a.s - b.s)
}

/** The words that play within `radius` seconds of output time `t`, each named once, where it first plays. */
export function wordsAt(placed: PlacedWord[], t: number, radius = 1.1): MomentWord[] {
  const out: MomentWord[] = []
  const seen = new Set<string>()
  for (const p of placed) {
    if (p.s >= t + radius || p.e <= t - radius || seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ id: p.id, w: p.w })
  }
  return out
}

// The quote never carries the parentheses or quotes that delimit it in the AI's note text.
const unquote = (w: string): string => w.replace(/["()]/g, '')

export function noteMoment(at: number, version: number, words: MomentWord[]): NoteMoment {
  return { at, version, words: words.map((x) => x.id), quote: words.map((x) => unquote(x.w)).join(' ') }
}

/** What the AI reads for a note: `At 0:14 (around "you don't need a mixer", words w80, w81): cut this part`. */
export function aiNoteText(text: string, moment?: NoteMoment): string {
  return moment ? `At ${clock(moment.at)} (around "${unquote(moment.quote)}", words ${moment.words.join(', ')}): ${text}` : text
}

/** A moment from the page, checked before it reaches the chat or the AI. Throws on anything else. */
export function parseMoment(x: unknown): NoteMoment {
  const m = (x ?? {}) as Partial<Record<keyof NoteMoment, unknown>>
  const ok =
    typeof m.at === 'number' && Number.isFinite(m.at) && m.at >= 0 &&
    Number.isInteger(m.version) && (m.version as number) >= 0 &&
    Array.isArray(m.words) && m.words.length > 0 && m.words.length <= 200 &&
    m.words.every((w) => typeof w === 'string' && /^[\w.-]{1,40}$/.test(w)) &&
    typeof m.quote === 'string' && m.quote.length <= 2000
  if (!ok) throw new Error(`not a note moment: ${JSON.stringify(x)?.slice(0, 200)}`)
  return { at: m.at as number, version: m.version as number, words: m.words as string[], quote: m.quote as string }
}

/** "At 1:00: zoom in" typed into the box: that time wins over the playhead, and is taken off the text. */
export function typedMoment(text: string): { at: number; rest: string } | null {
  const m = /^at (\d+):([0-5]\d)\b[:,]?\s*/i.exec(text.trim())
  return m ? { at: Number(m[1]) * 60 + Number(m[2]), rest: text.trim().slice(m[0].length) } : null
}

export type MarkState = 'making' | NoteOutcome

export interface NoteMark {
  id: string
  /** where the note's words play in the render on screen */
  at: number
  /** what was asked */
  text: string
  state: MarkState
}

/**
 * One mark per moment note whose words play in the render on screen (`placed`), at the middle one of
 * them that does. A note whose words were all cut from this render has no mark here: its old time
 * would point at other words. State comes from the note's own job: being made while that job runs,
 * else the outcome the job recorded; a job that ended without one (the app quit mid-change) was
 * stopped, and a note that started no job (no AI editor) changed nothing.
 */
export function noteMarks(chat: ChatMessage[], runningJobId: string | null, placed: PlacedWord[]): NoteMark[] {
  const plays = new Map<string, number>()
  for (const p of placed) if (!plays.has(p.id)) plays.set(p.id, p.s)
  const marks: NoteMark[] = []
  for (const m of chat) {
    if (m.from !== 'you') continue
    const times = (m.moment?.words ?? []).flatMap((id) => plays.get(id) ?? [])
    if (!times.length) continue
    const state: MarkState = !m.jobId ? 'failed' : m.jobId === runningJobId ? 'making' : (m.outcome ?? 'stopped')
    marks.push({ id: m.id, at: times[Math.floor(times.length / 2)], text: m.text, state })
  }
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
