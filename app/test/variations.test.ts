import { describe, expect, it } from 'vitest'
import { variations } from '../src/shared/variations'

const reel = (cutStyle?: { preset: 'clean' | 'standard' | 'hyper' | 'punchline'; seed: number }) => ({ cutStyle })
/** Math.random stand-in: the same seed three times, then others. */
const repeating = (...values: number[]) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] / 2 ** 31
}

describe('versions to compare', () => {
  it("fails if a variation sets anything but the pace, or offers the reel's own pace again", () => {
    const list = variations(reel({ preset: 'standard', seed: 7 }), 'paces')!
    expect(list.map((v) => v.edit.set.map((s) => s.path.join('.')))).toEqual([['cutStyle'], ['cutStyle']])
    expect(list.map((v) => (v.edit.set[0].value as { preset: string }).preset)).toEqual(['clean', 'hyper'])
    expect(list.every((v) => !v.edit.items.length && !v.edit.words.cut.length && !v.edit.words.keep.length && !v.edit.mirror.length && !v.edit.joins.length)).toBe(true)
    // a reel with no pace gets all three
    expect(variations(reel(), 'paces')!.map((v) => (v.edit.set[0].value as { preset: string }).preset)).toEqual(['clean', 'standard', 'hyper'])
  })

  it("fails if a set of moments reuses the reel's seed or repeats a seed, or the line does not log the seed", () => {
    const list = variations(reel({ preset: 'hyper', seed: 5 }), 'moments', [], repeating(5, 9, 9, 12, 30))!
    const seeds = list.map((v) => (v.edit.set[0].value as { seed: number }).seed)
    expect(seeds).toEqual([9, 12, 30])
    expect(list.map((v) => (v.edit.set[0].value as { preset: string }).preset)).toEqual(['hyper', 'hyper', 'hyper'])
    expect(list[0].summary).toBe('Variation: Fast pace, moments 1 of 3 (seed 9)')
    expect(variations(reel(), 'moments')).toBeNull()
  })
})

describe('one-thing variations beyond the pace', () => {
  const w = (id: string, word: string, s: number) => ({ id, w: word, s, e: s + 0.3, source: 's1' })
  const words = [
    w('a', 'Bread', 0), w('b', 'is', 0.4), w('c', 'easy.', 0.8),
    ...Array.from({ length: 10 }, (_, i) => w(`n${i}`, `word${i}`, 1.5 + i * 0.4))
  ]
  const reel = { cut: { keep: [{ from: 'a', to: 'n9' }] }, cover: { atSourceTime: 1.6, source: 's1', text: null } } as any

  it('fails if brightness is not 8% each way from the reel’s own exposure, or sets anything else', () => {
    // at the brightest a reel can be, only the darker one is offered (the brighter would be refused when queued)
    expect(variations({ ...reel, exposure: 8 }, 'brightness')!.map((v) => v.edit.set[0].value)).toEqual([7.36])
    const list = variations({ ...reel, exposure: 1.25 }, 'brightness')!
    expect(list.map((v) => v.edit.set)).toEqual([[{ path: ['exposure'], value: 1.35 }], [{ path: ['exposure'], value: 1.15 }]])
    expect(list.map((v) => v.summary)).toEqual(['Variation: 8% brighter', 'Variation: 8% darker'])
  })

  it('fails if the hook variation cuts anything but the first sentence, or offers one that would leave too little', () => {
    const [v] = variations(reel, 'hook', words)!
    expect(v.edit.words).toEqual({ cut: ['a', 'b', 'c'], keep: [] })
    expect(v.summary).toBe('Variation: opens on “word0 word1 word2 word3 word4 word5…”')
    // a reel whose first sentence is most of it has no second line to open on
    expect(variations(reel, 'hook', words.slice(0, 6))).toBeNull()
  })

  it('fails if another cover lands next to the reel’s own', () => {
    const [v] = variations(reel, 'cover', words)!
    const at = v.edit.set.find((s) => s.path.join('.') === 'cover.atSourceTime')!.value as number
    expect(Math.abs(at - 1.6)).toBeGreaterThanOrEqual(2)
    expect(v.edit.set).toContainEqual({ path: ['cover', 'source'], value: 's1' })
  })
})
