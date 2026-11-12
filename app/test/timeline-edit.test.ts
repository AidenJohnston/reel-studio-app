// What a drag on the editing timeline does to the project (shared/timeline-edit.ts) and what the timeline draws for a
// draft ahead of the version on screen (shared/track-lanes.ts). Every gesture lands on word ids, so each case has one
// right answer, and the same gesture on the same project always gives the same project.
import { describe, expect, it } from 'vitest'
import type { ProjectJson, VersionTimeline, Word } from '../src/shared/api'
import { keptIds } from '../src/shared/cut'
import { applyHandEdit, countChanges } from '../src/shared/hand-edit'
import { placeWords, type RenderSegment } from '../src/shared/moments'
import { readCaptionLines } from '../src/shared/subtitle-lines'
import {
  brollFixed,
  brollGesture,
  captionGesture,
  draggedAnchor,
  framed,
  nearestStop,
  songGesture,
  trimGesture,
  trimStops,
  usableWords,
  withEdits,
  wordStep,
  type Broll
} from '../src/shared/timeline-edit'
import { trackLanes } from '../src/shared/track-lanes'

// One take (s1), a word every 0.5 s. The cut keeps w0-w3 and w6-w9: "um uh" (w4, w5) is cut between them.
const said = ['so', 'flour', 'water', 'salt', 'um', 'uh', 'then', 'fold', 'it', 'twice']
const words: Word[] = said.map((w, i) => ({ id: `w${i}`, w, s: i * 0.5, e: i * 0.5 + 0.3, source: 's1' }))
const segments: RenderSegment[] = [
  { source: 's1', src_start: 0, src_end: 1.85, out_start: 0 },
  { source: 's1', src_start: 2.95, src_end: 4.85, out_start: 1.85 }
]
const placed = placeWords(segments, words)
const parts = [
  { t0: 0, t1: 1.85 },
  { t0: 1.85, t1: 3.75 }
]
const pic = (id: string, from: string, to: string, extra: Partial<Broll> = {}): Broll => ({ id, anchor: { from, to }, treatment: 'card-above-head', asset: 'Library/Images/cup.png', ...extra })
function project(extra: Partial<ProjectJson> = {}): ProjectJson {
  return {
    schemaVersion: 1, id: 'p', title: 't', slug: 't', createdAt: '', updatedAt: '', version: 1,
    sources: [{ id: 's1', path: 'raw.mov' }],
    cut: { keep: [{ from: 'w0', to: 'w3' }, { from: 'w6', to: 'w9' }] },
    captions: { enabled: true },
    music: { enabled: true, track: 'Library/Music/happy song.mp3', startAt: 0 },
    broll: [pic('b1', 'w1', 'w2')],
    ...extra
  }
}
const keptOf = (p: ProjectJson) => new Set(keptIds(words, p.cut?.keep))
const word = (id: string) => said[Number(id.slice(1))]
const round = (n: number) => Math.round(n * 1000) / 1000

