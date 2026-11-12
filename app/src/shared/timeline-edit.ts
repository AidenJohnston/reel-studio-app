// What a drag on the timeline (TrackTimeline.tsx) does to the project. Every gesture lands on word ids, never on
// seconds: a cut's edge on a word's start or end, a picture's anchor on the words it covers. So a gesture is a
// structured change the AI could have made with the same tools (set_cut, update_broll, remove_broll, choose_music,
// caption corrections), and the same project always renders the same video. No Node or DOM imports.
import type { PlacedWord, ProjectJson, Word } from './api'
import { applyHandEdit, diffProject, isEmpty, type HandEdit } from './hand-edit'
import { animationName } from './lanes'
import { retype, type LineToken } from './subtitle-lines'

export type Broll = NonNullable<ProjectJson['broll']>[number]
type Correction = NonNullable<NonNullable<ProjectJson['captions']>['corrections']>[number]

/** A gesture, ready to send: the change, and what the person did in their words (said after "You" in the notes). */
export interface Gesture {
  edit: HandEdit
  summary: string
}

const EPS = 1e-3
// Words brought back past a cut's edge in one drag, at most: further than this is picking a different take.
const MAX_BACK = 40

/** A project and the words it keeps: in Edit it myself the words cut there are kept apart from `p.cut` until made. */
export interface Draft {
  p: ProjectJson
  kept: Set<string>
}

/** The draft with each waiting edit on top, oldest first. Applying an edit that already landed changes nothing. */
export function withEdits(d: Draft, edits: HandEdit[], words: Word[]): Draft {
  const known = new Set(words.map((w) => w.id))
  return edits.reduce((x, e) => {
    const kept = new Set(x.kept)
    for (const id of e.words.cut) kept.delete(id)
    for (const id of e.words.keep) if (known.has(id)) kept.add(id)
    return { p: applyHandEdit(x.p, e, words), kept }
  }, d)
}

/** The words on the clock that are still kept, first time each is heard, in the order they play. */
export function usableWords(placed: PlacedWord[], kept: Set<string>): PlacedWord[] {
  const seen = new Set<string>()
  return placed.filter((w) => kept.has(w.id) && !seen.has(w.id) && !!seen.add(w.id))
}

/** Where a cut's edge can go: on the clock (`at`), and the words cutting or bringing it back there takes. */
export interface TrimStop {
  at: number
  cut: string[]
  keep: string[]
}

/**
 * The stops for one edge of a kept part of the video, sorted by time. Inward, the edge stops at each kept word's end
 * (or start, for the part's start), keeping at least one word. Outward, it stops after each word cut next to it in
 * the same take, spaced by how long those words took when filmed.
 */
export function trimStops(part: { t0: number; t1: number }, side: 'start' | 'end', placed: PlacedWord[], words: Word[], kept: Set<string>): TrimStop[] {
  const inside = usableWords(placed, kept).filter((w) => w.s >= part.t0 - EPS && w.s < part.t1)
  if (!inside.length) return []
  const index = new Map(words.map((w, i) => [w.id, i]))
  const stops: TrimStop[] = []
  if (side === 'end') {
    const last = inside[inside.length - 1]
    inside.forEach((w, k) => stops.push({ at: k === inside.length - 1 ? part.t1 : w.e, cut: inside.slice(k + 1).map((x) => x.id), keep: [] }))
    const i = index.get(last.id)!
    const back: string[] = []
    for (let j = i + 1; j < words.length && back.length < MAX_BACK && !kept.has(words[j].id) && words[j].source === words[i].source; j++) {
      back.push(words[j].id)
      stops.push({ at: part.t1 + (words[j].e - words[i].e), cut: [], keep: [...back] })
    }
  } else {
    const first = inside[0]
    inside.forEach((w, k) => stops.push({ at: k === 0 ? part.t0 : w.s, cut: inside.slice(0, k).map((x) => x.id), keep: [] }))
    const i = index.get(first.id)!
    const back: string[] = []
    for (let j = i - 1; j >= 0 && back.length < MAX_BACK && !kept.has(words[j].id) && words[j].source === words[i].source; j--) {
      back.unshift(words[j].id)
      stops.push({ at: part.t0 - (words[i].s - words[j].s), cut: [], keep: [...back] })
    }
  }
  return stops.sort((a, b) => a.at - b.at)
}

