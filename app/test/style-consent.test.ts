import { describe, expect, it } from 'vitest'
import { rememberQuestion, styleConsent } from '../src/main/style-consent'

describe('My style consent (grandma 2: saved without asking)', () => {
  it('an AI that already saved a rule: undo it, drop the announcement, ask instead', () => {
    const summary =
      'I turned the music down at the start so your voice comes through clearly. I\'ll remember that for next time. I also saved this to My style for your future videos: "Keep music quieter under talking." You can remove it in Settings.'
    const c = styleConsent(summary, ['Keep music quieter under talking.'])
    expect(c.summary).toBe('I turned the music down at the start so your voice comes through clearly.')
    expect(c.undo).toEqual(['Keep music quieter under talking.'])
    expect(c.suggestions).toEqual(['Keep music quieter under talking.'])
    expect(rememberQuestion(c.suggestions[0])).toBe('Remember this for next time? "Keep music quieter under talking."')
  })

  it('an AI that only proposes (styleSuggestions): nothing to undo', () => {
    const c = styleConsent('I made the captions smaller.', [], ['Smaller captions'])
    expect(c).toEqual({ summary: 'I made the captions smaller.', suggestions: ['Smaller captions'], undo: [] })
  })

  it('the quality2 shape: styleSuggestions always present (often []), nothing saved', () => {
    expect(styleConsent('I made the captions a bit smaller.', [], [])).toEqual({ summary: 'I made the captions a bit smaller.', suggestions: [], undo: [] })
    // mixed (a rule saved anyway): still undone and asked, once
    expect(styleConsent('x', ['A'], ['A', 'B'])).toEqual({ summary: 'x', suggestions: ['A', 'B'], undo: ['A'] })
  })

  it('no rules: the reply is untouched', () => {
    expect(styleConsent('I made the captions a bit smaller.')).toEqual({ summary: 'I made the captions a bit smaller.', suggestions: [], undo: [] })
  })
})
