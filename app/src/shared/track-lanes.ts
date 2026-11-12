// What the editing timeline (TrackTimeline.tsx) draws: the lanes of the timeline under the reel (lanes.ts), plus the
// subtitle lines and the song's in-point, for a draft that may be ahead of the version on screen. Everything is on that
// version's clock: words cut in the draft are drawn struck where they still play, and words brought back are counted at
// the edge they come back to, until the next version is made. No Node or DOM imports.
import type { CaptionToken, ProjectJson, VersionTimeline, Word } from './api'
import { keptIds } from './cut'
import { name } from './describe'
import { clipsOf, pictureParts, soundParts, videoParts, type Broll, type Lanes, type PicturePart } from './lanes'
import { joinsOf, musicFades, soundRows, type SoundEffect, type VersionClock } from './sfx'
import { subtitleLines, type LineToken } from './subtitle-lines'
import { usableWords, type Draft } from './timeline-edit'

type Captions = NonNullable<ProjectJson['captions']>

export interface CaptionPart {
  /** the line's first word id: the line's key */
  id: string
  t0: number
  t1: number
  text: string
  line: LineToken[]
}

export interface SongPart {
  name: string
  /** seconds into the song where the reel starts it */
  startAt: number
  fadeIn: number
  fadeOut: number
}

export interface TrackLanes extends Omit<Lanes, 'music'> {
  captions: CaptionPart[]
  music: SongPart | null
  /** stretches still heard on this clock that the draft cuts */
  struck: [number, number][]
  /** words the draft brings back, counted where they come back */
  back: { at: number; n: number }[]
}

export interface TrackInput {
  draft: Draft
  /** the version on screen: its clock, and its own project and render */
  version: VersionTimeline
  words: Word[]
  /** the newest render's subtitle lines (they are the version on screen while editing), and the captions it drew */
  captionLines: CaptionToken[][]
  savedCaptions: Captions | undefined
  heard: Map<string, string>
  pack: Map<string, Pick<SoundEffect, 'onsetMs' | 'seconds'>>
  why: (id: string) => string | null
  thumb: (b: Broll) => string | null
}

const GAP = 0.15

export function trackLanes(x: TrackInput): TrackLanes {
  const { draft, version: v, words } = x
  const placed = new Map<string, (typeof v.words)[number]>()
  for (const w of v.words) if (!placed.has(w.id)) placed.set(w.id, w)
  const onClock = new Set(keptIds(words, v.project.cut?.keep as { from: string; to: string }[] | undefined))
  const clock: VersionClock = { placed, segments: v.segments, words, kept: onClock }
  const joins = joinsOf(clock)
  const said = (id: string) => words.find((w) => w.id === id)?.w

  // the render's own picture times hold for the pictures unchanged since it; the rest are placed by its rules
  const before = new Map((v.project.broll ?? []).map((b) => [b.id, JSON.stringify(b)]))
  const layers = new Map(v.layers.flatMap((l) => (l.id && before.get(l.id) === JSON.stringify((draft.p.broll ?? []).find((b) => b.id === l.id)) ? [[l.id, l] as const] : [])))
  const pictures: PicturePart[] = pictureParts(draft.p.broll ?? [], { placed: v.words, segments: v.segments }, layers, v.duration, x.why, x.thumb)

  const captions: CaptionPart[] =
    draft.p.captions?.enabled === false
      ? []
      : subtitleLines(x.captionLines, draft.kept, x.savedCaptions, draft.p.captions, x.heard).flatMap((line) => {
          const a = placed.get(line[0].ids[0])
          const last = line[line.length - 1]
          const b = placed.get(last.ids[last.ids.length - 1])
          return a && b && b.e > a.s ? [{ id: line[0].ids[0], t0: a.s, t1: b.e, text: line.map((t) => t.shown).join(' '), line }] : []
        })

  const struck: [number, number][] = []
  for (const w of usableWords(v.words, onClock)) {
    if (draft.kept.has(w.id)) continue
    const last = struck[struck.length - 1]
    if (last && w.s - last[1] < GAP) last[1] = Math.max(last[1], w.e)
    else struck.push([w.s, w.e])
  }

  // a word brought back plays after the kept word before it in the take, or else before the one after it
  const counts = new Map<number, number>()
  words.forEach((w, i) => {
    if (!draft.kept.has(w.id) || onClock.has(w.id)) return
    let at: number | undefined
    for (let j = i - 1; j >= 0 && at === undefined; j--) if (onClock.has(words[j].id) && draft.kept.has(words[j].id)) at = placed.get(words[j].id)?.e
    for (let j = i + 1; j < words.length && at === undefined; j++) if (onClock.has(words[j].id) && draft.kept.has(words[j].id)) at = placed.get(words[j].id)?.s
    if (at !== undefined) counts.set(at, (counts.get(at) ?? 0) + 1)
  })

  const m = draft.p.music
  return {
    video: videoParts(v.segments, clipsOf(v.project.cut?.keep), v.words, joins.filter((j) => j.cut !== null).map((j) => j.t), v.project.sources ?? []),
    joins: joins.map(({ t, bridge }) => ({ t, bridge })),
    pictures,
    sounds: soundParts(soundRows(draft.p.sfx ?? [], clock, joins, draft.p.broll, draft.kept, said, x.pack)),
    captions,
    music: m?.enabled !== false && m?.track ? { name: name(m.track), startAt: m.startAt ?? 0, ...musicFades(m) } : null,
    struck,
    back: [...counts].map(([at, n]) => ({ at, n })).sort((a, b) => a.at - b.at)
  }
}
