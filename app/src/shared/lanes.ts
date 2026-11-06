// The lanes of the timeline under the reel, on one version's clock (seconds of its output):
// - Your video: the kept speech, and clips played whole from another video (multi-source), in the order they play;
// - Pictures: what the editor laid over it (project.broll), while each is on screen;
// - Sound: the sound effects and the song, by the Sound tab's own rules (shared/sfx.ts).
// The parts are worked out once per version or per change in Edit it myself; laneLayout turns them into pixels for
// one width.
import type { EditFact, PlacedWord, ProjectJson, Word } from './api'
import { withoutWordIds, type RenderSegment } from './moments'
import { clock } from './progress'
import { joinsOf, musicFades, sfxName, soundRows, type Join, type SoundEffect, type SoundRow, type VersionClock } from './sfx'

export type Broll = NonNullable<ProjectJson['broll']>[number]
/** A clip played whole from any video (multi-source; ai/src/project.ts ClipItem). */
export interface ClipItem {
  clip: string
  source: string
  in: number
  out: number
}
/** A b-roll item as the render placed it: render.json `layerItems`, written by the engine's broll.py build_layers. */
export interface LayerItem {
  id?: string
  t0?: number
  t1?: number
  skipped?: string
}

export interface VideoPart {
  kind: 'speech' | 'clip'
  t0: number
  t1: number
  /** its video's place in project.sources, from 1 */
  video: number
  /** the first words heard in it, or '' */
  said: string
}

export interface PicturePart {
  id: string
  t0: number
  t1: number
  /** what it is, as a person would say it: "Picture above your head", "Moving big quote" */
  what: string
  /** the words it goes with, or '' for one placed by source time */
  line: string
  /** why it is there, from the version that added it, or null when no version recorded it */
  why: string | null
  /** the render left it out, and why (layers.json `skipped`) */
  skipped: string | null
  /** what kind of thing it is, for the glyph drawn when there is no thumbnail */
  kind: PictureKind
  /** a small picture of it, or null for words, animations and files with no still */
  thumb: string | null
}

export type PictureKind = 'picture' | 'clip' | 'words' | 'animation' | 'wall'

/** One sound effect's flag: its moment key, its hit, its name and why it plays there; `off`: it won't play. */
export interface SoundPart {
  key: string
  at: number
  label: string
  off: boolean
  /** its kind in one word, written beside its flag when there is room: "Whoosh" */
  kind: string
}

/** The Sound tab's rows as flags: the ones with a moment in this version. */
export function soundParts(rows: SoundRow[]): SoundPart[] {
  return rows.flatMap((r) => (r.t === null ? [] : [{ key: r.key, at: r.t, label: `${r.title} · ${r.why}`, off: !!r.warn, kind: sfxName(r.s.sound).kind }]))
}

export interface Lanes {
  video: VideoPart[]
  pictures: PicturePart[]
  sounds: SoundPart[]
  /** the song's fade-in and fade-out in seconds, or null with no song */
  music: { fadeIn: number; fadeOut: number } | null
  /** the cuts: where one kept span meets the next. At a J or L join the voice crosses it (shared/sfx.ts `bridge`). */
  joins: Pick<Join, 't' | 'bridge'>[]
}

/** The clips in a cut. Word ranges have no `clip`; the app's ProjectJson types `keep` as word ranges only. */
export function clipsOf(keep: unknown): ClipItem[] {
  if (!Array.isArray(keep)) return []
  return keep.filter(
    (k): k is ClipItem => !!k && typeof k === 'object' && typeof k.clip === 'string' && typeof k.source === 'string' && typeof k.in === 'number' && typeof k.out === 'number'
  )
}

// The engine snaps a clip's ends to its video's frames (cut.py clip_span): within a frame at 20 fps or more.
const CLIP_SNAP = 0.06

/**
 * Your video, part by part. A clip is the segment the engine made of it. Speech is a kept range: the segments it
 * was trimmed into (pauses shortened) stay one part, and a new part starts at each cut (`cuts`, from joinsOf).
 */
