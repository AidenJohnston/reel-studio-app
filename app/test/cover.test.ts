import { describe, expect, it } from 'vitest'
import { coverMoments, coverReason } from '../src/shared/cover'

describe('cover suggestions', () => {
  it('names only the signals where the frame beat its neighbours, in the scorer weight order, two at most', () => {
    expect(coverReason({ eyesOpen: 1, sharp: 1, still: 1, betweenWords: true })).toBe('Eyes open, face in focus')
    expect(coverReason({ eyesOpen: 0.8, sharp: 0.99, still: 1, betweenWords: true })).toBe('Between words, holding still')
    expect(coverReason({ eyesOpen: 0.9, sharp: 0.9, still: 0.9, betweenWords: false })).toBe('Clearest face nearby')
  })

  it('spreads moments over the kept words of one source, never closer than the engine search windows', () => {
    const words = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, w: 'x', s: i * 0.5, e: i * 0.5 + 0.4, source: 's1' }))
    const kept = new Set(words.filter((w) => w.s < 2 || w.s >= 6).map((w) => w.id))
    words.push({ id: 'b0', w: 'y', s: 3, e: 3.4, source: 's2' })
    kept.add('b0')
    expect(coverMoments(words, kept, 's1')).toEqual([0.5, 6.5, 8.5, 10, 12, 14])
    // fewer words than moments: every word, minus the ones too close to the last
    expect(coverMoments(words.slice(0, 4), kept, 's1')).toEqual([0, 1.5])
  })
})
