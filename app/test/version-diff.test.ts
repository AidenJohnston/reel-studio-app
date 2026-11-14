import { describe, expect, it } from 'vitest'
import type { ProjectJson } from '../src/shared/api'
import { versionFact, versionRows } from '../src/shared/version-diff'

const base = (patch: Partial<ProjectJson> = {}): ProjectJson =>
  ({
    schemaVersion: 1, id: 'p', title: 'T', slug: 't', createdAt: '', updatedAt: '', version: 1,
    sources: [{ id: 's1', path: 'media/s1.mov', duration: 192 }],
    captions: { enabled: true, style: { size: 105, position: 0.75 } },
    music: { enabled: false, track: null },
    broll: [], zooms: [],
    cover: { atSourceTime: 5, source: 's1', text: null },
    ...patch
  }) as ProjectJson

describe('versionRows', () => {
  it('names only what a change touched, before and after', () => {
    const before = base()
    const after = base({ captions: { enabled: true, style: { size: 126, position: 0.75 } }, music: { enabled: true, track: 'Library/Music/Warm Rise.mp3' } })
    expect(versionRows(before, after, { before: 30, after: 30 })).toEqual([
      { label: 'Subtitle size', before: 'Medium', after: 'Big' },
      { label: 'Music', before: 'None', after: '“Warm Rise”' }
    ])
  })

  it('compares the first version with the raw video', () => {
    expect(versionRows(null, base({ broll: [{ id: 'b1', anchor: { from: 'w1', to: 'w2' }, treatment: 'full', asset: 'x.jpg' }] }), { before: 192, after: 30 })).toEqual([
      { label: 'Length', before: '3:12', after: '0:30' },
      { label: 'Subtitles', before: 'None', after: 'On' },
      { label: 'Pictures', before: 'None', after: '1 picture' },
      { label: 'Cover', before: 'None', after: 'The 0:05 frame' }
    ])
  })
})

describe('versionFact', () => {
  const picture = { id: 'b1', anchor: { from: 'w1', to: 'w2' }, treatment: 'card-above-head', asset: 'x' } as NonNullable<ProjectJson['broll']>[number]
  const sound = { sound: 'whoosh-soft', at: { word: 'w3' } }

  // fails if a version's line is the clamped "Version 2: new song …" sentence instead of a short fact from its rows
  it('says in a few words what the rows changed', () => {
    const after = base({ music: { enabled: true, track: 'Library/Music/warm acoustic loop.mp3' }, broll: [picture], sfx: [sound] })
    expect(versionFact(versionRows(base(), after, { before: 20, after: 20 }))).toBe('Song, 1 sound effect, 1 picture')
    const swapped = base({ music: { enabled: true, track: 'Library/Music/sunny day.mp3' } })
    expect(versionFact(versionRows(after, swapped, { before: 20, after: 20 }))).toBe('New song, no sound effects, no pictures')
  })

  it('reads a subtitle’s size and look as one change, and a move alone as where they went', () => {
    const bigYellow = base({ captions: { enabled: true, style: { size: 126, position: 0.6, color: '#FFD60A' } } })
    expect(versionFact(versionRows(base(), bigYellow, { before: 20, after: 20 }))).toBe('Bigger yellow subtitles')
    // fails if a colour other than white is named yellow: a note for bright red made "Bigger yellow subtitles" (J9),
    // or a shade with no common name is given one
    const bigRed = base({ captions: { enabled: true, style: { size: 126, position: 0.75, color: '#FF0000' } } })
    expect(versionRows(base(), bigRed, { before: 20, after: 20 })).toContainEqual({ label: 'Subtitle look', before: 'Plain', after: 'Red' })
    expect(versionFact(versionRows(base(), bigRed, { before: 20, after: 20 }))).toBe('Bigger red subtitles')
    const muted = base({ captions: { enabled: true, style: { size: 105, position: 0.75, color: '#8C7B6B' } } })
    expect(versionFact(versionRows(base(), muted, { before: 20, after: 20 }))).toBe('Recoloured subtitles')
    // a deep purple is purple, not the pink of the same hue at full brightness
    const purple = base({ captions: { enabled: true, style: { size: 105, position: 0.75, color: '#800080' } } })
    expect(versionFact(versionRows(base(), purple, { before: 20, after: 20 }))).toBe('Purple subtitles')
    const higher = base({ captions: { enabled: true, style: { size: 105, position: 0.6 } } })
    expect(versionFact(versionRows(base(), higher, { before: 20, after: 18 }))).toBe('Shorter, higher subtitles')
  })

  it('says what Version 1 did to the raw video, and names three before "and N more"', () => {
    const v1 = base({ cover: { atSourceTime: 3, source: 's1', text: null } })
    expect(versionFact(versionRows(null, v1, { before: 21, after: 20 }))).toBe('Shorter, subtitles, cover')
    const lots = base({ captions: { enabled: true, style: { size: 126, position: 0.75 } }, music: { enabled: true, track: 'Library/Music/a.mp3' }, broll: [picture], sfx: [sound], cover: { atSourceTime: 9, source: 's1', text: 'Hi' } })
    expect(versionFact(versionRows(base(), lots, { before: 30, after: 20 }))).toBe('Shorter, bigger subtitles, song and 4 more')
    expect(versionFact([])).toBe('')
  })
})