describe('trimming a cut', () => {
  const p = project()
  const kept = keptOf(p)

  it('fails if a cut edge stops anywhere but on a word, or crosses into the kept words past the cut', () => {
    // the end of the first part: inward on the end of each kept word, outward over "um" and "uh", never onto "then"
    const stops = trimStops(parts[0], 'end', placed, words, kept)
    expect(stops.map((s) => [round(s.at), s.cut, s.keep])).toEqual([
      [round(placed[0].e), ['w1', 'w2', 'w3'], []],
      [round(placed[1].e), ['w2', 'w3'], []],
      [round(placed[2].e), ['w3'], []],
      [1.85, [], []],
      [round(1.85 + 0.5), [], ['w4']],
      [round(1.85 + 1), [], ['w4', 'w5']]
    ])
    // the start of the second part brings them back from the other side
    const back = trimStops(parts[1], 'start', placed, words, kept)
    expect(back.slice(0, 3).map((s) => [round(s.at), s.keep])).toEqual([
      [round(1.85 - 1), ['w4', 'w5']],
      [round(1.85 - 0.5), ['w5']],
      [1.85, []]
    ])
  })

  it('fails if a trim is not one change to the cut, or the same trim gives another project', () => {
    const stop = nearestStop(trimStops(parts[0], 'end', placed, words, kept), 1.2)!
    const g = trimGesture(stop, word)!
    expect(g.summary).toBe('trimmed a word off a cut (“salt”)')
    expect(countChanges(g.edit, words)).toBe(1)
    const once = applyHandEdit(p, g.edit, words)
    expect(once.cut?.keep).toEqual([{ from: 'w0', to: 'w2' }, { from: 'w6', to: 'w9' }])
    expect(applyHandEdit(once, g.edit, words)).toEqual(once)
    // dragged back to where it was: no change at all
    expect(trimGesture(nearestStop(trimStops(parts[0], 'end', placed, words, kept), 1.86)!, word)).toBeNull()
  })

  it('fails if bringing back the words at a cut does not join the two parts into one range', () => {
    const stop = nearestStop(trimStops(parts[0], 'end', placed, words, kept), 3)!
    const g = trimGesture(stop, word)!
    expect(g.summary).toBe('brought back 2 words at a cut (“um uh”)')
    expect(applyHandEdit(p, g.edit, words).cut?.keep).toEqual([{ from: 'w0', to: 'w9' }])
  })

  it('fails if a cut edge brings back words from another take', () => {
    const two = words.map((w, i) => (i >= 4 ? { ...w, source: 's2' } : w))
    expect(trimStops(parts[0], 'end', placeWords(segments, two), two, kept).every((s) => !s.keep.length)).toBe(true)
  })
})

describe('dragging a picture', () => {
  const usable = usableWords(placed, keptOf(project()))
  const b = pic('b1', 'w1', 'w2')

  it('fails if a moved picture does not keep its number of words, or runs off the end of the reel', () => {
    expect(draggedAnchor(b, usable, 'move', placed.find((w) => w.id === 'w7')!.s + 0.05)).toEqual({ from: 'w7', to: 'w8' })
    expect(draggedAnchor(b, usable, 'move', 99)).toEqual({ from: 'w8', to: 'w9' })
    expect(draggedAnchor(b, usable, 'move', -5)).toEqual({ from: 'w0', to: 'w1' })
  })

  it('fails if resizing a picture moves its other end, or leaves it on no words', () => {
    expect(draggedAnchor(b, usable, 'end', 99)).toEqual({ from: 'w1', to: 'w9' })
    expect(draggedAnchor(b, usable, 'end', 0)).toEqual({ from: 'w1', to: 'w1' })
    expect(draggedAnchor(b, usable, 'start', 0)).toEqual({ from: 'w0', to: 'w2' })
    expect(draggedAnchor(b, usable, 'start', 99)).toEqual({ from: 'w2', to: 'w2' })
  })

  it('fails if a drag is not the one change update_broll or remove_broll would make', () => {
    const p = project()
    const kept = keptOf(p)
    const moved = brollGesture(p, kept, 'b1', { ...b, anchor: { from: 'w7', to: 'w8' } }, usable)!
    expect(moved.edit.items).toEqual([{ list: 'broll', key: 'b1', item: { ...b, anchor: { from: 'w7', to: 'w8' } } }])
    expect(moved.summary).toBe('moved a picture to “fold it”')
    expect(brollGesture(p, kept, 'b1', { ...b, anchor: { from: 'w1', to: 'w3' } }, usable)!.summary).toBe('made a picture longer, on “flour water salt”')
    const gone = brollGesture(p, kept, 'b1', null, usable)!
    expect(gone.edit.items).toEqual([{ list: 'broll', key: 'b1', item: null }])
    expect(applyHandEdit(p, gone.edit, words).broll).toBeUndefined()
    expect(brollGesture(p, kept, 'b1', b, usable)).toBeNull()
  })

  it('fails if an animation or a clip placed by its video time can be dragged off its words', () => {
    expect(brollFixed(b)).toBeNull()
    expect(brollFixed(pic('a', 'w1', 'w2', { treatment: 'animation', asset: 'work/assets/anim-big-quote.mov' }))).toMatch(/animation/)
    expect(brollFixed({ ...b, anchor: { source: 's1', s: 1, e: 2 } as never })).toMatch(/time in your video/)
  })

  it('fails if framing a picture leaves its frame, or pans one that only grows', () => {
    const full = pic('f', 'w1', 'w2', { treatment: 'full-frame' })
    expect(framed(full, { dx: 0.2, dy: -0.1 }).params).toEqual({ focusX: 0.3, focusY: 0.6 })
    expect(framed(full, { dx: -2 }).params).toEqual({ focusX: 1 })
    expect(framed(b, { dx: 0.3, scale: 3 }).params).toEqual({ scale: 1.6 })
    expect(framed(pic('p', 'w1', 'w2', { treatment: 'phone-card' }), { dx: 0.3, dy: -0.25 }).params).toEqual({ focusY: 0.25 })
  })
})

