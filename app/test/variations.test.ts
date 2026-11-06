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
    const list = variations(reel({ preset: 'hyper', seed: 5 }), 'moments', repeating(5, 9, 9, 12, 30))!
    const seeds = list.map((v) => (v.edit.set[0].value as { seed: number }).seed)
    expect(seeds).toEqual([9, 12, 30])
    expect(list.map((v) => (v.edit.set[0].value as { preset: string }).preset)).toEqual(['hyper', 'hyper', 'hyper'])
    expect(list[0].summary).toBe('Variation: Fast pace, moments 1 of 3 (seed 9)')
    expect(variations(reel(), 'moments')).toBeNull()
  })
})
