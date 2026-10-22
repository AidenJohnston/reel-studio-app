import { describe, expect, it } from 'vitest'
import { previewText, readCaptionLines, retype, setBreak, subtitleLines, type LineToken } from '../src/shared/subtitle-lines'

// work/captions.json as the engine writes it: a line split at w4 ("for" / "everything,"), "type script"
// corrected to one word, and a long pause before the last line (a new speech run).
const captionsJson = {
  cues: [
    { run: 0, text: 'I USE CLOUD', tokens: [{ w: 'I', ids: ['w0'] }, { w: 'use', ids: ['w1'] }, { w: 'cloud', ids: ['w2'] }] },
    { run: 0, text: 'FOR', tokens: [{ w: 'for', ids: ['w3'] }] },
    { run: 0, text: 'EVERYTHING', tokens: [{ w: 'everything,', ids: ['w4'] }] },
    { run: 0, text: 'TYPESCRIPT', tokens: [{ w: 'TypeScript', ids: ['w5', 'w6'] }] },
    { run: 1, text: 'TOO', tokens: [{ w: 'too.', ids: ['w7'] }] }
  ]
}
const rendered = readCaptionLines(captionsJson)
// the transcript: what was heard at each word
const heard = new Map(['I', 'use', 'cloud', 'for', 'everything,', 'type', 'script', 'too.'].map((w, i) => [`w${i}`, w]))
const kept = new Set(heard.keys())
const saved = { enabled: true, split: ['w4'] }
const text = (lines: LineToken[][]) => lines.map((l) => l.map((t) => t.shown).join(' '))

describe('subtitle lines', () => {
  it('shows an Enter or a join where the next version will put it, and never joins across a long pause', () => {
    const enter = setBreak(saved, 'w1', true)
    expect(text(subtitleLines(rendered, kept, saved, enter, heard))).toEqual(['I', 'use cloud', 'for', 'everything,', 'TypeScript', 'too.'])
    const backspace = setBreak(enter, 'w4', false, 'w3')
    expect(backspace).toEqual({ enabled: true, split: ['w1'] })
    expect(text(subtitleLines(rendered, kept, saved, backspace, heard))).toEqual(['I', 'use cloud', 'for everything,', 'TypeScript', 'too.'])
    // a join remembers the line it went onto, so a recut that takes that line away lets it go
    const join = setBreak(backspace, 'w5', false, 'w4')
    expect(join).toEqual({ enabled: true, split: ['w1'], join: [{ from: 'w4', to: 'w5' }] })
    expect(text(subtitleLines(rendered, kept, saved, join, heard))).toEqual(['I', 'use cloud', 'for everything, TypeScript', 'too.'])
    expect(setBreak(join, 'w5', true)).toEqual({ enabled: true, split: ['w1'], join: [] })
    const across = setBreak(backspace, 'w7', false, 'w6')
    expect(text(subtitleLines(rendered, kept, saved, across, heard))).toEqual(['I', 'use cloud', 'for everything,', 'TypeScript', 'too.'])
  })

  it('typing over a line fixes exactly the words that changed, as heard, and typing one back undoes its fix', () => {
    const line: LineToken[] = [
      { w: 'I', ids: ['w0'], run: 0, shown: 'I' },
      { w: 'TypeScript Pro.', ids: ['w5', 'w6'], run: 0, shown: 'TypeScript Pro.' },
      { w: 'too.', ids: ['w7'], run: 0, shown: 'too.' }
    ]
    expect(retype(line, [], [], 'I TypeScript Pro. rocks.', heard)).toEqual([{ from: 'too.', to: 'rocks.', at: 'w7' }])
    const fixes = retype(line, [], [], 'I Typescript too.', heard)
    expect(fixes).toEqual([{ from: 'type script', to: 'Typescript', at: 'w5', through: 'w6' }])
    const [fixedLine] = subtitleLines([line], kept, saved, { ...saved, corrections: fixes }, heard)
    expect(fixedLine.map((t) => t.shown)).toEqual(['I', 'Typescript', 'too.'])
    expect(retype(fixedLine, fixes, [], 'I TypeScript Pro. too.', heard)).toEqual([])
  })

  it('a word taken off the subtitles can come back', () => {
    const lines = [[{ w: '', ids: ['w1'], run: 0 }, { w: 'cloud', ids: ['w2'], run: 0 }]]
    const off = { enabled: true, corrections: [{ from: 'use', to: '', at: 'w1' }] }
    expect(text(subtitleLines(lines, kept, off, off, heard))).toEqual(['cloud'])
    expect(text(subtitleLines(lines, kept, off, { enabled: true, corrections: [] }, heard))).toEqual(['use cloud'])
  })

  it('cleans a line for the phone preview as the engine cleans a caption (captions.cue_text)', () => {
    expect(previewText('¿Listo para esto…')).toBe('Listo para esto')
    expect(previewText('"(Quote) it.")')).toBe('Quote) it')
  })
})