describe('the song and the subtitles', () => {
  it('fails if the song in-point is not choose_music startAt, to a tenth of a second and never before the song', () => {
    const p = project()
    const g = songGesture(p, keptOf(p), 4.26)!
    expect(g.edit.set).toEqual([{ path: ['music', 'startAt'], value: 4.3 }])
    expect(g.summary).toBe('started the song 4.3 s in')
    expect(songGesture(p, keptOf(p), -3)).toBeNull()
    expect(songGesture(project({ music: { enabled: false, track: null } }), keptOf(p), 2)).toBeNull()
  })

  it('fails if a subtitle typed over is not the Subtitles list’s own fix on its words', () => {
    const p = project()
    const [line] = readCaptionLines({ cues: [{ run: 0, tokens: [{ w: 'so', ids: ['w0'] }, { w: 'flour', ids: ['w1'] }] }] }).map((l) => l.map((t) => ({ ...t, shown: t.w })))
    const heard = new Map(words.map((w) => [w.id, w.w]))
    const g = captionGesture(p, keptOf(p), line, [], 'so flower', heard)!
    expect(applyHandEdit(p, g.edit, words).captions?.corrections).toEqual([{ from: 'flour', to: 'flower', at: 'w1' }])
    expect(captionGesture(p, keptOf(p), line, [], ' so flour ', heard)).toBeNull()
  })
})

describe('the draft the timeline draws', () => {
  it('fails if an edit that already landed changes the draft again, or a waiting cut is lost', () => {
    const p = project()
    const trim = trimGesture(nearestStop(trimStops(parts[0], 'end', placed, words, keptOf(p)), 1.2)!, word)!
    const once = withEdits({ p, kept: keptOf(p) }, [trim.edit], words)
    expect(once.kept.has('w3')).toBe(false)
    expect(withEdits(once, [trim.edit], words)).toEqual(once)
  })

  it('fails if the arrows skip a word or stop between words', () => {
    const usable = usableWords(placed, keptOf(project()))
    expect(wordStep(usable, 0, 1)).toBe(usable[1].s)
    expect(wordStep(usable, usable[2].s, -1)).toBe(usable[1].s)
    expect(wordStep(usable, usable[usable.length - 1].s, 1)).toBeNull()
  })

  it('fails if cut words still look kept, words brought back are not counted, or a subtitle line is off its words', () => {
    const p = project()
    const version: VersionTimeline = { duration: 3.75, words: placed, segments, project: p, layers: [] }
    const draft = { p, kept: new Set([...keptOf(p)].filter((id) => id !== 'w8').concat('w4')) }
    const captionLines = readCaptionLines({ cues: [{ run: 0, tokens: [{ w: 'then', ids: ['w6'] }, { w: 'fold', ids: ['w7'] }] }] })
    const lanes = trackLanes({ draft, version, words, captionLines, savedCaptions: p.captions, heard: new Map(words.map((w) => [w.id, w.w])), pack: new Map(), why: () => null, thumb: () => null })
    const w8 = placed.find((w) => w.id === 'w8')!
    expect(lanes.struck).toEqual([[w8.s, w8.e]])
    // "um" comes back after "salt", where the first part ends
    expect(lanes.back).toEqual([{ at: placed.find((w) => w.id === 'w3')!.e, n: 1 }])
    expect(lanes.captions.map((c) => [c.text, c.t0, c.t1])).toEqual([['then fold', placed.find((w) => w.id === 'w6')!.s, placed.find((w) => w.id === 'w7')!.e]])
    expect(lanes.music).toEqual({ name: 'happy song', startAt: 0, fadeIn: 0.6, fadeOut: 1.5 })
    expect(lanes.video.map((v) => [round(v.t0), round(v.t1)])).toEqual([[0, 1.85], [1.85, 3.75]])
  })
})
