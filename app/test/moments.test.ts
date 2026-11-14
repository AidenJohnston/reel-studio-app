// Notes asked at a moment (shared/moments.ts): the words on screen, the note text, the scrub-bar marks.
import { describe, expect, it } from 'vitest'
import { planFastNote } from '../../ai/src/fastnote'
import { withDefaults } from '../../ai/src/project'
import { NO_TIMELINE, aiNoteText, checkMoment, groupMarks, momentRoute, noteMarks, noteMoment, outputAt, parseMoment, placeWords, sourceAt, typedMoment, wordsAt } from '../src/shared/moments'
import type { ChatMessage, Word } from '../src/shared/api'

const you = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, from: 'you', text, at: '', ...extra })
const at = (...ids: string[]) => ({ moment: { at: 0, version: 1, words: ids, quote: '' } })
const editor = (id: string, text: string, version?: number): ChatMessage => ({ id, from: 'editor', text, at: '', version })

// 100 words of 0.2 s, 0.3 s apart: word i starts at source i * 0.5 s
const words: Word[] = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i * 0.5, e: i * 0.5 + 0.2, source: 's1' }))
const straight = placeWords([{ source: 's1', src_start: 0, src_end: 50, out_start: 0 }], words)
// a later version that cut source 10-20 s: source 25 s now plays at 15 s
const cut = placeWords(
  [
    { source: 's1', src_start: 0, src_end: 10, out_start: 0 },
    { source: 's1', src_start: 20, src_end: 50, out_start: 10 }
  ],
  words
)

