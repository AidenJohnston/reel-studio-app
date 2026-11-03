// The live subtitle preview sizes and breaks lines with the engine's rule (shared/caption-fit.ts, a port of
// engine/reelengine/captions.py `fit`). The expected results below are what captions.fit returns for the
// same text and the same stand-in measurer, so the two cannot drift apart unnoticed.
import { describe, expect, it } from 'vitest'
import { MARGIN_FRAC, SIZE_PER_EM, fitCaption, type Measure } from '../src/shared/caption-fit'

// Each character 0.6 em wide, a space 0.25 em, em = size / 1.562; the same function was handed to captions.fit.
const measure: Measure = (text, size, outline) => [...text].reduce((w, ch) => w + (ch === ' ' ? 0.25 : 0.6), 0) * (size / 1.562) + 2 * outline
const SAFE = 1080 * (1 - 2 * MARGIN_FRAC) // 939.6, captions.render_ass at 1080 wide

const ENGINE: [text: string, base: number, outline: number, size: number, lines: string[]][] = [
  ['HI', 105, 8, 105, ['HI']],
  ['PLACEHOLDER TEXT FROM', 105, 8, 105, ['PLACEHOLDER TEXT FROM']],
  // walkthrough 16: Big subtitles shrink to stay on one line; the old preview wrapped and split "PLACEHOLDE / R"
  ['PLACEHOLDER TEXT FROM', 140, 8, 121, ['PLACEHOLDER TEXT FROM']],
  ['INTERNATIONALIZATION', 140, 8, 120, ['INTERNATIONALIZATION']],
  ['A VERY LONG LINE OF WORDS', 140, 18, 107, ['A VERY LONG LINE OF WORDS']],
  ['SUPERCALIFRAGILISTIC EXPIALIDOCIOUS', 140, 8, 120, ['SUPERCALIFRAGILISTIC', 'EXPIALIDOCIOUS']],
  ['ONE TWO THREE FOUR FIVE SIX SEVEN', 140, 8, 140, ['ONE TWO THREE FOUR', 'FIVE SIX SEVEN']],
  ['WWWWWWWWWWWWWWWWW WWWWWWWWWWWWWWWWWWWWW WW', 140, 8, 103, ['WWWWWWWWWWWWWWWWW', 'WWWWWWWWWWWWWWWWWWWWW WW']]
]

describe('caption fit', () => {
  for (const [text, base, outline, size, lines] of ENGINE) {
    it(`${text} at ${base}: as the engine`, () => {
      expect(fitCaption(text, base, SAFE, outline, measure)).toEqual({ size, lines })
    })
  }

  it('only ever breaks between words', () => {
    for (const [text, base, outline] of ENGINE) {
      const { lines } = fitCaption(text, base, SAFE, outline, measure)
      expect(lines.join(' ')).toBe(text)
      for (const line of lines) expect(text.split(' ')).toEqual(expect.arrayContaining(line.split(' ')))
    }
  })

  it('uses the subtitle face metrics the engine reads (Montserrat SemiBold, winAscent 1109 + winDescent 453)', () => {
    expect(SIZE_PER_EM).toBeCloseTo(1.562, 6)
  })
})
