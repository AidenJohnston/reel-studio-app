// The live subtitle preview sizes and breaks lines with the engine's rule (shared/caption-fit.ts, a port of
// engine/reelengine/captions.py `fit`). The expected results below are what captions.fit returns for the
// same text and the same stand-in measurer, so the two cannot drift apart unnoticed.
import { describe, expect, it } from 'vitest'
import { SAFE_WIDTH, SIZE_PER_EM, fitCaption, type Measure } from '../src/shared/caption-fit'

// Each character 0.6 em wide, a space 0.25 em, em = size / 1.562; the same function was handed to captions.fit.
const measure: Measure = (text, size, outline) => [...text].reduce((w, ch) => w + (ch === ' ' ? 0.25 : 0.6), 0) * (size / 1.562) + 2 * outline
const SAFE = SAFE_WIDTH // 877.2, captions.render_ass at 1080 wide

const ENGINE: [text: string, base: number, outline: number, size: number, lines: string[]][] = [
  ['HI', 105, 8, 105, ['HI']],
  ['PLACEHOLDER TEXT FROM', 105, 8, 105, ['PLACEHOLDER TEXT FROM']],
  // walkthrough 16: Big subtitles shrink to stay on one line; the old preview wrapped and split "PLACEHOLDE / R"
  ['PLACEHOLDER TEXT FROM', 140, 8, 113, ['PLACEHOLDER TEXT FROM']],
  ['INTERNATIONALIZATION', 140, 8, 112, ['INTERNATIONALIZATION']],
  ['A VERY LONG LINE OF WORDS', 140, 18, 99, ['A VERY LONG LINE OF WORDS']],
  ['SUPERCALIFRAGILISTIC EXPIALIDOCIOUS', 140, 8, 112, ['SUPERCALIFRAGILISTIC', 'EXPIALIDOCIOUS']],
  ['ONE TWO THREE FOUR FIVE SIX SEVEN', 140, 8, 137, ['ONE TWO THREE FOUR', 'FIVE SIX SEVEN']],
  ['WWWWWWWWWWWWWWWWW WWWWWWWWWWWWWWWWWWWWW WW', 140, 8, 95, ['WWWWWWWWWWWWWWWWW', 'WWWWWWWWWWWWWWWWWWWWW WW']],
  // one line would end just under 62% of the size (Boxed 59 of 96, Clean 65 of 105, Bold pop 78 of 126): wrap instead
  ['WWWWWWWWWWWW WWWWWWWWWWWW WWWWWWWWWWWW', 96, 18, 89, ['WWWWWWWWWWWW', 'WWWWWWWWWWWW WWWWWWWWWWWW']],
  ['WWWWWWWWWWWWWWWWW WWWWWWWWWWWWWWWWW', 105, 8, 105, ['WWWWWWWWWWWWWWWWW', 'WWWWWWWWWWWWWWWWW']],
  ['WWWWWWWWWWWWWW WWWWWWWWWWWWWW', 126, 12, 126, ['WWWWWWWWWWWWWW', 'WWWWWWWWWWWWWW']]
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
