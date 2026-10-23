// Design critique helpers: progress + time left, "Version 3: bigger yellow subtitles", friendly
// folder names, and the Library summary line.
import { describe, expect, it } from 'vitest'
import { STAGES, clock, estimateSecondsLeft, overallProgress, stageIndex, timeLeftText } from '../src/shared/progress'
import { describeChange, describeFacts, describeSorted, versionMessage, versionTooltip } from '../src/shared/describe'
import { displayPath } from '../src/shared/display-path'
import type { ChatMessage, DropResult, ProjectJson } from '../src/shared/api'

const base = (extra: Partial<ProjectJson> = {}): ProjectJson =>
  ({
    schemaVersion: 1,
    id: 'p',
    title: 'T',
    slug: 't',
    createdAt: '',
    updatedAt: '',
    version: 1,
    captions: { enabled: true, style: { size: 105, position: 0.75, color: '#FFFFFF', box: false } },
    music: { enabled: true, track: 'Library/Music/happy song.mp3', level: 'under-voice' },
    broll: [],
    cover: { atSourceTime: 2, source: 's1', text: null },
    ...extra
  }) as ProjectJson

describe('progress', () => {
  it('weights steps by their usual share of the time and never goes backwards', () => {
    const listen = stageIndex('Listening to your video', 0)
    expect(STAGES[listen].label).toBe('Listening to your video')
    const a = overallProgress(listen, 50, 0)
    expect(a).toBeGreaterThan(15) // copying (4) + half of listening (30)
    expect(a).toBeLessThan(25)
    expect(overallProgress(listen, 10, a)).toBe(a)
    expect(overallProgress(STAGES.length - 1, 100, 0)).toBeLessThanOrEqual(99)
    expect(stageIndex('something unknown', 3)).toBe(3)
    expect(stageIndex('Copying your video', 4)).toBe(4) // never back to an earlier step
  })

  it('says time left in round, calm words', () => {
    expect(estimateSecondsLeft(3, 30)).toBeNull() // too early to say
    expect(estimateSecondsLeft(50, 60)).toBe(60)
    expect(timeLeftText(null)).toBeNull()
    expect(timeLeftText(10)).toBe('Almost done')
    expect(timeLeftText(45)).toBe('Less than a minute left')
    expect(timeLeftText(80)).toBe('About a minute left')
    expect(timeLeftText(185)).toBe('About 3 minutes left')
    expect(timeLeftText(5000)).toBe('More than an hour left')
    expect(clock(16.4)).toBe('0:16')
    expect(clock(75)).toBe('1:15')
  })
})