export function videoParts(segments: RenderSegment[], clips: ClipItem[], placed: PlacedWord[], cuts: number[], sources: { id: string }[]): VideoPart[] {
  const parts: VideoPart[] = []
  const isCut = (t: number) => cuts.some((c) => Math.abs(c - t) < 1e-3)
  for (const seg of [...segments].sort((a, b) => a.out_start - b.out_start)) {
    const t0 = seg.out_start
    const t1 = seg.out_start + (seg.src_end - seg.src_start)
    if (t1 <= t0) continue
    const clip = clips.some((c) => c.source === seg.source && Math.abs(c.in - seg.src_start) <= CLIP_SNAP && Math.abs(c.out - seg.src_end) <= CLIP_SNAP)
    const video = Math.max(1, sources.findIndex((s) => s.id === seg.source) + 1)
    const last = parts[parts.length - 1]
    if (!clip && last?.kind === 'speech' && last.video === video && !isCut(t0)) last.t1 = t1
    else parts.push({ kind: clip ? 'clip' : 'speech', t0, t1, video, said: '' })
  }
  for (const p of parts) {
    const heard = placed.filter((w) => w.s >= p.t0 - 1e-3 && w.s < p.t1)
    p.said = heard.slice(0, 6).map((w) => w.w).join(' ') + (heard.length > 6 ? '…' : '')
  }
  return parts
}

// The engine's own numbers for when a picture shows (engine/reelengine/broll.py plan_windows): it comes in LEAD
// before its first word, stays at least the hold, leaves just after its last word, and hands off to the next one.
const LEAD = 0.13
const STILL_HOLD = 2
const VIDEO_HOLD = 0.6
const TAIL = 0.05
const ANIM_TAIL = 0.35
const MIN_GAP = 0.22
const MIN_WINDOW = 0.05

const PLACES: Record<string, string> = {
  'card-above-head': 'above your head',
  'full-frame': 'filling the screen',
  'phone-card': 'in a phone',
  'side-card': 'beside you',
  'split-top': 'on the top half'
}

/** "anim-big-quote-2.mov" (or "n1a2b3c4d-anim-..." from a note) -> "Moving big quote"; never a file name. */
export function animationName(asset: string): string | null {
  const m = /(?:^|[/])(?:n[0-9a-f]{8}-)?anim-([a-z0-9-]+?)(?:-\d+)?\.(?:mov|webm|mp4)$/i.exec(asset)
  return m ? `Moving ${m[1].replace(/-/g, ' ')}` : null
}

/** What kind of thing a b-roll item is. */
export function pictureKind(b: Broll): PictureKind {
  const asset = typeof b.asset === 'string' ? b.asset : ''
  if (b.treatment === 'animation' || animationName(asset)) return 'animation'
  if ((b.treatment === 'text-pop' || b.treatment === 'text-behind') && !asset) return 'words'
  if (b.treatment === 'post-wall' || b.treatment === 'icon-wall') return 'wall'
  return isVideoFile(asset) ? 'clip' : 'picture'
}

const isVideoFile = (a: string): boolean => /\.(mp4|mov|m4v|webm|mkv)$/i.test(a) && !/^work\/assets\/attach-.*\.gif/i.test(a)

/** What a b-roll item is, as a person would name it, never by its file. */
export function pictureWhat(b: Broll): string {
  const asset = typeof b.asset === 'string' ? b.asset : ''
  const text = typeof b.params?.text === 'string' && b.params.text ? b.params.text : ''
  const anim = animationName(asset)
  if (anim) return anim
  if (b.treatment === 'animation') return 'Animation'
  if (b.treatment === 'text-pop') return text ? `Words on screen: “${text}”` : 'Words on screen'
  if (b.treatment === 'text-behind') return text ? `Words behind you: “${text}”` : 'Words behind you'
  if (b.treatment === 'post-wall') return 'Wall of pictures'
  if (b.treatment === 'icon-wall') return 'Wall of icons'
  const place = PLACES[b.treatment]
  return [isVideoFile(asset) ? 'Clip' : 'Picture', place].filter(Boolean).join(' ')
}

/** The output time a source moment plays at first, as the engine maps it (cut.py src_to_out), or null if cut. */
function sourceToOut(segments: RenderSegment[], source: string, t: number): number | null {
  const seg = segments.find((s) => s.source === source && s.src_start - 1e-6 <= t && t <= s.src_end + 1e-6)
  return seg ? seg.out_start + (t - seg.src_start) : null
}

/** The words from `from` through `to` where they first play, cut short after six. */
function lineOf(placed: PlacedWord[], from: string, to: string): string {
  const i = placed.findIndex((w) => w.id === from)
  if (i < 0) return ''
  const j = placed.findIndex((w, k) => k >= i && w.id === to)
  const words = placed.slice(i, (j < 0 ? i : j) + 1).map((w) => w.w)
  return words.length > 6 ? `${words.slice(0, 6).join(' ')}…` : words.join(' ')
}

