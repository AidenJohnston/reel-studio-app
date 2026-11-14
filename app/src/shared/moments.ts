// A note asked "Just here" (the change button under the player) carries its moment beside its text:
// the time, and the transcript word ids on screen then, read from the render being watched (wordsAt).
// The person sees "0:08 cut this part", the time muted. The AI reads the moment written into the note text
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
  /** Seconds of this span's voice heard before its picture starts: a J join (cut.py). Absent or 0: none. */
  audio_lead?: number
  /** Seconds of this span's voice heard after its picture ends: an L join (cut.py). Absent or 0: none. */
  audio_tail?: number
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

/**
 * Where output time `t` comes from: the source and the time in it, by the render's own segments.
 * A segment's last instant counts, so the end of the reel still maps. null in a gap or past the end.
 */
export function sourceAt(segments: RenderSegment[], t: number): { source: string; at: number } | null {
  const seg = segments.find((s) => t >= s.out_start && t <= s.out_start + (s.src_end - s.src_start))
  return seg ? { source: seg.source, at: seg.src_start + (t - seg.out_start) } : null
}

/** sourceAt backwards: where `at` seconds into take `source` plays in the render, or null when the render cut it. */
export function outputAt(segments: RenderSegment[], source: string, at: number): number | null {
  const seg = segments.find((s) => s.source === source && at >= s.src_start && at <= s.src_end)
  return seg ? seg.out_start + (at - seg.src_start) : null
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

export function noteMoment(at: number, version: number, words: MomentWord[], to?: number): NoteMoment {
  return { at, ...(to !== undefined ? { to } : {}), version, words: words.map((x) => x.id), quote: words.map((x) => unquote(x.w)).join(' ') }
}

/** The words that play between `from` and `to`: a range dragged on the timeline. */
export function wordsBetween(placed: PlacedWord[], from: number, to: number): MomentWord[] {
  const out: MomentWord[] = []
  const seen = new Set<string>()
  for (const p of placed) {
    if (p.s >= to || p.e <= from || seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ id: p.id, w: p.w })
  }
  return out
}

/** "0:12" or "0:12–0:15". */
/** A moment as the player's clock and the note box's chip show it: whole seconds, rounded down, so a note made at 7.5 s
 * reads 0:07 everywhere (clock() rounds, which made it 0:08 in the chat beside a 0:07 chip). */
export const momentLabel = (m: { at: number; to?: number }): string => {
  const t = (s: number): string => clock(Math.floor(s))
  return m.to !== undefined ? `${t(m.at)}–${t(m.to)}` : t(m.at)
}

/** What the AI reads for a note: `At 0:14 (around "you don't need a mixer", words w80, w81): cut this part`. */
export function aiNoteText(text: string, moment?: NoteMoment): string {
  if (!moment) return text
  const when = moment.to !== undefined ? `From ${clock(moment.at)} to ${clock(moment.to)}` : `At ${clock(moment.at)}`
  return `${when} (around "${unquote(moment.quote)}", words ${moment.words.join(', ')}): ${text}`
}

// transcript word ids: project.schema.json wordId (^w[0-9]+$), with a length bound
const WORD_ID = /^w[0-9]{1,9}$/

/** A moment from the page, checked before it reaches the chat or the AI. Throws on anything else. */
export function parseMoment(x: unknown): NoteMoment {
  const m = (x ?? {}) as Partial<Record<keyof NoteMoment, unknown>>
  const ok =
    typeof m.at === 'number' && Number.isFinite(m.at) && m.at >= 0 &&
    Number.isInteger(m.version) && (m.version as number) >= 0 &&
    Array.isArray(m.words) && m.words.length > 0 && m.words.length <= 200 &&
    m.words.every((w) => typeof w === 'string' && WORD_ID.test(w)) &&
    typeof m.quote === 'string' && m.quote.length <= 2000 &&
    (m.to === undefined || (typeof m.to === 'number' && Number.isFinite(m.to) && m.to > (m.at as number)))
  if (!ok) throw new Error(`not a note moment: ${JSON.stringify(x)?.slice(0, 200)}`)
  return { at: m.at as number, ...(m.to !== undefined ? { to: m.to as number } : {}), version: m.version as number, words: m.words as string[], quote: m.quote as string }
}

