import { describe, expect, it } from 'vitest'
import type { Measure } from '../src/shared/caption-fit'
import { CAPTION_PRESETS, applyPreset, fitLook, lookFromStyle, presetOf } from '../src/shared/caption-presets'

describe('caption presets', () => {
  it('picking a look writes exactly its documented style fields', () => {
    const base = { font: 'Montserrat SemiBold', outlineColor: '#000000', shadow: 0, position: 0.75 }
    expect(CAPTION_PRESETS.map((p) => applyPreset(p.key))).toEqual([
      { ...base, preset: 'clean', size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8 },
      { ...base, preset: 'bold-pop', size: 126, maxWords: 2, case: 'upper', color: '#FFFFFF', outline: 12, pop: true },
      { ...base, preset: 'karaoke', size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, highlight: '#FFD60A' },
      { ...base, preset: 'boxed', size: 96, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, box: true },
      { ...base, preset: 'minimal', size: 84, maxWords: 4, case: 'lower', color: '#FFFFFF', outline: 5 }
    ])
  })

  it('a reel keeps its look through fine-tuning, and reels made before presets open on the look they have', () => {
    expect(presetOf({ ...applyPreset('karaoke'), size: 126, position: 0.66 })).toBe('karaoke')
    // engine/reelengine/project.py DEFAULT_CAPTION_STYLE, the style every older reel was made with
    const older = { preset: 'bold-lower', font: 'Montserrat SemiBold', size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 0, position: 0.75 }
    expect(presetOf(older)).toBe('clean')
    expect(presetOf({ ...older, box: true })).toBe('boxed')
    expect(presetOf({ ...older, color: '#FFD60A' })).toBeNull()
  })

  // The same stand-in measurer was handed to engine captions.fit (with captions.apply_case and, for a box,
  // the outline raised to BOX_PAD as render_ass does); these are its results at 1080 wide.
  const measure: Measure = (text, size, outline) => [...text].reduce((w, ch) => w + (ch === ' ' ? 0.25 : 0.6), 0) * (size / 1.562) + 2 * outline
  const ENGINE: Record<string, { size: number; lines: string[] }> = {
    clean: { size: 67, lines: ['INTERNATIONALIZATION EVERYWHERE TODAY'] },
    'bold-pop': { size: 119, lines: ['INTERNATIONALIZATION', 'EVERYWHERE TODAY'] },
    karaoke: { size: 67, lines: ['INTERNATIONALIZATION EVERYWHERE TODAY'] },
    boxed: { size: 66, lines: ['INTERNATIONALIZATION EVERYWHERE TODAY'] },
    minimal: { size: 67, lines: ['internationalization everywhere today'] }
  }

  it('the preview sizes and breaks each look\'s line where the engine does', () => {
    for (const p of CAPTION_PRESETS) {
      expect([p.key, fitLook(lookFromStyle(applyPreset(p.key)), 'Internationalization everywhere today', measure)]).toEqual([p.key, ENGINE[p.key]])
    }
  })
})