/**
 * When each b-roll item is on screen. `layers` are the render's own times, used for the items they hold (in Edit
 * it myself, only the items unchanged since that render). The rest are placed from their anchors by the engine's
 * rules. Two never overlap: like the engine, an item hands off to the next at its start.
 */
export function pictureParts(
  broll: Broll[],
  c: { placed: PlacedWord[]; segments: RenderSegment[] },
  layers: Map<string, LayerItem>,
  duration: number,
  why: (id: string) => string | null = () => null,
  thumb: (b: Broll) => string | null = () => null
): PicturePart[] {
  const first = new Map<string, PlacedWord>()
  for (const w of c.placed) if (!first.has(w.id)) first.set(w.id, w)
  const rows: (PicturePart & { order: number; rendered: boolean })[] = []
  broll.forEach((b, order) => {
    const anchor = b.anchor as Broll['anchor'] | { source: string; s: number; e: number }
    const base = { id: b.id, what: pictureWhat(b), line: 'source' in anchor ? '' : lineOf(c.placed, anchor.from, anchor.to), why: why(b.id), kind: pictureKind(b), thumb: thumb(b), order }
    const layer = layers.get(b.id)
    if (layer && typeof layer.t0 === 'number' && typeof layer.t1 === 'number' && !layer.skipped) {
      rows.push({ ...base, t0: layer.t0, t1: layer.t1, skipped: null, rendered: true })
      return
    }
    let s: number | null
    let e: number | null
    if ('source' in anchor) {
      s = sourceToOut(c.segments, anchor.source, anchor.s)
      e = sourceToOut(c.segments, anchor.source, anchor.e)
      if (s !== null && e !== null && e <= s) s = e = null
    } else {
      s = first.get(anchor.from)?.s ?? null
      e = first.get(anchor.to)?.e ?? null
    }
    if (s === null || e === null) return
    const asset = typeof b.asset === 'string' ? b.asset : ''
    const anim = b.treatment === 'animation' || !!animationName(asset)
    const hold = typeof b.params?.hold === 'number' ? b.params.hold : null
    const leadIn = b.leadIn ?? LEAD
    const t0 = Math.max(0, s - leadIn)
    const t1 = Math.max(e + (anim && hold === null ? ANIM_TAIL : TAIL), t0 + (hold ?? (!anim && isVideoFile(asset) ? VIDEO_HOLD : STILL_HOLD)))
    rows.push({ ...base, t0, t1, skipped: layer?.skipped ?? null, rendered: false })
  })
  rows.sort((a, b) => a.t0 - b.t0 || a.order - b.order)
  rows.forEach((p, k) => {
    const next = rows[k + 1]
    // the render already handed off its own items; one placed here hands off as the engine would
    if (next && (!p.rendered || !next.rendered) && (p.t1 > next.t0 || next.t0 - p.t1 < MIN_GAP)) p.t1 = next.t0
    if (duration > 0) p.t1 = Math.min(p.t1, duration)
  })
  return rows.filter((p) => p.t1 - p.t0 > MIN_WINDOW).map(({ order: _o, rendered: _r, ...p }) => p)
}

/**
 * Why a picture is in version `upTo`: the newest version up to it that added it, and that version's note. null
 * when no version's receipt records it (made before receipts existed).
 */
export function pictureWhy(
  id: string,
  versions: { n: number; facts?: EditFact[] }[],
  notes: { version?: number; text: string }[],
  upTo: number
): string | null {
  const added = versions
    .filter((v) => v.n <= upTo && v.facts?.some((f) => f.kind === 'broll' && f.id === id && f.before == null && f.after != null))
    .pop()
  if (!added) return null
  if (added.n === 1) return 'Added when Version 1 was made'
  // project.json keeps the note as the AI read it, moment and word ids included
  const raw = notes.find((x) => x.version === added.n)?.text
  const note = raw === undefined ? undefined : withoutWordIds(raw).trim()
  const short = note && note.length > 60 ? `${note.slice(0, 58).trimEnd()}…` : note
  return short ? `Added for “${short}”, Version ${added.n}` : `Added in Version ${added.n}`
}

