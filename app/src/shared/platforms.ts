export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'facebook' | 'threads' | 'x' | 'linkedin'

export interface PlatformRule {
  id: Platform
  label: string
  minSeconds?: number
  maxSeconds: number
  maxBytes: number
  maxBitrate?: number
  captionLimit: number | null
  hashtagLimit: number | null
  width: number
  height: number
  source: string
  note?: string
  /** The platform's own test of two versions of one post: Instagram trial reels test any change, Facebook only a cover or caption. */
  tryTwo?: { tests: 'video' | 'cover-caption'; steps: string; source: string }
}

// Offline targets checked 2026-10-22. Notes distinguish account-dependent and local limits.
export const PLATFORM_RULES: readonly PlatformRule[] = [
  { id: 'instagram', label: 'Instagram Reels', minSeconds: 3, maxSeconds: 900, maxBytes: 300_000_000, maxBitrate: 25_000_000, captionLimit: 2200, hashtagLimit: 30, width: 1080, height: 1920, source: 'https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media',
    tryTwo: { tests: 'video', source: 'https://creators.instagram.com/blog/instagram-trial-reels', steps: "Post each video as a trial reel. Before you share, turn on Trial and leave automatic sharing off. Instagram shows trial reels to people who don't follow you first. After about a day, compare their views, then tap Share with everyone on the one that did better. No Trial switch? Your account can't use trial reels yet, so post Try 1." } },
  { id: 'tiktok', label: 'TikTok', maxSeconds: 180, maxBytes: 4_000_000_000, captionLimit: 2200, hashtagLimit: null, width: 1080, height: 1920, source: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post', note: '3-minute offline target. Your account may allow more. Check its upload limit before posting.' },
  { id: 'youtube', label: 'YouTube Shorts', maxSeconds: 180, maxBytes: 256_000_000_000, captionLimit: 5000, hashtagLimit: 60, width: 1080, height: 1920, source: 'https://support.google.com/youtube/answer/15424877', note: 'The caption is a description. Add a separate title of up to 100 characters when you upload.' },
  { id: 'facebook', label: 'Facebook Reels', minSeconds: 3, maxSeconds: 90, maxBytes: 1_000_000_000, captionLimit: null, hashtagLimit: null, width: 1080, height: 1920, source: 'https://developers.facebook.com/documentation/video-api/guides/reels-publishing', note: '90-second Reels target. The current guide does not give a caption, hashtag or byte maximum; 1 GB is the local file ceiling.',
    tryTwo: { tests: 'cover-caption', source: 'https://about.fb.com/news/2023/11/helping-creators-test-content-and-earn-rewards/', steps: "In the Facebook app, make the reel with the video. Before you share, add Try 2's cover and caption as a test. Facebook shows each to part of your audience and keeps the one that does better. No test option? Post Try 1." } },
  { id: 'threads', label: 'Threads', maxSeconds: 300, maxBytes: 1_000_000_000, captionLimit: 500, hashtagLimit: null, width: 1080, height: 1920, source: 'https://developers.facebook.com/documentation/threads/posts', note: 'Only one topic becomes a linked tag. Each emoji counts as its size in bytes, usually 4.' },
  { id: 'x', label: 'X', minSeconds: 0.5, maxSeconds: 1200, maxBytes: 8_000_000_000, captionLimit: 280, hashtagLimit: null, width: 720, height: 1280, source: 'https://docs.x.com/x-api/media/quickstart/best-practices', note: 'Standard account target. Every https:// link counts as 23. Confirm the caption length in X before posting.' },
  { id: 'linkedin', label: 'LinkedIn', minSeconds: 3, maxSeconds: 1800, maxBytes: 500_000_000, captionLimit: 3000, hashtagLimit: null, width: 1080, height: 1920, source: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api', note: 'Uses the documented 500 MB video specification, below the larger multipart upload ceiling.' }
]

export function platformRule(platform: Platform): PlatformRule {
  const rule = PLATFORM_RULES.find((r) => r.id === platform)
  if (!rule) throw new Error(`Unknown export platform: ${platform}`)
  return rule
}

/** One version of the post: which Version's video, which cover and which caption. */
export interface PlatformTry {
  version: number
  caption: string
  /** Seconds into the finished video, or null for that version's own cover. */
  coverSeconds: number | null
}

export interface PlatformExportRequest {
  platforms: Platform[]
  caption: string
  /** Seconds into the finished video, or null for the project's own cover. */
  coverSeconds: number | null
  /** Try 2, for the platforms that can test two versions themselves (`secondTryPlatforms`). */
  second: PlatformTry | null
}

const validCover = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const validCaption = (value: unknown): value is string => typeof value === 'string' && value.length <= 100_000
const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

const badRequest = () => ({ code: 'BAD_EXPORT', userMessage: 'Choose at least one platform and a valid cover frame, then try again.' })

function parseSecondTry(value: unknown): PlatformTry | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || !('version' in value) || !validVersion(value.version) ||
      !('caption' in value) || !validCaption(value.caption) || !('coverSeconds' in value) || !validCover(value.coverSeconds)) throw badRequest()
  return { version: value.version, caption: value.caption, coverSeconds: value.coverSeconds }
}