describe('what a later version changed that its counts hide', () => {
  const picture = (asset: string) => ({ id: asset, anchor: { from: 'w1', to: 'w2' }, treatment: 'full', asset }) as NonNullable<ProjectJson['broll']>[number]
  const whoosh = (gainDb?: number) => ({ sound: 'whoosh-soft', at: { word: 'w3' }, ...(gainDb === undefined ? {} : { gainDb }) })

  // fails if a sound's level reads in decibels instead of the Sound tab's Quiet / Normal / Loud, or a change inside
  // one word (−6 dB to −9 dB, both Quiet) reads as no change
  it('names a sound effect’s level in the Sound tab’s words, with the exact level as the tooltip', () => {
    const rows = (a: number | undefined, b: number) => versionRows(base({ sfx: [whoosh(a)] }), base({ sfx: [whoosh(b)] }), { before: 20, after: 20 })
    expect(rows(undefined, -9)).toEqual([{ label: 'Whoosh volume', before: 'Normal', after: 'Quiet', title: '0 dB → −9 dB' }])
    expect(rows(-6, -9)).toEqual([{ label: 'Whoosh volume', before: 'Quiet', after: 'A bit quieter', title: '−6 dB → −9 dB' }])
    expect(rows(-9, -6)[0].after).toBe('A bit louder')
    expect(rows(-9, -9)).toEqual([])
  })

  // fails if a version that swapped one picture for another, or wrote a new post caption, gets no line
  it('says a picture was swapped when the count stays the same, and a new post caption', () => {
    const swap = versionRows(base({ broll: [picture('a.jpg'), picture('b.jpg')] }), base({ broll: [picture('a.jpg'), picture('c.jpg')] }), { before: 20, after: 20 })
    expect(swap).toEqual([{ label: 'Pictures swapped', before: '', after: '1' }])
    expect(versionFact(swap)).toBe('1 picture swapped')

    const post = (caption: string) => ({ caption, hashtags: [], keywords: [] })
    const long = 'Three things I wish someone told me before my first marathon, in order'
    const rewritten = versionRows(base({ post: post('Old words') }), base({ post: post(long) }), { before: 20, after: 20 })
    expect(rewritten).toEqual([{ label: 'Post caption', before: '', after: '“Three things I wish someone told me…”' }])
    expect(versionFact(rewritten)).toBe('New post caption')
    expect(versionFact(versionRows(base(), base({ post: post('Hi') }), { before: 20, after: 20 }))).toBe('Post caption')
    // Version 1 always writes one
    expect(versionRows(null, base({ post: post('Hi') }), { before: 20, after: 20 }).map((r) => r.label)).not.toContain('Post caption')
  })
})
