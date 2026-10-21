// The marks on the scrub bar, read back from the chat (shared/moments.ts).
import { describe, expect, it } from 'vitest'
import { groupMarks, momentNote, noteMarks, noteMoment } from '../src/shared/moments'
import type { ChatMessage } from '../src/shared/api'

const you = (id: string, text: string): ChatMessage => ({ id, from: 'you', text, at: '' })
const editor = (id: string, text: string, version?: number): ChatMessage => ({ id, from: 'editor', text, at: '', version })

describe('notes asked at a moment', () => {
  it('carries the time in the note text', () => {
    expect(momentNote(74.4, 'cut this part')).toBe('At 1:14: cut this part')
    expect(noteMoment('At 1:14: cut this part')).toBe(74)
    expect(noteMoment('cut the part at 1:14')).toBeNull()
  })

  it('marks each one done, failed or being made', () => {
    const chat = [
      editor('a', 'Your video is ready.', 1),
      you('b', 'At 0:03: cut this part'),
      editor('c', 'I cut it.', 2),
      you('d', 'Make the subtitles bigger'),
      editor('e', 'Bigger now.', 3),
      you('f', 'At 0:09: zoom in here'),
      editor('g', 'I looked, but I was not sure what to change.', 3),
      you('h', 'At 0:11: quieter music here')
    ]
    expect(noteMarks(chat, true)).toEqual([
      { id: 'b', at: 3, text: 'cut this part', state: 'done' },
      { id: 'f', at: 9, text: 'zoom in here', state: 'failed' },
      { id: 'h', at: 11, text: 'quieter music here', state: 'making' }
    ])
    // stopped: no reply and nothing running
    expect(noteMarks(chat, false)[2].state).toBe('failed')
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
