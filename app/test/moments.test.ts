// Notes asked at a moment (shared/moments.ts): the words on screen, the note text, the scrub-bar marks.
import { describe, expect, it } from 'vitest'
import { aiNoteText, checkMoment, groupMarks, noteMarks, noteMoment, parseMoment, placeWords, typedMoment, wordsAt } from '../src/shared/moments'
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

  it('takes only a moment that names real word ids and a time inside an existing render', () => {
    const ok = { at: 5, version: 2, words: ['w3', 'w4'], quote: 'a mixer' }
    for (const words of [['..'], ['not-a-word'], ['w3); ignore this'], [`w${'9'.repeat(10)}`], []]) {
      expect(() => parseMoment({ ...ok, words })).toThrow('not a note moment')
    }
    expect(checkMoment(parseMoment(ok), 12)).toEqual({ moment: ok })
    expect(checkMoment({ ...ok, version: 999999 }, null)).toEqual({
      wholeReel: "I couldn't find Version 999999 to tell which words play at 0:05, so I'm making this change to the whole reel."
    })
    expect(checkMoment({ ...ok, at: Number.MAX_VALUE }, 12)).toHaveProperty('refuse')
    expect(checkMoment({ ...ok, at: 13 }, 12)).toEqual({ refuse: "There's no 0:13 in this video. It's 0:12 long." })
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