/** "At 1:00: zoom in" typed into the box: that time wins over the playhead, and is taken off the text. */
export function typedMoment(text: string): { at: number; rest: string } | null {
  const m = /^at (\d+):([0-5]\d)\b[:,]?\s*/i.exec(text.trim())
  return m ? { at: Number(m[1]) * 60 + Number(m[2]), rest: text.trim().slice(m[0].length) } : null
}

// The only words a "Just here" note may use to go without its moment: what a whole-reel setting is
// about (captions, music), which way it goes, and filler. Place words are an open set ("the opening",
// "the hook", "once I start the demo"), so listing them always misses one; this list is closed, and a
// word outside it keeps the moment. Missing a setting costs a full-editor turn; dropping a place
// changes the whole reel.
const SETTING_WORDS = new Set([
  'caption', 'captions', 'subtitle', 'subtitles', 'subs', 'text', 'words', 'on', 'screen', 'music', 'background', 'beat',
  'smaller', 'bigger', 'larger', 'tinier', 'shrink', 'enlarge', 'higher', 'lower', 'up', 'down', 'quieter', 'louder',
  'softer', 'big', 'large', 'small', 'tiny', 'loud', 'quiet', 'soft', 'hard', 'read', 'hear', 'less', 'more', 'too',
  'no', 'remove', 'turn', 'off', 'take', 'out', 'get', 'rid', 'of', 'hide', 'without', 'kill', 'mute', 'add', 'put',
  'back', 'bring', 'show', 'drowning', 'overpowering', 'make', 'the', 'a', 'bit', 'little', 'it', 'them', 'is', 'are',
  'please', 'i', "can't", 'cant', 'can’t'
])

/**
 * How a "Just here" note goes, from the person's words as typed. Only a note made entirely of
 * whole-reel setting words (SETTING_WORDS) that the AI package's own fast-note check accepts
 * (`isSetting`: "smaller captions", "quieter music") goes without the moment, so the editor does it
 * at once as it does on main. A typed time ("At 0:05: ...") or any other word keeps the moment for
 * the full editor.
 */
export async function momentRoute(typed: string, isSetting: (words: string) => Promise<boolean>): Promise<'fast' | 'moment'> {
  if (typedMoment(typed)) return 'moment'
  const words = typed.toLowerCase().replace(/[.!,]+/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.every((w) => SETTING_WORDS.has(w))) return 'moment'
  return (await isSetting(typed.trim())) ? 'fast' : 'moment'
}

export const NO_TIMELINE = "The words in this version can't be read. Remove the moment to ask about the whole reel, or switch to the newest version."
export const noSpeech = (at: number): string => `No words play at ${clock(at)}. Pick a moment where you're talking, or remove the moment to ask about the whole reel.`

/**
 * A parsed moment against the render it names (`timeline` null: that version or its timeline is
 * gone). A "Just here" note is never widened to the whole reel: without a timeline, past the end or
 * with nothing said there it is refused, in the pop-up's words. Otherwise the words and quote are
 * rebuilt from that render, whatever the page sent.
 */
export function checkMoment(m: NoteMoment, timeline: { duration: number; words: PlacedWord[] } | null): { moment: NoteMoment } | { refuse: string } {
  if (!timeline) return { refuse: NO_TIMELINE }
  if (m.at > timeline.duration) return { refuse: `There's no ${clock(m.at)} in this reel. It's ${clock(timeline.duration)} long.` }
  const to = m.to === undefined ? undefined : Math.min(m.to, timeline.duration)
  const words = to === undefined ? wordsAt(timeline.words, m.at) : wordsBetween(timeline.words, m.at, to)
  if (!words.length) return { refuse: noSpeech(m.at) }
  return { moment: noteMoment(m.at, m.version, words, to) }
}

