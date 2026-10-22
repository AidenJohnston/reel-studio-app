import { describe, expect, it } from 'vitest'
import { checkPlatform, renderGroups } from '../src/shared/platforms'

describe('platform export rules', () => {
  it('fails if a TikTok caption exceeds the documented 2200 UTF-16 character limit', () => {
    const issues = checkPlatform('tiktok', 'x'.repeat(2201), 30)
    expect(issues.find((issue) => issue.kind === 'caption')?.blocking).toBe(true)
  })

  it('uses the current three-minute Shorts limit, so a 70 second Short is not rejected for duration', () => {
    expect(checkPlatform('youtube', 'A Short', 70).some((issue) => issue.kind === 'duration')).toBe(false)
  })

  it('fails if a video over three minutes is offered as a Short', () => {
    expect(checkPlatform('youtube', 'A Short', 181).some((issue) => issue.kind === 'duration')).toBe(true)
  })

  it('reuses one render when selected platforms have the same export spec', () => {
    const groups = renderGroups(['instagram', 'tiktok', 'facebook'], 30)
    expect(groups).toHaveLength(1)
    expect(groups[0].platforms).toEqual(['instagram', 'tiktok', 'facebook'])
  })

  it('flags a YouTube description that fits 5000 characters but exceeds 5000 UTF-8 bytes', () => {
    expect(checkPlatform('youtube', 'é'.repeat(2501), 30).some((issue) => issue.kind === 'caption')).toBe(true)
  })

  it('flags Instagram captions with more than 30 hashtags, including adjacent tags', () => {
    expect(checkPlatform('instagram', '#reel'.repeat(31), 30).some((issue) => issue.kind === 'hashtags')).toBe(true)
  })

  it('fails if X treats trailing punctuation as part of the shortened URL allowance', () => {
    expect(checkPlatform('x', `https://example.com/${'!'.repeat(280)}`, 30).some((issue) => issue.kind === 'caption')).toBe(true)
  })

  it('fails if X accepts a short URL plus text beyond its weighted 280-character budget', () => {
    expect(checkPlatform('x', `https://x.com/ ${'a'.repeat(265)}`, 30).some((issue) => issue.kind === 'caption')).toBe(true)
  })

  it('fails if an Instagram caption contains more than 20 mentions', () => {
    const caption = Array.from({ length: 21 }, (_, index) => `@person${index}`).join(' ')
    expect(checkPlatform('instagram', caption, 30).some((issue) => issue.kind === 'mentions')).toBe(true)
  })
})
