import { describe, expect, it } from 'vitest'
import { ago, classifyKind, newestFirst, shortLine, sourceDetail, sourceLine, type MemoryKind } from '../src/shared/memory'
import type { StyleRule } from '../src/shared/api'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const before = (hours: number): string => new Date(NOW - hours * 3600_000).toISOString()
const rule = (r: Partial<StyleRule>): StyleRule => ({ id: 'r', text: 'Open on the punchline.', createdAt: before(1), ...r })

describe('My style: kind of each rule', () => {
  const table: [string, MemoryKind | null][] = [
    ['Use lowercase subtitles.', 'captions'],
    ['Bigger captions with a bold font.', 'captions'],
    ['Tighter pauses between sentences.', 'pacing'],
    ['Keep the pace fast in the first five seconds.', 'pacing'],
    ['Slow down the ending.', 'pacing'],
    ['Keep the music quieter under talking.', 'music'],
    ['Pick a song with a strong beat.', 'music'],
    ['Lower the volume when I talk.', 'music'],
    ['Cut the ums and false starts.', 'cuts'],
    ['Use my best take of each line.', 'cuts'],
    ['Add b-roll over long answers.', 'cuts'],
    ['No jump cuts.', 'cuts'],
    ['Zoom in on the punchline.', 'look'],
    ['Warmer colour on every reel.', 'look'],
    ['A warmer color grade.', 'look'],
    ['Put my face on the cover.', 'look'],
    // two kinds: the first keyword in the sentence decides
    ['Cut long pauses.', 'cuts'],
    ['Zoom in slowly.', 'look'],
    ['Tighter pauses, fewer jump cuts.', 'pacing'],
    // no keyword: no kind, never a guess
    ['Open on the punchline.', null],
    ['Never use emojis.', null],
    // words that only start like a keyword
    ['Make it cute.', null],
    ['End with the takeaway.', null],
    ['Show a beautiful shot of the bread.', null],
    ['Film at breakfast.', null],
    // "caption" is the text posted under the reel, not subtitles
    ['End the caption with a question.', null],
    ['Keep the caption under 100 characters.', null]
  ]
  it.each(table)('fails if "%s" is not read as %s', (text, kind) => {
    expect(classifyKind(text)).toBe(kind)
  })
})

describe('My style: the short line', () => {
  const table: [string, string][] = [
    ['Use lowercase subtitles.', 'Lowercase subtitles'],
    ['Always use big subtitles.', 'Big subtitles'],
    ['From now on, keep the music quiet.', 'Keep the music quiet'],
    ['Please make sure to add a hook in the first second.', 'Add a hook in the first second'],
    ['Keep the music quieter in every video.', 'Keep the music quieter'],
    // words that change the meaning stay
    ['Never use emojis.', 'Never use emojis'],
    ["Don't use jump cuts.", "Don't use jump cuts"],
    ['Always.', 'Always'],
    [
      'Keep the music much quieter whenever I am talking and bring it back up between sentences.',
      'Keep the music much quieter whenever I am talking and bring…'
    ]
  ]
  it.each(table)('fails if "%s" does not read "%s"', (text, line) => {
    expect(shortLine(text)).toBe(line)
    expect(shortLine(text).length).toBeLessThanOrEqual(60)
  })
})

describe('My style: newest first', () => {
  it('fails if a rule edited yesterday does not sort above one created two days ago', () => {
    const created = rule({ id: 'created', createdAt: before(48) })
    const edited = rule({ id: 'edited', createdAt: before(24 * 5), updatedAt: before(24) })
    expect(newestFirst([edited, created]).map((r) => r.id)).toEqual(['edited', 'created'])
    expect(newestFirst([created, edited]).map((r) => r.id)).toEqual(['edited', 'created'])
  })

  it('fails if rules saved at the same moment are not shown last-saved first, or a rule with no date is not last', () => {
    const rules = [rule({ id: 'a', createdAt: before(2) }), rule({ id: 'b', createdAt: before(2) }), rule({ id: 'old', createdAt: 'sometime' }), rule({ id: 'new', createdAt: before(1) })]
    expect(newestFirst(rules).map((r) => r.id)).toEqual(['new', 'b', 'a', 'old'])
  })
})

