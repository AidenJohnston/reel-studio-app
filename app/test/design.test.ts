// Design critique helpers: progress + time left, "Version 3: bigger yellow subtitles", friendly
// folder names, and the Library summary line.
import { describe, expect, it } from 'vitest'
import { clock, estimateSecondsLeft, timeLeftText } from '../src/shared/progress'
import { acceptRewrite, describeChange, describeFacts, describeSorted, versionMessage, versionTitle, versionTooltip } from '../src/shared/describe'
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
  it('fails if the title of a cut-plus-subtitles version is wrong', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
    const facts = [
      { kind: 'cut.keep', before: [{ from: 'w0', to: 'w5' }], after: [{ from: 'w2', to: 'w5' }] },
      { kind: 'captions.style', field: 'size', before: 105, after: 126 }
    ]
    expect(versionTitle(facts, words)).toBe('Shorter cut, bigger subtitles')
  })
  it('fails if a version title names a change that is not in its receipt', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
    const receipts = [
      [{ kind: 'source', id: 's1', before: { id: 's1', mirror: false }, after: { id: 's1', mirror: true } }],
      [{ kind: 'source', id: 's1', before: { id: 's1', mirror: true }, after: { id: 's1', mirror: false } }],
      [{ kind: 'cut.keep', before: [{ from: 'w0', to: 'w3' }], after: [{ from: 'w0', to: 'w5' }] }],
      [{ kind: 'cut.gapCap', before: 0.25, after: 0.12 }],
      [{ kind: 'captions.corrections', before: [], after: [{ from: 'bred', to: 'bread' }] }],
      [{ kind: 'music.track', before: 'Library/Music/calm.mp3', after: 'Library/Music/Picture Perfect.mp3' }],
      [{ kind: 'broll', id: 'b1', before: { id: 'b1', treatment: 'side-card' }, after: { id: 'b1', treatment: 'full-frame' } }],
      [{ kind: 'zooms', before: [{ scale: 1.1 }], after: [] }],
      [{ kind: 'cover.text', before: null, after: 'Bread' }],
      [{ kind: 'post.caption', before: '', after: 'My bread' }]
    ]
    // the app's own name and summary pass for any three changes together ("A, B and more")
    for (const [i, a] of receipts.entries()) {
      for (const [j, b] of receipts.entries()) {
        for (const c of receipts.slice(Math.max(i, j) + 1)) {
          if (j <= i) continue
          const facts = [...a, ...b, ...c]
          const own = { title: versionTitle(facts, words), summary: describeFacts(facts, words) }
          expect(acceptRewrite(own, facts, words), own.title).toEqual(own)
        }
      }
    }
    for (const facts of receipts) {
      const title = versionTitle(facts, words)
      expect(acceptRewrite({ title, summary: describeFacts(facts, words) }, facts, words), title).not.toBeNull()
      for (const other of receipts.filter((r) => r !== facts)) expect(acceptRewrite({ title, summary: title }, other, words), `${title} for ${other[0].kind}`).toBeNull()
    }
  })
  it('fails if a rewording that contradicts its receipt is kept', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
    const cutTwo = { kind: 'cut.keep', before: [{ from: 'w0', to: 'w5' }], after: [{ from: 'w2', to: 'w5' }] }
    const restoreTwo = { kind: 'cut.keep', before: [{ from: 'w2', to: 'w5' }], after: [{ from: 'w0', to: 'w5' }] }
    const bigger = { kind: 'captions.style', field: 'size', before: 105, after: 126 }
    const added = (id: string) => ({ kind: 'broll', id, before: null, after: { id } })
    const contradictions: [string, unknown[]][] = [
      ['New song', [{ kind: 'music.track', before: 'Library/Music/calm.mp3', after: null }]],
      ['Added a picture', [{ kind: 'broll', id: 'b1', before: { id: 'b1' }, after: null }]],
      ['Trimmed 2 words', [restoreTwo]],
      ['Subtitles removed', [bigger]],
      ['Subtitles not bigger', [bigger]],
      ['Cut 3 words, 2 pictures', [cutTwo, added('b1'), added('b2'), added('b3')]],
      ['Twelve words cut', [cutTwo]],
      ['Shorter cut, idiot', [cutTwo]],
      ['Cut 2 words', [restoreTwo]],
      ['Longer cut', [restoreTwo]],
      ['Cut a word', [cutTwo]],
      ['Fixed a word', [{ kind: 'captions.corrections', before: [], after: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }, { from: 'e', to: 'f' }] }]],
      ['Removed a picture', [{ kind: 'broll', id: 'b1', before: { id: 'b1' }, after: null }, { kind: 'broll', id: 'b2', before: { id: 'b2' }, after: null }]],
      ['Cut 2 takes', [cutTwo]],
      ['New cover words', [{ kind: 'cover.atSourceTime', before: 1, after: 2 }]],
      ['Subtitles off and back on', [{ kind: 'captions.enabled', before: true, after: false }, { kind: 'music.enabled', before: false, after: true }]],
      ['Added 2 animations', [added('b1'), added('b2')]]
    ]
    expect(versionTitle([restoreTwo], words)).toBe('More words back')
    const kept = contradictions.filter(([reply, facts]) => acceptRewrite({ title: reply, summary: reply.toLowerCase() }, facts as never, words))
    expect(kept.map(([reply]) => reply)).toEqual([])
    // the title alone is checked too: the app's own summary beside it changes nothing
    const keptTitles = contradictions.filter(([reply, facts]) => acceptRewrite({ title: reply, summary: describeFacts(facts as never, words) }, facts as never, words))
    expect(keptTitles.map(([reply]) => reply)).toEqual([])
  })
  it('fails if a fair rewording with "and more" or a song name is thrown away, or a made-up song name is kept', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
    const facts = [
      { kind: 'cut.keep', before: [{ from: 'w0', to: 'w5' }], after: [{ from: 'w2', to: 'w5' }] },
      { kind: 'captions.style', field: 'size', before: 105, after: 126 },
      { kind: 'music.track', before: null, after: 'Library/Music/Picture Perfect.mp3' }
    ]
    expect(versionTitle(facts, words)).toBe('Shorter cut, bigger subtitles and more')
    const fair = { title: 'Bigger captions, shorter cut and more', summary: 'new song “Picture Perfect”, cut two words and bigger subtitles' }
    expect(acceptRewrite(fair, facts, words)).toEqual(fair)
    expect(acceptRewrite({ ...fair, summary: 'new song "Smaller Captions", cut 2 words' }, facts, words)).toBeNull()
    // the app's own longest name passes its own check
    const restored = [{ kind: 'cut.keep', before: [{ from: 'w2', to: 'w5' }], after: [{ from: 'w0', to: 'w5' }] }, ...facts.slice(1)]
    const own = { title: versionTitle(restored, words), summary: describeFacts(restored, words) }
    expect(own.title).toBe('More words back, bigger subtitles and more')
    expect(acceptRewrite(own, restored, words)).toEqual(own)
  })
  it('fails if a version button names a subtitle colour its receipt does not record', () => {
    // yellow subtitles in a box; this edit only took the box away, so the receipt has no colour
    const unboxed = [{ kind: 'captions.style', field: 'box', before: true, after: false }]
    expect(describeFacts(unboxed, [])).toBe('unboxed subtitles')
    const own = { title: versionTitle(unboxed, []), summary: describeFacts(unboxed, []) }
    expect(acceptRewrite(own, unboxed, [])).toEqual(own)
    // a colour field the project never had is the default, which is white
    expect(describeFacts([...unboxed, { kind: 'captions.style', field: 'color', before: '#FFD60A', after: null }], [])).toBe('white subtitles')
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
    // a checked rewording of the summary replaces the app's words, never the chat's
    expect(versionTooltip({ n: 1, facts: size, wording: { title: 'Bigger captions', summary: 'made the subtitles bigger' } }, chat, [])).toBe('Version 1: made the subtitles bigger.')
  })
  // An Edit it myself change is said as what the person did: its line in the notes reads "You " + this.
  it('describes subtitle changes as things the person did', () => {
    const p = base()
    const patch = { captions: { enabled: true, style: { size: 126, position: 0.66, color: '#FFD60A', box: false } } }
    expect(describeChange(p, patch)).toBe('made the subtitles bigger and yellow, and moved them up')
    expect(describeChange(p, { captions: { enabled: true, style: { size: 105, position: 0.75, color: '#FFFFFF', box: true } } })).toBe('gave the subtitles the Boxed look')
    expect(describeChange(p, { captions: { enabled: false } })).toBe('turned the subtitles off')
    expect(describeChange(p, { captions: { enabled: true, style: { size: 105, position: 0.66 } } })).toBe('moved the subtitles up')
  })

  // fails if a hand edit's line reads "new song …" after "You", repeats "added" for each thing added, or uses straight quotes
  it('says one sentence for several things added, with the song in curly quotes', () => {
    const p = base({ music: { enabled: false, track: null } })
    const patch: Partial<ProjectJson> = {
      music: { enabled: true, track: 'Library/Music/warm_acoustic_loop.mp3', level: 'under-voice' },
      broll: [{ id: 'b', anchor: { from: 'w1', to: 'w2' }, treatment: 'card-above-head', asset: 'x' }],
      sfx: [{ sound: 'whoosh-soft', at: { word: 'w3' } }]
    }
    expect(describeChange(p, patch)).toBe('added the song “warm acoustic loop”, a picture and a sound effect')
    expect(describeChange(p, { ...patch, captions: { enabled: false } })).toBe('turned the subtitles off, and added the song “warm acoustic loop”, a picture and a sound effect')
  })

  it('fails if turning script-following off or on in Edit it myself goes unsaid', () => {
    const p = base({ captions: { enabled: true, style: {} } })
    expect(describeChange(p, { captions: { enabled: true, style: {}, followScript: false } })).toBe('made the subtitles show what you said')
    const off = base({ captions: { enabled: true, style: {}, followScript: false } })
    expect(describeChange(off, { captions: { enabled: true, style: {}, followScript: true } })).toBe('made the subtitles follow your script')
  })

  it('fails if changing only the Spoken word colour leaves the version undescribed', () => {
    const karaoke = { preset: 'karaoke', size: 105, position: 0.75, color: '#FFFFFF', highlight: '#FFD60A' }
    const p = base({ captions: { enabled: true, style: karaoke } })
    expect(describeChange(p, { captions: { enabled: true, style: { ...karaoke, highlight: '#30D158' } } })).toBe('made the words light up green')
    expect(describeChange(p, { captions: { enabled: true, style: { ...karaoke, highlight: null } } })).toBe('stopped the words lighting up')
  })

  it('describes retyping an existing one-place fix', () => {
    const fix = { from: 'cloud', to: 'Claude', at: 'w2' }
    const p = base({ captions: { enabled: true, corrections: [fix] } })
    const change = describeChange(p, { captions: { enabled: true, corrections: [{ ...fix, to: 'CLAUDE' }] } })
    expect(versionMessage(2, change)).toBe('Version 2: fixed a word.')
    expect(describeChange(p, { captions: { enabled: true, corrections: [{ ...fix }] } })).toBe('')
    expect(describeChange(p, { captions: { enabled: true, corrections: [] } })).toBe('')
  })

  it('describes cuts, music, pictures and the cover', () => {
    const p = base()
    expect(describeChange(p, {}, 2)).toBe('brought back 2 words')
    expect(describeChange(p, {}, -1)).toBe('cut a word')
    expect(describeChange(p, { music: { enabled: true, track: 'Library/Music/sunny_day.mp3' } })).toBe('changed the song to “sunny day”')
    expect(describeChange(p, { music: { enabled: false, track: null } })).toBe('removed the music')
    expect(describeChange(p, { broll: [{ id: 'b', anchor: { from: 'w1', to: 'w2' }, treatment: 'card-above-head', asset: 'x' }] })).toBe('added a picture')
    expect(describeChange(p, { cover: { atSourceTime: 2, source: 's1', text: 'Hi' } })).toBe('added words to the cover')
    expect(describeChange(p, { cover: { atSourceTime: 5, source: 's1', text: null } })).toBe('picked a new cover')
    expect(versionMessage(2, '')).toBe('Version 2 is ready.')
  })

  // fails if a pace or zoom-in change made by hand is logged as "You made a change"
  it('describes the pace and zoom-in kinds', () => {
    const z = { anchor: { from: 'w1', to: 'w2' }, kind: 'punch' as const }
    const p = base({ cutStyle: { preset: 'clean', seed: 1 }, zooms: [z, { anchor: { from: 'w4', to: 'w5' } }] })
    expect(describeChange(p, { cutStyle: { preset: 'hyper', seed: 1 } })).toBe('gave the reel a fast pace')
    expect(describeChange(p, { cutStyle: { preset: 'clean', seed: 7 } })).toBe('picked other moments for the accents')
    expect(describeChange(p, { cutStyle: undefined })).toBe('turned the set pace off')
    expect(describeChange(p, { zooms: [{ ...z, kind: 'drift' }, { anchor: { from: 'w4', to: 'w5' } }] })).toBe('made a zoom-in slow')
    expect(describeChange(p, { zooms: [{ ...z, kind: 'snap' }, { anchor: { from: 'w4', to: 'w5' }, kind: 'snap' }] })).toBe('changed 2 zoom-ins')
    // two zoom-ins on the same words are one row in the drawer, so one change
    const twice = base({ zooms: [z, { ...z, kind: 'snap' }] })
    expect(describeChange(twice, { zooms: [{ ...z, kind: 'drift' }, { ...z, kind: 'drift' }] })).toBe('made a zoom-in slow')
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
