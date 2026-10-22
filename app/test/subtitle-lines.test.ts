import { describe, expect, it } from 'vitest'
import { readCaptionLines, retype, setBreak, subtitleLines, type LineToken } from '../src/shared/subtitle-lines'

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
const kept = new Set(['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'])
const saved = { enabled: true, split: ['w4'] }
const text = (lines: LineToken[][]) => lines.map((l) => l.map((t) => t.shown).join(' '))

describe('subtitle lines', () => {
  it('shows an Enter or a join where the next version will put it, and never joins across a long pause', () => {
    const enter = setBreak(saved, 'w1', true)
    expect(text(subtitleLines(rendered, kept, saved, enter))).toEqual(['I', 'use cloud', 'for', 'everything,', 'TypeScript', 'too.'])
    const backspace = setBreak(enter, 'w4', false)
    expect(backspace).toEqual({ enabled: true, split: ['w1'] })
    expect(text(subtitleLines(rendered, kept, saved, backspace))).toEqual(['I', 'use cloud', 'for everything,', 'TypeScript', 'too.'])
    const across = setBreak(backspace, 'w7', false)
    expect(text(subtitleLines(rendered, kept, saved, across))).toEqual(['I', 'use cloud', 'for everything,', 'TypeScript', 'too.'])
  })

  it('typing over a word fixes the words the engine drew it from, and typing it back undoes the fix', () => {
    const [line] = subtitleLines(rendered.slice(3, 4), kept, saved, saved)
    const fixes = retype(line, [], [], 'Typescript')
    expect(fixes).toEqual([
      { from: 'TypeScript', to: 'Typescript', at: 'w5' },
      { from: 'TypeScript', to: '', at: 'w6' }
    ])
    const [fixedLine] = subtitleLines(rendered.slice(3, 4), kept, saved, { ...saved, corrections: fixes })
    expect(fixedLine.map((t) => t.shown)).toEqual(['Typescript'])
    expect(retype(fixedLine, fixes, [], 'TypeScript')).toEqual([])
    // a fix the last version already drew comes back when its word is typed back as drawn
    const drawn = [{ from: 'cloud', to: 'Claude', at: 'w2' }]
    const [first] = subtitleLines([[{ w: 'Claude', ids: ['w2'], run: 0 }]], kept, { enabled: true, corrections: drawn }, { enabled: true, corrections: drawn })
    const claudia = retype(first, drawn, drawn, 'Claudia')
    expect(claudia).toEqual([{ from: 'Claude', to: 'Claudia', at: 'w2' }])
    const [typedOver] = subtitleLines([[{ w: 'Claude', ids: ['w2'], run: 0 }]], kept, { enabled: true, corrections: drawn }, { enabled: true, corrections: claudia })
    expect(retype(typedOver, claudia, drawn, 'Claude')).toEqual(drawn)
  })
})