/** `version` is Try 1's Version, the one being exported. */
export function parsePlatformExportRequest(value: unknown, version: number): PlatformExportRequest {
  if (!value || typeof value !== 'object' || !('platforms' in value) || !Array.isArray(value.platforms) ||
      !value.platforms.length || value.platforms.length > PLATFORM_RULES.length ||
      !value.platforms.every((p): p is Platform => typeof p === 'string' && PLATFORM_RULES.some((r) => r.id === p)) ||
      !('caption' in value) || !validCaption(value.caption) || !('coverSeconds' in value) || !validCover(value.coverSeconds) ||
      !('second' in value)) throw badRequest()
  const request: PlatformExportRequest = { platforms: [...new Set(value.platforms)], caption: value.caption, coverSeconds: value.coverSeconds, second: parseSecondTry(value.second) }
  const problem = request.second && secondTryProblem(request.platforms, { version, caption: request.caption, coverSeconds: request.coverSeconds }, request.second)
  if (problem) throw { code: 'BAD_EXPORT', userMessage: problem }
  return request
}

export type TryChange = 'video' | 'cover' | 'caption'

export function tryChanges(first: PlatformTry, second: PlatformTry): TryChange[] {
  const changes: TryChange[] = []
  if (second.version !== first.version) changes.push('video')
  if (second.coverSeconds !== first.coverSeconds) changes.push('cover')
  if (second.caption !== first.caption) changes.push('caption')
  return changes
}

/** The selected platforms that get Try 2. Every selected platform gets Try 1. */
export function secondTryPlatforms(platforms: Platform[], sameVideo: boolean): Platform[] {
  return platforms.filter((p) => {
    const test = platformRule(p).tryTwo
    return test !== undefined && (test.tests === 'video' || sameVideo)
  })
}

/** Why Try 2 cannot be exported, or null. */
export function secondTryProblem(platforms: Platform[], first: PlatformTry, second: PlatformTry): string | null {
  const changes = tryChanges(first, second)
  if (!changes.length) return 'Try 2 is the same as Try 1. Pick another version, cover or caption.'
  if (secondTryPlatforms(platforms, !changes.includes('video')).length) return null
  return changes.includes('video')
    ? 'None of these platforms can test a different video. Choose Instagram, or turn off Try two versions.'
    : 'None of these platforms can test two versions. Choose Instagram or Facebook, or turn off Try two versions.'
}

