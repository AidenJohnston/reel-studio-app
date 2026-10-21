// Notes asked at a moment (shared/moments.ts): the words on screen, the note text, the scrub-bar marks.
import { describe, expect, it } from 'vitest'
import { groupMarks, momentNote, noteMarks, noteMoment, typedMoment, wordsAt } from '../src/shared/moments'
import type { ChatMessage, Word } from '../src/shared/api'

const you = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, from: 'you', text, at: '', ...extra })
const editor = (id: string, text: string, version?: number): ChatMessage => ({ id, from: 'editor', text, at: '', version })

describe('notes asked at a moment', () => {
  it('finds the words on screen through the segments of the render being watched', () => {
    // 100 words of 0.2 s, 0.3 s apart. This render cut source 10-20 s, so output 15 s is source 25 s (w50).
    const words: Word[] = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i * 0.5, e: i * 0.5 + 0.2, source: 's1' }))
    const segments = [
      { source: 's1', src_start: 0, src_end: 10, out_start: 0 },
      { source: 's1', src_start: 20, src_end: 50, out_start: 10 }
    ]
    expect(wordsAt(segments, words, 15).map((w) => w.id)).toEqual(['w48', 'w49', 'w50', 'w51', 'w52'])
  })

  it('names the moment in the note text, once', () => {
    const note = momentNote(74.4, [{ id: 'w3', w: 'a (big)' }, { id: 'w4', w: 'mixer' }], 'cut this part')
    expect(note).toBe('At 1:14 (around "a big mixer", words w3, w4): cut this part')
    expect(noteMoment(note)).toBe(74)
    expect(typedMoment('At 1:00: zoom in here')).toEqual({ at: 60, rest: 'zoom in here' })
  })

  it('marks each note by its own job, never by the reply to a later note', () => {
    const chat = [
      editor('a', 'Your video is ready.', 1),
      you('b', 'At 0:03 (around "x", words w1): cut this part', { jobId: 'j1', outcome: 'stopped' }),
      you('c', 'At 0:09 (around "y", words w9): zoom in here', { jobId: 'j2', outcome: 'done' }),
      editor('d', 'I zoomed in.', 2),
      you('e', 'At 0:11 (around "z", words w11): quieter music here', { jobId: 'j3' }),
      // from before outcomes were recorded: its reply made no new version
      you('f', 'At 0:12: bigger', {}),
      editor('g', 'I looked, but I was not sure what to change.', 2)
    ]
    expect(noteMarks(chat, 'j3').map((m) => [m.id, m.text, m.state])).toEqual([
      ['b', 'cut this part', 'stopped'],
      ['c', 'zoom in here', 'done'],
      ['e', 'quieter music here', 'making'],
      ['f', 'bigger', 'failed']
    ])
    // j3 ended without recording how (the app quit): stopped
    expect(noteMarks(chat, null)[2].state).toBe('stopped')
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
