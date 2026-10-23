export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'facebook' | 'threads' | 'x' | 'linkedin'

export interface PlatformRule {
  id: Platform
  label: string
  minSeconds?: number
  maxSeconds: number
  /** A render larger than this is re-encoded to fit; nothing else causes a re-encode. */
  maxBytes: number
  maxAudioBitrate?: number
  noEditLists?: true
  captionLimit: number | null
  hashtagLimit: number | null
  source: string
  /** Shown in the dialog in plain words. */
  note?: string
  /** The platform's own test of two versions of one post: Instagram trial reels test any change, Facebook only a cover or caption. */
  tryTwo?: { tests: 'video' | 'cover-caption'; steps: string; source: string }
}

// Limits checked 2026-10-22. They change and vary by account, so the dialog only warns about them.
export const PLATFORM_RULES: readonly PlatformRule[] = [
  { id: 'instagram', label: 'Instagram Reels', minSeconds: 3, maxSeconds: 900, maxBytes: 300_000_000, maxAudioBitrate: 128_000, noEditLists: true, captionLimit: 2200, hashtagLimit: 30, source: 'https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media',
    tryTwo: { tests: 'video', source: 'https://creators.instagram.com/blog/instagram-trial-reels', steps: "Post each video as a trial reel. Before you share, turn on Trial and leave automatic sharing off. Instagram shows trial reels to people who don't follow you first. After about a day, compare their views, then tap Share with everyone on the one that did better. No Trial switch? Your account can't use trial reels yet, so post Try 1." } },
  { id: 'tiktok', label: 'TikTok', maxSeconds: 180, maxBytes: 4_000_000_000, captionLimit: 2200, hashtagLimit: null, source: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post', note: 'Some accounts can post longer videos. Check yours before posting.' },
  { id: 'youtube', label: 'YouTube Shorts', maxSeconds: 180, maxBytes: 256_000_000_000, captionLimit: 5000, hashtagLimit: 60, source: 'https://support.google.com/youtube/answer/15424877', note: 'The caption becomes the description. Add a title of up to 100 characters when you upload.' },
  { id: 'facebook', label: 'Facebook Reels', minSeconds: 3, maxSeconds: 90, maxBytes: 1_000_000_000, captionLimit: null, hashtagLimit: null, source: 'https://developers.facebook.com/documentation/video-api/guides/reels-publishing', note: 'Reels up to 90 seconds and 1 GB. Facebook gives no caption or hashtag limit.',
    tryTwo: { tests: 'cover-caption', source: 'https://about.fb.com/news/2023/11/helping-creators-test-content-and-earn-rewards/', steps: "In the Facebook app, make the reel with the video. Before you share, add Try 2's cover and caption as a test. Facebook shows each to part of your audience and keeps the one that does better. No test option? Post Try 1." } },
  { id: 'threads', label: 'Threads', maxSeconds: 300, maxBytes: 1_000_000_000, maxAudioBitrate: 128_000, noEditLists: true, captionLimit: 500, hashtagLimit: null, source: 'https://developers.facebook.com/documentation/threads/posts', note: 'Only one hashtag becomes a link. Most emoji count as 4 characters.' },
  { id: 'x', label: 'X', minSeconds: 0.5, maxSeconds: 1200, maxBytes: 8_000_000_000, captionLimit: 280, hashtagLimit: null, source: 'https://docs.x.com/x-api/media/quickstart/best-practices', note: 'Every link counts as 23 characters. Check the caption length in X before posting.' },
  // LinkedIn's caption limit is the composer's: "Posts can contain up to 3,000 characters." (linkedin.com/help/linkedin/answer/a528176)
  { id: 'linkedin', label: 'LinkedIn', minSeconds: 3, maxSeconds: 1800, maxBytes: 500_000_000, captionLimit: 3000, hashtagLimit: null, source: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api', note: 'Videos up to 500 MB.' }
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

export function parsePlatformExportRequest(value: unknown): PlatformExportRequest {
  if (!value || typeof value !== 'object' || !('platforms' in value) || !Array.isArray(value.platforms) ||
      !value.platforms.length || value.platforms.length > PLATFORM_RULES.length ||
      !value.platforms.every((p): p is Platform => typeof p === 'string' && PLATFORM_RULES.some((r) => r.id === p)) ||
      !('caption' in value) || !validCaption(value.caption) || !('coverSeconds' in value) || !validCover(value.coverSeconds) ||
      !('second' in value)) throw badRequest()
  return { platforms: [...new Set(value.platforms)], caption: value.caption, coverSeconds: value.coverSeconds, second: parseSecondTry(value.second) }
}

export type TryChange = 'video' | 'cover' | 'caption'

/** `fps` is the render's: two cover times on the same frame are the same cover. */
export function tryChanges(first: PlatformTry, second: PlatformTry, fps: number): TryChange[] {
  const frame = (seconds: number | null) => seconds === null ? null : Math.round(seconds * fps)
  const changes: TryChange[] = []
  if (second.version !== first.version) changes.push('video')
  if (frame(second.coverSeconds) !== frame(first.coverSeconds)) changes.push('cover')
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
export function secondTryProblem(platforms: Platform[], first: PlatformTry, second: PlatformTry, fps: number): string | null {
  const changes = tryChanges(first, second, fps)
  if (!changes.length) return 'Try 2 is the same as Try 1. Pick another version, cover or caption.'
  if (secondTryPlatforms(platforms, !changes.includes('video')).length) return null
  return changes.includes('video')
    ? 'None of these platforms can test a different video. Choose Instagram, or turn off Try two versions.'
    : 'None of these platforms can test two versions. Choose Instagram or Facebook, or turn off Try two versions.'
}

/** A platform limit the export goes over. Never a block: limits change and vary by account, so the creator decides. */
export interface ExportIssue {
  kind: 'caption' | 'hashtags' | 'mentions' | 'duration'
  message: string
}

const LINK = /https?:\/\/\S+/gu
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
  if (platform === 'youtube' && /[<>]/u.test(caption)) issues.push({ kind: 'caption', message: 'Descriptions cannot contain < or >. Remove them before posting.' })
  if (rule.captionLimit !== null && count > rule.captionLimit) {
    issues.push({ kind: 'caption', message: platform === 'x'
      ? `Caption is about ${count} of ${rule.captionLimit} once links are shortened. Check it in X before posting.`
      : `Caption is ${count} of ${rule.captionLimit}. Shorten it before posting.` })
  }
  // A link's #fragment, an e-mail address or "issue#5" is not a tag or a mention; "#one#two" is two tags.
  const words = caption.replace(LINK, ' ')
  const tags = (words.match(/(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+(?:#[\p{L}\p{N}_]+)*/gu) ?? []).reduce((n, run) => n + run.split('#').length - 1, 0)
  const mentions = (words.match(/(?<![\p{L}\p{N}_.])@[a-zA-Z0-9_.]+/gu) ?? []).length
  if (platform === 'instagram' && mentions > 20) issues.push({ kind: 'mentions', message: `${mentions} @mentions. Instagram allows 20.` })
  if (rule.hashtagLimit !== null && tags > rule.hashtagLimit) issues.push({ kind: 'hashtags', message: `${tags} hashtags. The limit is ${rule.hashtagLimit}.` })
  if (seconds > rule.maxSeconds) {
    issues.push({ kind: 'duration', message: platform === 'tiktok'
      ? `This video is ${seconds.toFixed(1)} s. Some accounts only take ${rule.maxSeconds} s, so check yours before posting.`
      : `This video is ${seconds.toFixed(1)} s and the limit is ${rule.maxSeconds} s. Trim it in the Cut tab, or check that your account allows more.` })
  }
  if (rule.minSeconds !== undefined && seconds < rule.minSeconds) issues.push({ kind: 'duration', message: `This video is ${seconds.toFixed(1)} s and the shortest is ${rule.minSeconds} s.` })
  return issues
}

// docs.x.com/fundamentals/counting-characters: links count 23, emoji 2, and these ranges (Latin,
// punctuation, common symbols) 1; everything else 2. Links without https:// are not detected here.
const X_LIGHT: [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]

function xWeightedLength(text: string): number {
  let links = 0
  // X counts after NFC normalization, so a decomposed "é" is one character.
  const rest = text.normalize('NFC').replace(LINK, (link) => {
    links++
    return /[.,!?;:)]+$/u.exec(link)?.[0] ?? ''
  })
  return links * 23 + graphemes(rest).reduce((n, g) => n + (EMOJI.test(g)
    ? 2
    : [...g].reduce((m, ch) => m + (X_LIGHT.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b) ? 1 : 2), 0)), 0)
}

/** What `export-probe` reports about the finished render. */
export interface FinishedVideo {
  duration: number
  /** Frames per second, to tell whether two cover times land on the same frame. */
  fps: number
  sizeBytes: number
  audioBitrate: number | null
  editList: boolean
}

/**
 * How the final render (H.264 at CRF 18, AAC 192k; engine/reelengine/render.py) becomes this platform's file: as it is,
 * with only its audio redone and its edit list dropped (remux), or re-encoded. Only a render over the platform's size
 * limit is re-encoded. Other written specs, such as Facebook's 2-5 s keyframes or X's 720×1280, are not followed, so a
 * file that fits keeps its picture quality and saves without the wait.
 */
function preparation(platform: Platform, video: FinishedVideo): 'copy' | 'remux' | 'encode' {
  const rule = platformRule(platform)
  if (video.sizeBytes > rule.maxBytes) return 'encode'
  const audioFits = rule.maxAudioBitrate === undefined || (video.audioBitrate !== null && video.audioBitrate <= rule.maxAudioBitrate)
  return audioFits && !(rule.noEditLists && video.editList) ? 'copy' : 'remux'
}

/** The video bitrate that brings a re-encode under the platform's size limit. */
function exportBitrate(platform: Platform, seconds: number): number {
  // Leave 6% for container overhead and 128 kb/s for the audio; the bytes are checked after encoding.
  return Math.min(8_000_000, Math.floor(platformRule(platform).maxBytes * 0.94 * 8 / Math.max(seconds, 1) - 128_000))
}

/** Platforms that need their own file, grouped so matching outputs share one. A null bitrate is a remux. */
export function outputGroups(platforms: Platform[], video: FinishedVideo): { platforms: Platform[]; bitrate: number | null }[] {
  const groups = new Map<number | null, { platforms: Platform[]; bitrate: number | null }>()
  for (const platform of platforms) {
    const how = preparation(platform, video)
    if (how === 'copy') continue
    const bitrate = how === 'encode' ? exportBitrate(platform, video.duration) : null
    const group = groups.get(bitrate)
    if (group) group.platforms.push(platform)
    else groups.set(bitrate, { platforms: [platform], bitrate })
  }
  return [...groups.values()]
}