export interface ExportIssue {
  kind: 'caption' | 'hashtags' | 'mentions' | 'duration'
  message: string
  /** false: our count or limit is an estimate, so the creator decides. */
  blocking: boolean
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u
const utf8Length = (text: string): number => new TextEncoder().encode(text).length
const graphemes = (text: string): string[] => [...new Intl.Segmenter().segment(text)].map((s) => s.segment)

/** The caption length as each platform counts it against `captionLimit`. */
export function captionLength(platform: Platform, caption: string): number {
  if (platform === 'youtube') return utf8Length(caption)
  if (platform === 'threads') return graphemes(caption).reduce((n, g) => n + (EMOJI.test(g) ? utf8Length(g) : 1), 0)
  if (platform === 'x') return xWeightedLength(caption)
  return caption.length
}

export function checkPlatform(platform: Platform, caption: string, seconds: number): ExportIssue[] {
  const rule = platformRule(platform)
  const issues: ExportIssue[] = []
  const count = captionLength(platform, caption)
  if (platform === 'youtube' && /[<>]/u.test(caption)) issues.push({ kind: 'caption', blocking: true, message: 'YouTube descriptions cannot contain < or >. Remove those characters before exporting.' })
  if (rule.captionLimit !== null && count > rule.captionLimit) {
    issues.push(platform === 'x'
      ? { kind: 'caption', blocking: false, message: `Probably ${count} of ${rule.captionLimit} once links are shortened. Shorten the caption, or check it in X before posting.` }
      : { kind: 'caption', blocking: true, message: `Post caption is ${count} of ${rule.captionLimit}. Shorten it before exporting.` })
  }
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? []
  if (platform === 'instagram' && (caption.match(/@[a-zA-Z0-9_.]+/gu) ?? []).length > 20) issues.push({ kind: 'mentions', blocking: true, message: 'Instagram allows at most 20 mentions. Remove extra @mentions before exporting.' })
  if (rule.hashtagLimit !== null && tags.length > rule.hashtagLimit) issues.push({ kind: 'hashtags', blocking: true, message: `${tags.length} hashtags; use at most ${rule.hashtagLimit}.` })
  if (seconds > rule.maxSeconds) {
    issues.push(platform === 'tiktok'
      ? { kind: 'duration', blocking: false, message: `This video is ${seconds.toFixed(1)} s. Some TikTok accounts only take ${rule.maxSeconds} s; check yours before posting.` }
      : { kind: 'duration', blocking: true, message: `This video is ${seconds.toFixed(1)} s. Trim it to ${rule.maxSeconds} s or less in the Cut tab.` })
  }
  if (rule.minSeconds !== undefined && seconds < rule.minSeconds) issues.push({ kind: 'duration', blocking: true, message: `This platform needs at least ${rule.minSeconds} s of video.` })
  return issues
}

// docs.x.com/fundamentals/counting-characters: links count 23, emoji 2, and these ranges (Latin,
// punctuation, common symbols) 1; everything else 2. Links without https:// are not detected here.
const X_LIGHT: [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]

function xWeightedLength(text: string): number {
  let links = 0
  const rest = text.replace(/https?:\/\/\S+/gu, (link) => {
    links++
    return /[.,!?;:)]+$/u.exec(link)?.[0] ?? ''
  })
  return links * 23 + graphemes(rest).reduce((n, g) => n + (EMOJI.test(g)
    ? 2
    : [...g].reduce((m, ch) => m + (X_LIGHT.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b) ? 1 : 2), 0)), 0)
}

/** What `probe` reports about the finished render. */
export interface FinishedVideo {
  duration: number
  width: number
  height: number
  fps: number
  vcodec: string | null
  acodec: string | null
  pixFmt: string | null
  sizeBytes: number
}

/** The final render (H.264 High at CRF 18, AAC; engine/reelengine/render.py) can be posted as it is. */
export function usableAsIs(platform: Platform, video: FinishedVideo): boolean {
  const rule = platformRule(platform)
  return video.vcodec === 'h264' && video.acodec === 'aac' && video.pixFmt === 'yuv420p' &&
    video.width === rule.width && video.height === rule.height && video.fps >= 24 && video.fps <= 60 &&
    video.sizeBytes <= rule.maxBytes && (rule.maxBitrate === undefined || video.sizeBytes * 8 / video.duration <= rule.maxBitrate)
}

export interface ExportSpec {
  width: number
  height: number
  videoBitrate: number
}

export function exportSpec(platform: Platform, seconds: number): ExportSpec {
  const rule = platformRule(platform)
  // Leave 6% for container overhead and 128 kb/s for the audio; the bytes are checked after encoding.
  const budget = Math.floor(rule.maxBytes * 0.94 * 8 / Math.max(seconds, 1) - 128_000)
  return { width: rule.width, height: rule.height, videoBitrate: Math.min(8_000_000, budget) }
}

/** Platforms that need their own encode, grouped so matching specs share one. */
export function encodeGroups(platforms: Platform[], video: FinishedVideo): { platforms: Platform[]; spec: ExportSpec }[] {
  const groups = new Map<string, { platforms: Platform[]; spec: ExportSpec }>()
  for (const platform of platforms.filter((p) => !usableAsIs(p, video))) {
    const spec = exportSpec(platform, video.duration)
    const key = JSON.stringify(spec)
    const group = groups.get(key)
    if (group) group.platforms.push(platform)
    else groups.set(key, { platforms: [platform], spec })
  }
  return [...groups.values()]
}