/** Everything the timeline draws for one version: its video, its pictures and its sounds. */
export function lanesOf(
  p: Pick<ProjectJson, 'broll' | 'sfx' | 'music' | 'cut' | 'sources'>,
  v: { placed: PlacedWord[]; segments: RenderSegment[]; words: Word[]; kept: Set<string>; duration: number; layers: Map<string, LayerItem> },
  pack: Map<string, Pick<SoundEffect, 'onsetMs' | 'seconds'>>,
  why: (id: string) => string | null = () => null,
  thumb: (b: Broll) => string | null = () => null
): Lanes {
  const vclock: VersionClock = { placed: new Map(v.placed.map((w) => [w.id, w])), segments: v.segments, words: v.words, kept: v.kept }
  const joins = joinsOf(vclock)
  const said = (id: string) => v.words.find((w) => w.id === id)?.w
  const rows = soundRows(p.sfx ?? [], vclock, joins, p.broll, v.kept, said, pack)
  return {
    video: videoParts(v.segments, clipsOf(p.cut?.keep), v.placed, joins.filter((j) => j.cut !== null).map((j) => j.t), p.sources ?? []),
    pictures: pictureParts(p.broll ?? [], v, v.layers, v.duration, why, thumb),
    sounds: soundParts(rows),
    music: p.music?.enabled !== false && p.music?.track ? musicFades(p.music) : null,
    joins: joins.map(({ t, bridge }) => ({ t, bridge }))
  }
}

/** What a screen reader hears on a part of your video. */
export function videoLabel(p: VideoPart, videos: number): string {
  const when = `${clock(p.t0)} to ${clock(p.t1)}`
  if (p.kind === 'clip') return `Video ${p.video}, played whole, ${when}`
  const whose = videos > 1 ? `Your video ${p.video}` : 'Your video'
  return p.said ? `${whose}, ${when}: “${p.said}”` : `${whose}, ${when}`
}

/** What a screen reader hears on a picture: what, when, the words it goes with, and why it is there. */
export function pictureLabel(p: PicturePart): string {
  return [
    `${p.what}, ${clock(p.t0)} to ${clock(p.t1)}`,
    p.line && `for the line “${p.line}”`,
    p.why,
    p.skipped && `left out of the video: ${p.skipped}`
  ]
    .filter(Boolean)
    .join(', ')
}

// A bar narrower than this is drawn this wide, so a short picture on a long reel still shows.
const MIN_BAR = 3
// Back-to-back pictures keep this much paper between them, so each can be counted.
const BAR_GAP = 2
// Each picture's pointer target is at least this wide where its neighbours leave room (WCAG 2.5.8).
const TARGET = 24
// A bar this wide or wider starts with the picture's 16 px thumbnail; the rest of its length, past 4 px of paper,
// stays a bar. A narrower one is the bar alone.
export const THUMB_MIN = 20

export interface Bar {
  /** the bar as drawn */
  x: number
  w: number
  /** the pointer target: never overlaps a neighbour's */
  hitX: number
  hitW: number
  /** wide enough to start with its thumbnail */
  thumb: boolean
}

/**
 * Pixels for parts sorted by start, on a track `width` wide. Each bar keeps its time's position; one too short to
 * see is widened to MIN_BAR, and one that runs into the next stops BAR_GAP before it. Targets grow to TARGET
 * around their bar and meet their neighbours halfway, so every part keeps a target of its own.
 */
export function laneLayout(parts: { t0: number; t1: number }[], duration: number, width: number): Bar[] {
  if (!duration || !width) return []
  const px = (t: number) => (Math.min(Math.max(t, 0), duration) / duration) * width
  const bars = parts.map((p, i) => {
    const x = px(p.t0)
    const next = parts[i + 1]
    const stop = next ? px(next.t0) - BAR_GAP : width
    return { x, w: Math.max(MIN_BAR, Math.min(px(p.t1), stop) - x) }
  })
  const centre = (b: { x: number; w: number }) => b.x + b.w / 2
  return bars.map((b, i) => {
    const prev = bars[i - 1]
    const next = bars[i + 1]
    let left = Math.min(b.x, centre(b) - TARGET / 2)
    let right = Math.max(b.x + b.w, centre(b) + TARGET / 2)
    // the edge between two targets: the middle of the gap between their bars, or of their centres when they touch
    if (prev) left = Math.max(left, prev.x + prev.w <= b.x ? (prev.x + prev.w + b.x) / 2 : (centre(prev) + centre(b)) / 2)
    if (next) right = Math.min(right, b.x + b.w <= next.x ? (b.x + b.w + next.x) / 2 : (centre(b) + centre(next)) / 2)
    left = Math.max(0, left)
    right = Math.min(width, right)
    return { ...b, hitX: left, hitW: Math.max(0, right - left), thumb: b.w >= THUMB_MIN }
  })
}