describe('version messages', () => {
  it('fails if a version button stops reading its receipt the way a manual edit is worded', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
    const facts = [
      { kind: 'cut.keep', before: [{ from: 'w0', to: 'w5' }], after: [{ from: 'w2', to: 'w5' }] },
      { kind: 'captions.style', field: 'size', before: 105, after: 126 },
      { kind: 'captions.style', field: 'color', before: '#FFFFFF', after: '#FFD60A' },
      { kind: 'music.level', before: 'under-voice', after: 'quiet' },
      { kind: 'broll', id: 'b3', before: null, after: { id: 'b3' } }
    ]
    expect(versionMessage(4, describeFacts(facts, words))).toBe('Version 4: cut 2 words, bigger yellow subtitles, quieter music, added a picture.')
  })
  it("fails if a version button shows the AI's chat reply when a receipt exists, or for a version made after receipts", () => {
    const chat: ChatMessage[] = [
      { id: '1', from: 'editor', text: 'I made the subtitles bigger.', at: '', version: 1 },
      { id: '2', from: 'editor', text: 'I made the subtitles bigger.', at: '', version: 2 },
      { id: '3', from: 'editor', text: 'I tightened your pauses.', at: '', version: 3 },
      { id: '4', from: 'you', text: 'try tighter pauses', at: '' },
      { id: '5', from: 'editor', text: "That left your video the same as before, so I didn't make a new version.", at: '' }
    ]
    const size = [{ kind: 'captions.style', field: 'size', before: 105, after: 126 }]
    expect(versionTooltip({ n: 1, facts: size }, chat, [])).toBe('Version 1: bigger subtitles.')
    expect(versionTooltip({ n: 2 }, chat, [])).toBeUndefined()
    expect(versionTooltip({ n: 3, beforeReceipts: true }, chat, [])).toBe('I tightened your pauses.')
  })
  it('describes subtitle changes the way a person would', () => {
    const p = base()
    const patch = { captions: { enabled: true, style: { size: 126, position: 0.66, color: '#FFD60A', box: false } } }
    expect(describeChange(p, patch)).toBe('bigger yellow subtitles, moved up')
    expect(versionMessage(3, describeChange(p, patch))).toBe('Version 3: bigger yellow subtitles, moved up.')
    expect(describeChange(p, { captions: { enabled: true, style: { size: 105, position: 0.75, color: '#FFFFFF', box: true } } })).toBe('boxed subtitles')
    expect(describeChange(p, { captions: { enabled: false } })).toBe('no subtitles')
    expect(describeChange(p, { captions: { enabled: true, style: { size: 105, position: 0.66 } } })).toBe('subtitles moved up')
  })

  it('describes cuts, music, pictures and the cover', () => {
    const p = base()
    expect(describeChange(p, {}, 2)).toBe('brought back 2 words')
    expect(describeChange(p, {}, -1)).toBe('cut a word')
    expect(describeChange(p, { music: { enabled: true, track: 'Library/Music/sunny_day.mp3' } })).toBe('new song "sunny day"')
    expect(describeChange(p, { music: { enabled: false, track: null } })).toBe('no music')
    expect(describeChange(p, { broll: [{ id: 'b', anchor: { from: 'w1', to: 'w2' }, treatment: 'card-above-head', asset: 'x' }] })).toBe('added a picture')
    expect(describeChange(p, { cover: { atSourceTime: 2, source: 's1', text: 'Hi' } })).toBe('new words on the cover')
    expect(describeChange(p, { cover: { atSourceTime: 5, source: 's1', text: null } })).toBe('new cover')
    expect(versionMessage(2, '')).toBe('Version 2 is ready.')
  })
})

describe('folder names', () => {
  it('shows Documents › Reel Studio, never an 8.3 short path', () => {
    expect(displayPath('C:\\Users\\Zoë Müller\\Documents\\Reel Studio', { documents: 'C:\\Users\\Zoë Müller\\Documents' }, 'win32')).toBe(
      'Documents › Reel Studio'
    )
    // Windows paths are case-insensitive.
    expect(displayPath('c:\\users\\zoe\\documents\\Reel Studio', { documents: 'C:\\Users\\Zoe\\Documents' }, 'win32')).toBe('Documents › Reel Studio')
    expect(displayPath('/Users/zoe/Movies/Reel Studio', { documents: '/Users/zoe/Documents', home: '/Users/zoe' }, 'darwin')).toBe(
      'Home › Movies › Reel Studio'
    )
    expect(displayPath('D:\\Videos\\Reel Studio', { documents: 'C:\\Users\\zoe\\Documents' }, 'win32')).toBe('D: › Videos › Reel Studio')
  })
})

describe('Library summary', () => {
  const r = (name: string, bin: DropResult['bin'], reason?: string): DropResult => ({ file: name, name, bin, dest: bin ? `x/${name}` : null, reason })
  it('says what was added and what was skipped, once, in plain words', () => {
    expect(describeSorted([r('a.mp3', 'music'), r('b.png', 'images'), r('notes.txt', null, '"notes.txt" isn\'t a video, song or picture')])).toBe(
      'Added 1 song and 1 picture to your Library. Skipped notes.txt (not a video, song or picture).'
    )
    expect(describeSorted([r('a.mp3', 'music'), r('b.mp3', 'music'), r('c.mov', 'broll')])).toBe('Added 2 songs and 1 extra clip to your Library.')
    expect(describeSorted([r('stuff', null, 'This is a folder. Open it and drop the files inside.')])).toBe('Skipped stuff (a folder).')
  })
})
