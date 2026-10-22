export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'facebook' | 'threads' | 'x' | 'linkedin'

export interface PlatformRule {
  id: Platform
  label: string
  minSeconds: number
  maxSeconds: number
  maxBytes: number
  captionLimit: number | null
  hashtagLimit: number | null
  width: number
  height: number
  source: string
  note?: string
}

// Offline targets checked 2026-10-22. Notes distinguish account-dependent and local limits.
export const PLATFORM_RULES: readonly PlatformRule[] = [
  { id: 'instagram', label: 'Instagram Reels', minSeconds: 3, maxSeconds: 900, maxBytes: 300_000_000, captionLimit: 2200, hashtagLimit: 30, width: 1080, height: 1920, source: 'https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media' },
  { id: 'tiktok', label: 'TikTok', minSeconds: 1, maxSeconds: 180, maxBytes: 4_000_000_000, captionLimit: 2200, hashtagLimit: null, width: 1080, height: 1920, source: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post', note: '3-minute offline target. Your account may allow more. Check its upload limit before posting.' },
  { id: 'youtube', label: 'YouTube Shorts', minSeconds: 0.01, maxSeconds: 180, maxBytes: 256_000_000_000, captionLimit: 5000, hashtagLimit: 60, width: 1080, height: 1920, source: 'https://support.google.com/youtube/answer/15424877', note: 'The caption is a description. Add a separate title of up to 100 characters when you upload.' },
  { id: 'facebook', label: 'Facebook Reels', minSeconds: 3, maxSeconds: 90, maxBytes: 1_000_000_000, captionLimit: null, hashtagLimit: null, width: 1080, height: 1920, source: 'https://developers.facebook.com/documentation/video-api/guides/reels-publishing', note: '90-second Reels target. The current guide does not give a caption, hashtag or byte maximum; 1 GB is the local file ceiling.' },
  { id: 'threads', label: 'Threads', minSeconds: 0.01, maxSeconds: 300, maxBytes: 1_000_000_000, captionLimit: 500, hashtagLimit: null, width: 1080, height: 1920, source: 'https://developers.facebook.com/documentation/threads/posts', note: 'Only one topic becomes a linked tag. The caption check conservatively counts UTF-8 bytes.' },
  { id: 'x', label: 'X', minSeconds: 0.5, maxSeconds: 1200, maxBytes: 8_000_000_000, captionLimit: 280, hashtagLimit: null, width: 720, height: 1280, source: 'https://docs.x.com/x-api/media/quickstart/media-upload', note: 'Standard account target. The caption check conservatively counts raw UTF-8 bytes, including the full web link. Confirm it in X before posting.' },
  { id: 'linkedin', label: 'LinkedIn', minSeconds: 3, maxSeconds: 1800, maxBytes: 500_000_000, captionLimit: 3000, hashtagLimit: null, width: 1080, height: 1920, source: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api', note: 'Uses the documented 500 MB video specification, below the larger multipart upload ceiling.' }
]

export function platformRule(platform: Platform): PlatformRule {
  const rule = PLATFORM_RULES.find((r) => r.id === platform)
  if (!rule) throw new Error(`Unknown export platform: ${platform}`)
  return rule
}

export interface PlatformExportRequest {
  platforms: Platform[]
  caption: string
  coverSeconds: number
}

export function parsePlatformExportRequest(value: unknown): PlatformExportRequest {
  if (!value || typeof value !== 'object' || !('platforms' in value) || !Array.isArray(value.platforms) ||
      !value.platforms.length || value.platforms.length > PLATFORM_RULES.length ||
      !value.platforms.every((p): p is Platform => typeof p === 'string' && PLATFORM_RULES.some((r) => r.id === p)) ||
      !('caption' in value) || typeof value.caption !== 'string' || value.caption.length > 100_000 ||
      !('coverSeconds' in value) || typeof value.coverSeconds !== 'number' || !Number.isFinite(value.coverSeconds) || value.coverSeconds < 0) {
    throw { code: 'BAD_EXPORT', userMessage: 'Choose at least one platform and a valid cover time, then try again.' }
  }
  return { platforms: [...new Set(value.platforms)], caption: value.caption, coverSeconds: value.coverSeconds }
}

export interface ExportIssue {
  kind: 'caption' | 'hashtags' | 'mentions' | 'duration' | 'aspect' | 'safe-area'
  message: string
  blocking: boolean
}

export function checkPlatform(platform: Platform, caption: string, seconds: number, width = 1080, height = 1920): ExportIssue[] {
  const rule = platformRule(platform)
  const issues: ExportIssue[] = []
  const count = platform === 'youtube' || platform === 'threads'
    ? new TextEncoder().encode(caption).length
    : platform === 'x'
      ? xWeightedLength(caption)
    : caption.length
  const unit = platform === 'youtube' || platform === 'threads' || platform === 'x' ? 'bytes' : 'characters'
  if (platform === 'youtube' && /[<>]/u.test(caption)) issues.push({ kind: 'caption', blocking: true, message: 'YouTube descriptions cannot contain < or >. Remove those characters before exporting.' })
  if (rule.captionLimit !== null && count > rule.captionLimit) issues.push({ kind: 'caption', blocking: true, message: `Post caption is ${count} ${unit}; the export limit is ${rule.captionLimit}. Shorten it before exporting.` })
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? []
  if (platform === 'instagram' && (caption.match(/@[a-zA-Z0-9_.]+/gu) ?? []).length > 20) issues.push({ kind: 'mentions', blocking: true, message: 'Instagram allows at most 20 mentions. Remove extra @mentions before exporting.' })
  if (rule.hashtagLimit !== null && tags.length > rule.hashtagLimit) issues.push({ kind: 'hashtags', blocking: true, message: `${tags.length} hashtags; use at most ${rule.hashtagLimit}.` })
  if (seconds > rule.maxSeconds) issues.push({ kind: 'duration', blocking: true, message: `This video is ${seconds.toFixed(1)} s. Trim it to ${rule.maxSeconds} s or less in the Cut tab.` })
  if (seconds < rule.minSeconds) issues.push({ kind: 'duration', blocking: true, message: `This platform needs at least ${rule.minSeconds} s of video.` })
  if (Math.abs(width / height - 9 / 16) > 0.01) issues.push({ kind: 'aspect', blocking: false, message: 'This video is not 9:16. The export fits it inside a vertical frame with black bars; it does not crop your picture.' })
  issues.push({ kind: 'safe-area', blocking: false, message: 'Check subtitles and important details near the edges. Platform buttons and captions can cover them; export does not move baked-in text.' })
  return issues
}

function xWeightedLength(text: string): number {
  const url = /https?:\/\/[^\s]+/gu
  let total = 0
  let end = 0
  for (const match of text.matchAll(url)) {
    const start = match.index ?? 0
    const value = match[0]
    const trimmed = value.replace(/[.,!?;:)]+$/u, '')
    total += new TextEncoder().encode(text.slice(end, start)).length
    total += Math.max(23, new TextEncoder().encode(trimmed).length)
    total += new TextEncoder().encode(value.slice(trimmed.length)).length
    end = start + value.length
  }
  return total + new TextEncoder().encode(text.slice(end)).length
}

export interface ExportSpec {
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
  videoCodec: 'h264'
  audioCodec: 'aac'
}

export function exportSpec(platform: Platform, seconds: number): ExportSpec {
  const rule = platformRule(platform)
  // Leave 6% for container overhead. Verify the resulting bytes before exposing a finished file.
  const budget = Math.floor(rule.maxBytes * 0.94 * 8 / Math.max(seconds, 1) - 128_000)
  return { width: rule.width, height: rule.height, fps: 30, videoBitrate: Math.min(8_000_000, budget), audioBitrate: 128_000, videoCodec: 'h264', audioCodec: 'aac' }
}

export function renderGroups(platforms: Platform[], seconds: number): { platforms: Platform[]; spec: ExportSpec }[] {
  const groups = new Map<string, { platforms: Platform[]; spec: ExportSpec }>()
  for (const platform of platforms) {
    const spec = exportSpec(platform, seconds)
    const key = JSON.stringify(spec)
    const group = groups.get(key)
    if (group) group.platforms.push(platform)
    else groups.set(key, { platforms: [platform], spec })
  }
  return [...groups.values()]
}
