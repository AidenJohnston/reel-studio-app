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
}

// Limits checked 2026-10-22. They change and vary by account, so the dialog only warns about them.
export const PLATFORM_RULES: readonly PlatformRule[] = [
  { id: 'instagram', label: 'Instagram Reels', minSeconds: 3, maxSeconds: 900, maxBytes: 300_000_000, maxAudioBitrate: 128_000, noEditLists: true, captionLimit: 2200, hashtagLimit: 30, source: 'https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media' },
  { id: 'tiktok', label: 'TikTok', maxSeconds: 180, maxBytes: 4_000_000_000, captionLimit: 2200, hashtagLimit: null, source: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post', note: 'Some accounts can post longer videos. Check yours before posting.' },
  { id: 'youtube', label: 'YouTube Shorts', maxSeconds: 180, maxBytes: 256_000_000_000, captionLimit: 5000, hashtagLimit: 60, source: 'https://support.google.com/youtube/answer/15424877', note: 'The caption becomes the description. Add a title of up to 100 characters when you upload.' },
  { id: 'facebook', label: 'Facebook Reels', minSeconds: 3, maxSeconds: 90, maxBytes: 1_000_000_000, captionLimit: null, hashtagLimit: null, source: 'https://developers.facebook.com/documentation/video-api/guides/reels-publishing', note: 'Reels up to 90 seconds and 1 GB. Facebook gives no caption or hashtag limit.' },
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

export interface PlatformExportRequest {
  platforms: Platform[]
  caption: string
  /** Seconds into the finished video, or null for the project's own cover. */
  coverSeconds: number | null
}

export function parsePlatformExportRequest(value: unknown): PlatformExportRequest {
  if (!value || typeof value !== 'object' || !('platforms' in value) || !Array.isArray(value.platforms) ||
      !value.platforms.length || value.platforms.length > PLATFORM_RULES.length ||
      !value.platforms.every((p): p is Platform => typeof p === 'string' && PLATFORM_RULES.some((r) => r.id === p)) ||
      !('caption' in value) || typeof value.caption !== 'string' || value.caption.length > 100_000 ||
      !('coverSeconds' in value) || (value.coverSeconds !== null &&
        (typeof value.coverSeconds !== 'number' || !Number.isFinite(value.coverSeconds) || value.coverSeconds < 0))) {
    throw { code: 'BAD_EXPORT', userMessage: 'Choose at least one platform and a valid cover frame, then try again.' }
  }
  return { platforms: [...new Set(value.platforms)], caption: value.caption, coverSeconds: value.coverSeconds }
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

/** The video bitrate that brings a re-encode under the platform's size limit, within what the engine accepts. */
function exportBitrate(platform: Platform, seconds: number): number {
  // Leave 6% for container overhead and 128 kb/s for the audio. A video too long for any bitrate the engine accepts
  // still gets 128 kb/s; the bytes are checked after encoding and refused if they are over.
  const budget = Math.floor(platformRule(platform).maxBytes * 0.94 * 8 / Math.max(seconds, 1) - 128_000)
  return Math.max(128_000, Math.min(8_000_000, budget))
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