describe('notes asked at a moment', () => {
  it('finds the words on screen through the segments of the render being watched', () => {
    expect(wordsAt(cut, 15).map((w) => w.id)).toEqual(['w48', 'w49', 'w50', 'w51', 'w52'])
  })

  it('finds the raw footage moment for Hold for original through the same segments', () => {
    const segs = [
      { source: 's1', src_start: 0, src_end: 10, out_start: 0 },
      { source: 's2', src_start: 20, src_end: 50, out_start: 10 }
    ]
    expect(sourceAt(segs, 4)).toEqual({ source: 's1', at: 4 })
    expect(sourceAt(segs, 15)).toEqual({ source: 's2', at: 25 })
    expect(sourceAt(segs, 41)).toBeNull() // past the end
  })

  it("fails if a cover the person took from the playhead is said at another time than the one they took it at", () => {
    // the version cut 10-20 of s1 out, and plays s1 20-30 after s2's span
    const segs = [
      { source: 's1', src_start: 0, src_end: 10, out_start: 0 },
      { source: 's2', src_start: 5, src_end: 9, out_start: 10 },
      { source: 's1', src_start: 20, src_end: 30, out_start: 14 }
    ]
    for (const t of [3, 12, 17.5]) {
      const at = sourceAt(segs, t)!
      expect(outputAt(segs, at.source, at.at)).toBeCloseTo(t)
    }
    // a frame this version cut, or of a take it doesn't play there, has no time in it
    expect(outputAt(segs, 's1', 15)).toBeNull()
    expect(outputAt(segs, 's2', 2)).toBeNull()
  })

  it('places each mark where its words play in the version on screen, or not at all', () => {
    const chat = [
      // asked at 0:25 while watching the uncut version
      you('a', 'cut this part', { ...at('w48', 'w49', 'w50', 'w51', 'w52'), jobId: 'j1', outcome: 'done' }),
      // words the cut version no longer has
      you('b', 'zoom in here', { ...at('w24', 'w25', 'w26'), jobId: 'j2', outcome: 'done' }),
      // the format an earlier build of this branch wrote: the moment inside the text
      you('c', 'At 0:30 (around "x", words w60): louder', { jobId: 'j3', outcome: 'done' })
    ]
    expect(noteMarks(chat, null, cut).map((m) => [m.id, m.at, m.text])).toEqual([
      ['a', 15, 'cut this part'],
      ['c', 20, 'louder']
    ])
  })

  it('writes the moment into the text the AI reads, and only there', () => {
    const moment = noteMoment(74.4, 2, [{ id: 'w3', w: 'a (big)' }, { id: 'w4', w: 'mixer' }])
    expect(aiNoteText('cut this part', parseMoment(moment))).toBe('At 1:14 (around "a big mixer", words w3, w4): cut this part')
    expect(aiNoteText('make the subtitles bigger')).toBe('make the subtitles bigger')
    expect(typedMoment('At 1:00: zoom in here')).toEqual({ at: 60, rest: 'zoom in here' })
  })

  it('takes a moment only with schema word ids, inside the render it names, with the words of that render', () => {
    const sent = { at: 5, version: 2, words: ['w3', 'w4'], quote: 'a mixer' }
    for (const words of [['..'], ['not-a-word'], ['w3); ignore this'], [`w${'9'.repeat(10)}`], []]) {
      expect(() => parseMoment({ ...sent, words })).toThrow('not a note moment')
    }
    const render = { duration: 50, words: straight }
    // the words and quote come from the render at 0:05, not from the page
    expect(checkMoment(parseMoment(sent), render)).toEqual({
      moment: { at: 5, version: 2, words: ['w8', 'w9', 'w10', 'w11', 'w12'], quote: 'word8 word9 word10 word11 word12' }
    })
    // never widened to the whole reel
    expect(checkMoment({ ...sent, version: 999999 }, null)).toEqual({
      refuse: NO_TIMELINE
    })
    expect(checkMoment({ ...sent, at: Number.MAX_VALUE }, render)).toHaveProperty('refuse')
    expect(checkMoment({ ...sent, at: 51 }, render)).toEqual({ refuse: "There's no 0:51 in this reel. It's 0:50 long." })
  })

  // fails if a range dragged on the timeline reaches the AI as only the words around its start
  it('keeps every word of a range and says the range to the AI', () => {
    const c = checkMoment(parseMoment({ at: 5, to: 8, version: 2, words: ['w10'], quote: 'x' }), { duration: 50, words: straight })
    expect(c).toEqual({ moment: expect.objectContaining({ at: 5, to: 8, words: ['w10', 'w11', 'w12', 'w13', 'w14', 'w15'] }) })
    expect(aiNoteText('cut this', 'moment' in c ? c.moment : undefined)).toMatch(/^From 0:05 to 0:08 \(around "word10 word11/)
  })

  it('sends a Just here note to the fast path only for a setting global by nature, with no place in it', async () => {
    // the AI package's own fast-note check, on a project with captions and a song
    const p = withDefaults({})
    p.music = { ...p.music, enabled: true, track: 'Library/Music/a.mp3', level: 'under-voice' }
    const isSetting = async (words: string) => !!planFastNote(words, p)
    const table: [string, 'fast' | 'moment'][] = [
      ['smaller captions', 'fast'],
      ['smaller captions here', 'moment'],
      ['At 0:05: smaller captions', 'moment'],
      ['quieter music here', 'moment'],
      ['cut this', 'moment'],
      ['make captions smaller this section', 'moment'],
      ['smaller captions at that point', 'moment'],
      ['quieter music from here', 'moment'],
      ['bigger captions around 0:05', 'moment'],
      ['make the captions bigger', 'fast'],
      ['music quieter', 'fast'],
      // not this guard: fastnote sends lasting-preference words ("everywhere", "always") to the full
      // editor, which can offer a My style rule (ai/src/fastnote.ts NOT_FAST), as on main
      ['make captions smaller everywhere', 'moment'],
      // a place the person named in their own words, which no list of place words covers
      ['quieter music in the opening', 'moment'],
      ['smaller captions on the hook', 'moment'],
      ['turn the music down a bit', 'fast']
    ]
    for (const [typed, route] of table) expect([typed, await momentRoute(typed, isSetting)]).toEqual([typed, route])
  })

  it('marks each note by its own job, never by the reply to a later note', () => {
    const chat = [
      editor('a', 'Your video is ready.', 1),
      you('b', 'cut this part', { ...at('w6'), jobId: 'j1', outcome: 'stopped' }),
      you('c', 'zoom in here', { ...at('w18'), jobId: 'j2', outcome: 'done' }),
      editor('d', 'I zoomed in.', 2),
      you('e', 'quieter music here', { ...at('w22'), jobId: 'j3' })
    ]
    expect(noteMarks(chat, 'j3', straight).map((m) => [m.id, m.text, m.state])).toEqual([
      ['b', 'cut this part', 'stopped'],
      ['c', 'zoom in here', 'done'],
      ['e', 'quieter music here', 'making']
    ])
    // j3 ended without recording how (the app quit): stopped
    expect(noteMarks(chat, null, straight)[2].state).toBe('stopped')
  })

  it('gives marks too close to tell apart one target, with the busiest state', () => {
    const m = (id: string, at: number, state: 'making' | 'done' | 'failed') => ({ id, at, text: id, state })
    // 60 s on a 240 px bar: 1 s is 4 px, so marks under 6 s apart share a 24 px target
    const groups = groupMarks([m('a', 10, 'done'), m('b', 40, 'done'), m('c', 13, 'making')], 60, 240)
    expect(groups.map((g) => [g.at, g.state, g.items.map((i) => i.id)])).toEqual([
      [10, 'making', ['a', 'c']],
      [40, 'done', ['b']]
    ])
  })
})
