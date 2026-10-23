import { describe, expect, it } from 'vitest'
import { PLATFORM_RULES, checkPlatform, secondTryPlatforms } from '../src/shared/platforms'

const captionIssue = (...args: Parameters<typeof checkPlatform>) => checkPlatform(...args).find((issue) => issue.kind === 'caption')
const durationIssue = (...args: Parameters<typeof checkPlatform>) => checkPlatform(...args).find((issue) => issue.kind === 'duration')

describe('platform export rules', () => {
  it('fails if a TikTok caption over the documented 2200 UTF-16 characters gets no warning', () => {
    expect(captionIssue('tiktok', 'x'.repeat(2200), 30)).toBeUndefined()
    expect(captionIssue('tiktok', 'x'.repeat(2201), 30)).toBeDefined()
  })

  it('fails if Shorts lose the current three-minute limit, in either direction', () => {
    expect(durationIssue('youtube', 'A Short', 70)).toBeUndefined()
    expect(durationIssue('youtube', 'A Short', 181)).toBeDefined()
  })

  it('flags a YouTube description that fits 5000 characters but exceeds 5000 UTF-8 bytes', () => {
    expect(captionIssue('youtube', 'é'.repeat(2501), 30)).toBeDefined()
  })

  it('fails if Threads counts every character by bytes instead of only emoji', () => {
    expect(captionIssue('threads', 'é'.repeat(400), 30)).toBeUndefined()
    expect(captionIssue('threads', '😀'.repeat(126), 30)).toBeDefined()
  })

  it('flags Instagram captions with more than 30 hashtags, including adjacent tags', () => {
    expect(checkPlatform('instagram', '#reel'.repeat(31), 30).some((issue) => issue.kind === 'hashtags')).toBe(true)
  })

  it('fails if X stops trimming punctuation after a short link', () => {
    expect(captionIssue('x', `https://x.co/a${'!'.repeat(257)}`, 30)).toBeUndefined()
    expect(captionIssue('x', `https://x.co/a${'!'.repeat(258)}`, 30)).toBeDefined()
  })

  it('fails if X counts a long link by its length instead of 23', () => {
    expect(captionIssue('x', `https://example.com/${'a'.repeat(100)} ${'b'.repeat(256)}`, 30)).toBeUndefined()
  })

  it('fails if an e-mail address or a link\'s #fragment counts as an Instagram mention or hashtag', () => {
    const emails = Array.from({ length: 21 }, (_, i) => `person${i}@example.com`).join(' ')
    const links = Array.from({ length: 31 }, (_, i) => `https://example.com/page#part${i}`).join(' ')
    expect(checkPlatform('instagram', emails, 30).some((issue) => issue.kind === 'mentions')).toBe(false)
    expect(checkPlatform('instagram', links, 30).some((issue) => issue.kind === 'hashtags')).toBe(false)
  })

  it('fails if X counts a decomposed é as two characters instead of normalizing it first', () => {
    expect(captionIssue('x', 'e\u0301'.repeat(141), 30)).toBeUndefined()
  })

  it('fails if an Instagram caption contains more than 20 mentions', () => {
    const caption = Array.from({ length: 21 }, (_, index) => `@person${index}`).join(' ')
    expect(checkPlatform('instagram', caption, 30).some((issue) => issue.kind === 'mentions')).toBe(true)
  })

  it('fails if a platform without a test option gets Try 2, or Facebook gets a Try 2 with a different video', () => {
    const all = PLATFORM_RULES.map((rule) => rule.id)
    expect(secondTryPlatforms(all, true)).toEqual(['instagram', 'facebook'])
    expect(secondTryPlatforms(all, false)).toEqual(['instagram'])
  })
})
