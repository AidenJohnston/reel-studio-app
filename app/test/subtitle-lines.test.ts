import { describe, expect, it } from 'vitest'
import type { Word } from '../src/shared/api'
import { retype, setBreak, subtitleLines, wordText } from '../src/shared/subtitle-lines'

const words: Word[] = 'I use cloud for everything , type script too'.split(' ').map((w, i) => ({ id: `w${i}`, w, s: i, e: i + 0.8, source: 's1' }))
const kept = new Set(words.map((w) => w.id))
// work/captions.json of the last render, which had a line split at w4 ("for" / "everything ,")
const rendered = [['w0', 'w1', 'w2'], ['w3'], ['w4', 'w5'], ['w6', 'w7', 'w8']]
const saved = { enabled: true, split: ['w4'] }
const text = (lines: Word[][]) => lines.map((l) => l.map((w) => w.w).join(' '))

describe('subtitle lines', () => {
  it('shows an Enter or a join where the next version will put it, and joining a saved split takes it away', () => {
    const enter = setBreak(saved, 'w1', true)
    expect(text(subtitleLines(rendered, words, kept, saved, enter))).toEqual(['I', 'use cloud', 'for', 'everything ,', 'type script too'])
    const backspace = setBreak(enter, 'w4', false)
    expect(backspace).toEqual({ enabled: true, split: ['w1'] })
    expect(text(subtitleLines(rendered, words, kept, saved, backspace))).toEqual(['I', 'use cloud', 'for everything ,', 'type script too'])
    const join = setBreak(backspace, 'w6', false)
    expect(join).toEqual({ enabled: true, split: ['w1'], join: ['w6'] })
    expect(text(subtitleLines(rendered, words, kept, saved, join))).toEqual(['I', 'use cloud', 'for everything , type script too'])
  })

  it('typing over a line fixes just the words that changed, and typing a word back undoes its fix', () => {
    const line = words.slice(6, 9)
    let fixes = retype(line, [], 'TypeScript too')
    expect(fixes).toEqual([{ from: 'type', to: 'TypeScript', at: 'w6' }, { from: 'script', to: '', at: 'w7' }])
    expect(line.map((w) => wordText(w, fixes))).toEqual(['TypeScript', '', 'too'])
    fixes = retype(line, fixes, 'type script too')
    expect(fixes).toEqual([])
    // a whole-reel correction already shows; retyping what it shows is no fix
    const everywhere = [{ from: 'cloud', to: 'Claude' }]
    expect(retype(words.slice(0, 3), everywhere, 'I use Claude')).toEqual(everywhere)
    expect(retype(words.slice(0, 3), everywhere, 'I use cloud')).toEqual([...everywhere, { from: 'cloud', to: 'cloud', at: 'w2' }])
  })
})