// The note text an earlier build of this branch wrote, with the moment inside it. Read for marks
// only; nothing is rewritten.
const LEGACY = /^At \d+:[0-5]\d \(around "[^"]*", words ([^()]*)\): /

function noteIds(m: ChatMessage): { ids: string[]; text: string } {
  if (m.moment) return { ids: m.moment.words, text: m.text }
  const old = LEGACY.exec(m.text)
  return old ? { ids: old[1].split(', ').filter((id) => WORD_ID.test(id)), text: m.text.slice(old[0].length) } : { ids: [], text: m.text }
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
    const { ids, text } = noteIds(m)
    const times = ids.flatMap((id) => plays.get(id) ?? [])
    if (!times.length) continue
    const state: MarkState = !m.jobId ? 'failed' : m.jobId === runningJobId ? 'making' : (m.outcome ?? 'stopped')
    marks.push({ id: m.id, at: times[Math.floor(times.length / 2)], text, state })
  }
  return marks
}

const BUSIEST_FIRST: MarkState[] = ['making', 'paused', 'failed', 'stopped', 'done']

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

type PersonEvent = { type: string; message?: string; summary?: string }

const tidy = (line: string): string =>
  line
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.:;)])/g, '$1')
    .trim()

/**
 * An editor's line without the shapes the app writes into a note for the AI (aiNoteText): the moment wrapper
 * (`At 0:06 (around "…", words w10, w11): `), `(around "…")` and a `words w10, w11` list. Nothing else: a bare
 * "w12" may be the person's own words, quoted back. For editor lines only; the person's text is never rewritten.
 */
export function withoutWordIds(line: string): string {
  if (!/\(around "|\bwords? w\d+/.test(line)) return line
  return tidy(
    line
      .replace(/(?:At|From) \d+:[0-5]\d(?: to \d+:[0-5]\d)? \(around "[^"]*", words [^()]*\): /g, '')
      .replace(/\s*\(around "[^"]*"(?:, words [^()]*)?\)/g, '')
      .replace(/\b(?:at |on )?words? w\d+(?:(?:,| to| and|-) ?w\d+)*/g, '')
  )
}

// the ids aiNoteText handed the AI with this note: "… (around "…", words w10, w11): …"
const HANDED = /^(?:At|From) \d+:[0-5]\d(?: to \d+:[0-5]\d)? \(around "[^"]*", words ([^()]*)\): /

/**
 * A line the editor wrote about a note, as the person may see it: their own words back where it echoed what the AI
 * was handed, no moment wrapper or words list, and no bare id ("on w7 to w9") that is one of the ids handed with
 * this note and not one the person typed themselves.
 */
export function personText(line: string, aiText: string, text: string): string {
  const out = withoutWordIds(aiText && aiText !== text ? line.split(aiText).join(text) : line)
  const handed = new Set((HANDED.exec(aiText)?.[1] ?? '').split(', ').filter((id) => WORD_ID.test(id)))
  if (!handed.size) return out
  const typed = new Set(text.match(/\bw\d+\b/g) ?? [])
  const bare = out.replace(/\b(?:(?:on|at) )?w\d+(?:(?:,| to| and|-) ?w\d+)*/g, (run) =>
    (run.match(/w\d+/g) ?? []).every((id) => handed.has(id) && !typed.has(id)) ? '' : run
  )
  return bare === out ? out : tidy(bare)
}

/**
 * A running note's events as the person may see them. The AI is handed `aiText` (aiNoteText: the moment and
 * transcript word ids written into the note), and anything it or the practice editor echoes would reach the
 * progress card. Each status and tool line gets the person's own words back, and no moment wrapper or word id
 * survives.
 */
export function forPerson<E extends PersonEvent>(emit: (e: E) => void, aiText: string, text: string): (e: E) => void {
  const clean = (line: string): string => personText(line, aiText, text)
  return (e) => {
    if (e.type === 'status' && typeof e.message === 'string') return emit({ ...e, message: clean(e.message) })
    if (e.type === 'tool' && typeof e.summary === 'string') return emit({ ...e, summary: clean(e.summary) })
    emit(e)
  }
}