/** The stop nearest `t`. */
export function nearestStop(stops: TrimStop[], t: number): TrimStop | null {
  let best: TrimStop | null = null
  for (const s of stops) if (!best || Math.abs(s.at - t) < Math.abs(best.at - t)) best = s
  return best
}

const plural = (n: number, one: string): string => (n === 1 ? `a ${one}` : `${n} ${one}s`)

/** A cut's edge moved to `stop`: those words cut, or brought back. null when the edge did not move. */
export function trimGesture(stop: TrimStop, said: (id: string) => string): Gesture | null {
  if (!stop.cut.length && !stop.keep.length) return null
  const edit: HandEdit = { set: [], items: [], words: { cut: stop.cut, keep: stop.keep }, mirror: [], joins: [] }
  const ids = stop.cut.length ? stop.cut : stop.keep
  const quote = ids.length <= 4 ? ` (“${ids.map(said).join(' ')}”)` : ''
  return { edit, summary: stop.cut.length ? `trimmed ${plural(ids.length, 'word')} off a cut${quote}` : `brought back ${plural(ids.length, 'word')} at a cut${quote}` }
}

/** How a picture's words can be dragged. */
export type BrollDrag = 'move' | 'start' | 'end'

/**
 * Whether a picture can be dragged on the timeline, or why not. An animation is made for its words (the AI makes
 * it again to re-time it), and a clip placed by its video's own time has no words to move along.
 */
export function brollFixed(b: Broll): string | null {
  if ('source' in (b.anchor as object)) return 'This one is placed by the time in your video. Ask your editor to move it.'
  if (b.treatment === 'animation' || animationName(typeof b.asset === 'string' ? b.asset : '')) return 'An animation is made for its words. Ask your editor to re-time it.'
  return null
}

/**
 * The anchor after a drag that put the picture's first word (`move`, `start`) or last word (`end`) nearest `t`.
 * A move keeps how many words it covers; a resize keeps at least one. null when the anchor's words aren't on the
 * clock (cut since the render).
 */
export function draggedAnchor(b: Broll, usable: PlacedWord[], how: BrollDrag, t: number): Broll['anchor'] | null {
  const i0 = usable.findIndex((w) => w.id === b.anchor.from)
  const i1 = usable.findIndex((w) => w.id === b.anchor.to)
  if (i0 < 0 || i1 < i0) return null
  const nearest = (lo: number, hi: number, at: (w: PlacedWord) => number): number => {
    let k = lo
    for (let j = lo; j <= hi; j++) if (Math.abs(at(usable[j]) - t) < Math.abs(at(usable[k]) - t)) k = j
    return k
  }
  if (how === 'move') {
    const a = nearest(0, usable.length - 1 - (i1 - i0), (w) => w.s)
    return { from: usable[a].id, to: usable[a + i1 - i0].id }
  }
  if (how === 'start') return { from: usable[nearest(0, i1, (w) => w.s)].id, to: b.anchor.to }
  return { from: b.anchor.from, to: usable[nearest(i0, usable.length - 1, (w) => w.e)].id }
}

const lineOf = (usable: PlacedWord[], a: Broll['anchor']): string => {
  const i = usable.findIndex((w) => w.id === a.from)
  const j = usable.findIndex((w) => w.id === a.to)
  const words = usable.slice(i, j + 1).map((w) => w.w)
  return words.length > 5 ? `${words.slice(0, 5).join(' ')}…` : words.join(' ')
}

/** The change one picture's drag, framing or removal makes, as update_broll or remove_broll would. */
export function brollGesture(p: ProjectJson, kept: Set<string>, id: string, next: Broll | null, usable: PlacedWord[]): Gesture | null {
  const before = (p.broll ?? []).find((b) => b.id === id)
  if (!before) return null
  const broll = (p.broll ?? []).flatMap((b) => (b.id !== id ? [b] : next ? [next] : []))
  const edit = diffProject(p, { ...p, broll }, kept, kept)
  if (isEmpty(edit)) return null
  if (!next) return { edit, summary: `removed the picture on “${lineOf(usable, before.anchor)}”` }
  const span = (a: Broll['anchor']) => usable.findIndex((w) => w.id === a.to) - usable.findIndex((w) => w.id === a.from)
  const on = `on “${lineOf(usable, next.anchor)}”`
  const summary =
    next.asset !== before.asset
      ? `swapped the picture ${on}`
      : JSON.stringify(next.anchor) === JSON.stringify(before.anchor)
        ? `framed the picture ${on} again`
        : span(next.anchor) === span(before.anchor)
          ? `moved a picture to “${lineOf(usable, next.anchor)}”`
          : `made a picture ${span(next.anchor) > span(before.anchor) ? 'longer' : 'shorter'}, ${on}`
  return { edit, summary }
}