describe('My style: where each rule came from', () => {
  it('fails if a source line does not say where and when, in plain words', () => {
    const note = { project: 'bread', title: 'Bread reel', version: 3, note: 'make the subtitles lowercase' }
    expect(sourceLine(rule({ source: note, createdAt: before(48) }), NOW)).toBe('from your note on “Bread reel”, 2 days ago')
    expect(sourceLine(rule({ source: { project: 'bread', title: 'Bread reel', version: 3 }, createdAt: before(48) }), NOW)).toBe('from “Bread reel”, 2 days ago')
    expect(sourceLine(rule({ imported: { file: 'gym.xml' }, createdAt: before(24 * 21) }), NOW)).toBe('from your Premiere Pro edit gym.xml, 3 weeks ago')
    expect(sourceLine(rule({ imported: { file: 'tour.fcpxml' }, createdAt: before(24 * 8) }), NOW)).toBe('from your Final Cut Pro edit tour.fcpxml, last week')
    expect(sourceLine(rule({ imported: { file: 'gym.xml, tour.fcpxml' }, createdAt: before(24 * 8) }), NOW)).toBe('from 2 of your past edits, last week')
    // the editor kept with the rule wins over the file's name: DaVinci Resolve writes FCPXML too
    expect(sourceLine(rule({ imported: { file: 'Timeline 1.fcpxml', editor: 'DaVinci Resolve' }, createdAt: before(24 * 8) }), NOW)).toBe('from your DaVinci Resolve edit Timeline 1.fcpxml, last week')
    expect(sourceLine(rule({ imported: { file: 'Bread reel/draft_content.json' }, createdAt: before(24 * 8) }), NOW)).toBe('from your CapCut edit Bread reel/draft_content.json, last week')
    expect(sourceLine(rule({ imported: { file: 'cut.edl', editor: 'EDL' }, createdAt: before(24 * 8) }), NOW)).toBe('from your edit list cut.edl, last week')
    expect(sourceLine(rule({ byYou: true, createdAt: before(0.001) }), NOW)).toBe('added by you, just now')
    expect(sourceLine(rule({ source: note, createdAt: before(24 * 30), updatedAt: before(26) }), NOW)).toBe('from your note on “Bread reel”, edited yesterday')
  })

  it('fails if a rule from before sources were kept does not say "earlier"', () => {
    expect(sourceLine(rule({ createdAt: before(24 * 60) }), NOW)).toBe('earlier')
  })

  it('fails if the open line does not name the note itself, its version, or every file an export came from', () => {
    const note = { project: 'bread', title: 'Bread reel', version: 3, note: 'make the subtitles lowercase' }
    expect(sourceDetail(rule({ source: note }))).toBe('Your note “make the subtitles lowercase” on Version 3 of “Bread reel”')
    expect(sourceDetail(rule({ source: { ...note, version: 0 } }))).toBe('Your note “make the subtitles lowercase” on “Bread reel”')
    expect(sourceDetail(rule({ source: { project: 'bread', title: 'Bread reel', version: 3 } }))).toBe('From Version 3 of “Bread reel”')
    expect(sourceDetail(rule({ imported: { file: 'gym.xml, tour.fcpxml' } }))).toBe('Read from gym.xml (Premiere Pro), tour.fcpxml (Final Cut Pro)')
    // the short source line already says these
    expect(sourceDetail(rule({ source: { project: 'bread', title: 'Bread reel', version: 0 } }))).toBeNull()
    expect(sourceDetail(rule({ imported: { file: 'gym.xml' } }))).toBeNull()
    expect(sourceDetail(rule({ byYou: true }))).toBeNull()
  })
})

describe('My style: how long ago', () => {
  const table: [number, string][] = [
    [0.01, 'just now'],
    [5 / 60, '5 minutes ago'],
    [3, '3 hours ago'],
    [26, 'yesterday'],
    [50, '2 days ago'],
    [24 * 6, '6 days ago'],
    [24 * 8, 'last week'],
    [24 * 21, '3 weeks ago'],
    [24 * 45, 'last month'],
    [24 * 70, '2 months ago'],
    [24 * 400, 'last year'],
    [-2, 'just now']
  ]
  it.each(table)('fails if %s hours ago does not read "%s"', (hours, text) => {
    expect(ago(before(hours), NOW)).toBe(text)
  })
  it('fails if a date that cannot be read gets a time', () => {
    expect(ago('sometime', NOW)).toBeNull()
  })
})
