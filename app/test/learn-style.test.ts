import { describe, expect, it } from 'vitest'
import { editorOf, learnStyle, type ImportRecord, type RefItem } from '../src/shared/learn-style'

// Records in the shape engine/reelengine/reference_import.py returns (25 fps Premiere, frames as values).
const at = (start: number, dur: number) => ({ start: { value: start * 25, rate: 25 }, duration: { value: dur * 25, rate: 25 } })
const clip = (start: number, dur: number, url = 'file:///media/talk.mov'): RefItem => ({ type: 'clip', name: 'talk.mov', trackRange: at(start, dur), media: { kind: 'file', url } })
const dissolve: RefItem = { type: 'transition', name: 'Cross Dissolve' }
const title = (start: number): RefItem => ({ type: 'clip', name: 'Hook title', trackRange: at(start, 2), media: { kind: 'generator', generator: 'Text' } })
const record = (tracks: ImportRecord['timelines'][number]['tracks']): ImportRecord => ({ source: { adapter: 'fcp_xml' }, timelines: [{ name: 'Cut', tracks }] })

describe('Learn from my past edits', () => {
  it('fails if a quick-cut reel with b-roll, an opening title and a song is not read as those habits', () => {
    const main = Array.from({ length: 10 }, (_, i) => clip(i * 2, 2))
    const lesson = learnStyle([
      record([
        { name: '0', kind: 'Video', items: main },
        { name: '1', kind: 'Video', items: [clip(3, 1.5, 'file:///media/a.mov'), clip(9, 1.5, 'file:///media/b.mov'), clip(15, 1.5, 'file:///media/c.mov')] },
        { name: '2', kind: 'Video', items: [title(0.5)] },
        { name: '3', kind: 'Audio', items: [clip(0, 20, 'file:///media/song.mp3')] }
      ])
    ])
    expect(lesson).toMatchObject({ timelines: 1, shots: 10 })
    expect(lesson.rules.map((r) => r.text)).toEqual([
      'Keep reels around 20 seconds.',
      'Cut to a new shot every 2 seconds or so.',
      'Use straight cuts between shots, no transitions.',
      'Show an extra clip or picture about 9 times a minute.',
      'Open with a title on screen in the first few seconds.',
      'Put music under the talking.'
    ])
    expect(lesson.rules[1].evidence).toBe('10 shots across 1 timeline, 2 seconds each on average.')
  })

  it('fails if long shots joined by dissolves are read as quick cuts, or habits it never saw are stated', () => {
    const items = Array.from({ length: 5 }, (_, i) => clip(i * 8, 8)).flatMap((c, i) => (i ? [dissolve, c] : [c]))
    const lesson = learnStyle([record([{ name: '0', kind: 'Video', items }, { name: '1', kind: 'Audio', items: [clip(0, 40)] }])])
    expect(lesson.rules.map((r) => r.text)).toEqual([
      'Keep reels around 40 seconds.',
      'Let shots run long, about 8 seconds each.',
      'Use a quick dissolve between shots.'
    ])
  })

  // DaVinci Resolve starts a timeline at 01:00:00:00, and its FCPXML places clips from there
  it('fails if an FCPXML timeline that starts at one hour is read as an hour long, or its opening title is missed', () => {
    const h = 3600
    const main = Array.from({ length: 10 }, (_, i) => clip(h + i * 2, 2))
    const lesson = learnStyle([
      {
        source: { adapter: 'fcpx_xml', writer: 'DaVinci Resolve' },
        timelines: [{ name: 'Timeline 1', globalStart: { value: h * 25, rate: 25 }, tracks: [{ name: '0', kind: 'Video', items: main }, { name: '1', kind: 'Video', items: [title(h + 0.5)] }] }]
      }
    ])
    expect(lesson.rules.map((r) => r.text)).toEqual([
      'Keep reels around 20 seconds.',
      'Cut to a new shot every 2 seconds or so.',
      'Use straight cuts between shots, no transitions.',
      'Open with a title on screen in the first few seconds.'
    ])
  })

  it('fails if a blank lead-in on a Premiere timeline is dropped, making a later title an opening one', () => {
    const main = Array.from({ length: 10 }, (_, i) => clip(5 + i * 2, 2))
    const lesson = learnStyle([record([{ name: '0', kind: 'Video', items: main }, { name: '1', kind: 'Video', items: [title(5.5)] }])])
    expect(lesson.rules[0].text).toBe('Keep reels around 25 seconds.')
    expect(lesson.rules.map((r) => r.text)).not.toContain('Open with a title on screen in the first few seconds.')
  })

  it('fails if a song on an EDL, which names clips but not their files, is not heard as music', () => {
    const song: RefItem = { type: 'clip', name: 'song.mp3', trackRange: at(0, 20), media: { kind: 'file', url: null, name: 'song.mp3' } }
    const lesson = learnStyle([record([{ name: 'V', kind: 'Video', items: [clip(0, 20)] }, { name: 'A', kind: 'Audio', items: [song] }])])
    expect(lesson.rules.map((r) => r.text)).toContain('Put music under the talking.')
  })

  it('fails if a lesson names the wrong editor for a Resolve FCPXML, a CapCut project or an EDL', () => {
    const of = (source: ImportRecord['source']) => editorOf({ source, timelines: [] })
    expect(of({ adapter: 'fcpx_xml' })).toBe('Final Cut Pro')
    expect(of({ adapter: 'fcpx_xml', writer: 'DaVinci Resolve' })).toBe('DaVinci Resolve')
    expect(of({ adapter: 'capcut', writer: 'JianYing' })).toBe('CapCut')
    expect(of({ adapter: 'cmx_3600' })).toBe('EDL')
    expect(of({ adapter: 'fcp_xml' })).toBe('Premiere Pro')
  })

  it('fails if an export with nothing on its timeline yields rules', () => {
    expect(learnStyle([record([{ name: '0', kind: 'Video', items: [] }])])).toEqual({ timelines: 0, shots: 0, rules: [] })
  })
})