/**
 * How a picture is framed, for the box drawn on the preview: a full-screen or top-half picture is cropped to fill
 * its place and pans (params focusX, focusY, 0 to 1); a card keeps its place by your face and grows or shrinks
 * (params scale, 1 = its usual size).
 */
export function framingOf(b: Broll): { pan: 'xy' | 'y' | null; scale: boolean } {
  if (b.treatment === 'full-frame' || b.treatment === 'split-top') return { pan: 'xy', scale: false }
  if (b.treatment === 'phone-card') return { pan: 'y', scale: true }
  if (b.treatment === 'card-above-head' || b.treatment === 'side-card') return { pan: null, scale: true }
  return { pan: null, scale: false }
}

// The engine's own defaults for these (broll.py TREATMENT_DEFAULTS).
const FOCUS_DEFAULT: Record<string, { x: number; y: number }> = { 'phone-card': { x: 0.5, y: 0 } }
export const SCALE_MIN = 0.5
export const SCALE_MAX = 1.6
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const round2 = (v: number): number => Math.round(v * 100) / 100

export function focusOf(b: Broll): { x: number; y: number; scale: number } {
  const d = FOCUS_DEFAULT[b.treatment] ?? { x: 0.5, y: 0.5 }
  const n = (k: string, v: number): number => (typeof b.params?.[k] === 'number' ? (b.params[k] as number) : v)
  return { x: n('focusX', d.x), y: n('focusY', d.y), scale: n('scale', 1) }
}

/** The picture framed again: a pan by a share of the frame (dragging right shows more of its left), or a new size. */
export function framed(b: Broll, change: { dx?: number; dy?: number; scale?: number }): Broll {
  const f = framingOf(b)
  const now = focusOf(b)
  const params = { ...(b.params ?? {}) }
  if (f.pan === 'xy' && change.dx) params.focusX = round2(clamp(now.x - change.dx, 0, 1))
  if (f.pan && change.dy) params.focusY = round2(clamp(now.y - change.dy, 0, 1))
  if (f.scale && change.scale !== undefined) params.scale = round2(clamp(change.scale, SCALE_MIN, SCALE_MAX))
  return { ...b, params }
}

/** The song started `startAt` seconds in, as choose_music's startAt. */
export function songGesture(p: ProjectJson, kept: Set<string>, startAt: number): Gesture | null {
  if (!p.music?.track) return null
  const at = Math.round(Math.max(0, startAt) * 10) / 10
  const edit = diffProject(p, { ...p, music: { ...p.music, startAt: at } }, kept, kept)
  if (isEmpty(edit)) return null
  return { edit, summary: at === 0 ? 'started the song from its beginning' : `started the song ${Number(at.toFixed(1))} s in` }
}

/** A subtitle line typed over: its words fixed as the Subtitles list fixes them (shared/subtitle-lines.ts retype). */
export function captionGesture(p: ProjectJson, kept: Set<string>, line: LineToken[], saved: Correction[], typed: string, heard: Map<string, string>): Gesture | null {
  const captions = p.captions ?? { enabled: true }
  const corrections = retype(line, captions.corrections ?? [], saved, typed, heard)
  const edit = diffProject(p, { ...p, captions: { ...captions, corrections } }, kept, kept)
  if (isEmpty(edit)) return null
  const text = typed.trim()
  return { edit, summary: text ? `fixed a subtitle to “${text.length > 40 ? `${text.slice(0, 38).trimEnd()}…` : text}”` : 'took a subtitle line off' }
}

/** Where the playhead goes for one word back (`dir` -1) or on (1): the start of the word before or after `t`. */
export function wordStep(usable: PlacedWord[], t: number, dir: 1 | -1): number | null {
  if (dir === 1) return usable.find((w) => w.s > t + EPS)?.s ?? null
  for (let k = usable.length - 1; k >= 0; k--) if (usable[k].s < t - EPS) return usable[k].s
  return null
}
