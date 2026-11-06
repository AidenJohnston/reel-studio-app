// My style (screens/MyStyle.tsx): each saved rule as one short line, with its kind, where it came from and when,
// newest first. Read from the rule as stored; nothing here writes My style.json.
import type { StyleRule } from './api'

export type MemoryKind = 'captions' | 'pacing' | 'music' | 'cuts' | 'look'

/** The fixed keyword table (notes/design/r11/arch/memory-panel.md). Whole words only, so "cute" is not a cut.
 * "Caption" is left out: in the app it is the text posted under the reel (ux-foundation-b.md section 2), so
 * "end the caption with a question" is not about subtitles. */
const KEYWORDS: Record<MemoryKind, string[]> = {
  captions: ['subtitle', 'subtitles', 'font', 'fonts'],
  pacing: ['pause', 'pauses', 'paused', 'pace', 'paced', 'pacing', 'fast', 'faster', 'slow', 'slower', 'slowly', 'tight', 'tighter', 'tightly'],
  music: ['music', 'song', 'songs', 'volume', 'beat', 'beats'],
  cuts: ['cut', 'cuts', 'cutting', 'take', 'takes', 'b-roll', 'broll', 'jump', 'jumps'],
  look: ['zoom', 'zooms', 'zoomed', 'zooming', 'colour', 'colours', 'color', 'colors', 'cover', 'covers', 'look', 'looks']
}
const KIND_OF = new Map(Object.entries(KEYWORDS).flatMap(([kind, words]) => words.map((w) => [w, kind as MemoryKind])))

/** The kind of the first keyword in the sentence, which usually names what the rule is about ("Zoom in slowly" is
 * the look, not the pacing). No keyword is no kind: a wrong icon misleads more than none. */
export function classifyKind(text: string): MemoryKind | null {
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []) {
    const kind = KIND_OF.get(word) ?? word.split('-').map((part) => KIND_OF.get(part)).find(Boolean)
    if (kind) return kind
  }
  return null
}

/** Screen-reader names. Burned-in words are "subtitles", and "look" already means a subtitle look
 * (ux-foundation-b.md section 2), so the zoom, colour and cover kind is "Visuals". */
export const KIND_NAME: Record<MemoryKind, string> = { captions: 'Subtitles', pacing: 'Pacing', music: 'Music', cuts: 'Cuts', look: 'Visuals' }

const MAX_LINE = 60
// Words that only say "this is a lasting rule": every item here is one. Negations ("never", "don't") always stay.
const LEAD = /^(?:(?:always|please|from now on|going forward|in (?:every|each|all(?: of)?(?: my)?) (?:videos?|reels?)|for (?:all )?(?:future|new|next) (?:videos?|reels?)|make sure(?: to| that)?|remember to|use)\b[\s,:]*)+/i
const TAIL = /[\s,]*\b(?:in (?:every|each|all(?: of)?(?: my)?) (?:videos?|reels?)|from now on|going forward|for next time|next time|every time|always)$/i

/** The rule as a whiteboard line: no "always" or "use" in front, no full stop, at most 60 characters, cut between
 * words. The full sentence, which the editor reads, stays one click away. */
export function shortLine(text: string): string {
  const sentence = text.trim().replace(/[.!?]+$/, '')
  const bare = sentence.replace(TAIL, '').replace(LEAD, '').trim() || sentence
  const line = bare.charAt(0).toUpperCase() + bare.slice(1)
  if (line.length <= MAX_LINE) return line
  let cut = ''
  for (const word of line.split(' ')) {
    if (`${cut} ${word}`.trim().length > MAX_LINE - 1) break
    cut = `${cut} ${word}`.trim()
  }
  return `${(cut || line.slice(0, MAX_LINE - 1)).replace(/[\s,;:]+$/, '')}…`
}

/** When the rule last changed: new words, else when it was saved. A date that can't be read sorts last. */
const changedAt = (r: Pick<StyleRule, 'createdAt' | 'updatedAt'>): number =>
  [r.updatedAt, r.createdAt].map((x) => Date.parse(x ?? '')).find((t) => !Number.isNaN(t)) ?? -Infinity

/** Newest first. Rules saved at the same moment show the one saved last first. */
export function newestFirst<T extends Pick<StyleRule, 'createdAt' | 'updatedAt'>>(rules: T[]): T[] {
  return rules
    .map((rule, i) => ({ rule, i, t: changedAt(rule) }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .map((x) => x.rule)
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "just now", "5 minutes ago", "yesterday", "last week", "3 weeks ago"; null for a date that can't be read. */
export function ago(iso: string, now: number): string | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const minutes = Math.floor((now - t) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return relative.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return relative.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 7) return relative.format(-days, 'day')
  if (days < 30) return relative.format(-Math.floor(days / 7), 'week')
  if (days < 365) return relative.format(-Math.floor(days / 30), 'month')
  return relative.format(-Math.floor(days / 365), 'year')
}

/** Final Cut Pro exports FCPXML; every other export the app reads is Premiere Pro's XML (learn-style.ts editorOf). */
const editorOf = (file: string): string => (/\.fcpxmld?$/i.test(file) ? 'Final Cut Pro' : 'Premiere Pro')
/** "Learn from my past edits" keeps several files as one comma-separated name (MyStyle.tsx keep). */
const filesOf = (r: StyleRule): string[] => r.imported?.file.split(', ').filter(Boolean) ?? []

function origin(r: StyleRule): string | null {
  if (r.imported) {
    const files = filesOf(r)
    return files.length > 1 ? `from ${files.length} of your past edits` : `from your ${editorOf(r.imported.file)} edit ${r.imported.file}`
  }
  if (r.source?.note) return `from your note on “${r.source.title}”`
  if (r.source?.title) return `from “${r.source.title}”`
  if (r.byYou) return 'added by you'
  if (r.learned) return r.learned.from === 'results' ? 'from your post results' : 'from your hand edits'
  return null
}

/** Where the rule came from and when: "from your note on “Bread reel”, 2 days ago". A rule saved before the app
 * kept where rules came from reads "earlier". */
export function sourceLine(r: StyleRule, now: number): string {
  const where = origin(r)
  if (!where) return 'earlier'
  const edited = r.updatedAt ? ago(r.updatedAt, now) : null
  const when = edited ? `edited ${edited}` : ago(r.createdAt, now)
  return when ? `${where}, ${when}` : where
}

/** The open line's answer to "which note?": the note's own words and the version it made, or every file an
 * export was read from. Null when the short source line already says it all. MyStyle.tsx adds the exact time. */
export function sourceDetail(r: StyleRule): string | null {
  const files = filesOf(r)
  if (files.length > 1) return `Read from ${files.map((f) => `${f} (${editorOf(f)})`).join(', ')}`
  if (r.learned) return r.learned.evidence
  if (!r.source?.title) return null
  const where = `${r.source.version ? `Version ${r.source.version} of ` : ''}“${r.source.title}”`
  if (r.source.note) return `Your note “${r.source.note}” on ${where}`
  return r.source.version ? `From ${where}` : null
}
