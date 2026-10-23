import type { ReleaseNotes, UpdateMode, UpdateState } from '../shared/update'
import { allowedReleaseUrl, isNewer } from './update-check'

export const FIRST_CHECK_DELAY_MS = 15_000
// Keep the once-a-day promise in Settings, including across launches.
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000

export const BUSY_RETRY_MS = 60 * 1000

export type CheckOutcome = 'answered' | 'failed'

export function nextCheckIn(outcome: CheckOutcome, lastAnswered: number | null, now: number): number {
  if (outcome === 'failed') return RETRY_AFTER_FAILURE_MS
  if (lastAnswered === null || lastAnswered > now) return 0
  return Math.max(0, lastAnswered + CHECK_INTERVAL_MS - now)
}

export function isRateLimited(e: unknown): boolean {
  const status = e && typeof e === 'object' && 'statusCode' in e ? e.statusCode : null
  if (status === 429 || status === 403) return true
  return /\b(429|403)\b|rate limit/i.test(String(e instanceof Error ? e.message : e))
}

export interface RememberedRelease {
  version: string
  url: string
  notes?: ReleaseNotes[]
  older?: number
}

export interface Dismissal {
  version: string
  at: number
}

export interface UpdateMemory {
  checkUpdates: boolean
  updateCheckedAt: number | null
  updateLatest: RememberedRelease | null
  updateDismissed: Dismissal | null
}

export function stillNewer(remembered: unknown, current: string): RememberedRelease | null {
  if (!remembered || typeof remembered !== 'object' || !('version' in remembered) || !('url' in remembered)) return null
  const { version, url } = remembered
  const notes = 'notes' in remembered && Array.isArray(remembered.notes) ? remembered.notes : []
  const older = 'older' in remembered && Number.isInteger(remembered.older) ? Math.max(0, remembered.older as number) : 0
  const page = allowedReleaseUrl(url)
  if (typeof version !== 'string' || !isNewer(version, current) || !page) return null
  return { version, url: page, notes: notes.flatMap((n) => rememberedNotes(n, current) ?? []), older }
}

const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((i) => typeof i === 'string')

function rememberedNotes(notes: unknown, current: string): ReleaseNotes | null {
  if (!notes || typeof notes !== 'object' || !('version' in notes) || !('items' in notes) || !('totalItems' in notes)) return null
  const { version, items, totalItems } = notes
  if (typeof version !== 'string' || !isNewer(version, current) || !strings(items) || typeof totalItems !== 'number') return null
  return { version, items, totalItems }
}

export function validDismissal(d: unknown): Dismissal | null {
  if (!d || typeof d !== 'object' || !('version' in d) || !('at' in d)) return null
  const { version, at } = d
  return typeof version === 'string' && typeof at === 'number' && Number.isFinite(at) ? { version, at } : null
}

export const SNOOZE_MS = 24 * 60 * 60 * 1000

export function isSnoozed(d: Dismissal | null, s: Pick<UpdateState, 'availableVersion' | 'downloadedVersion'>, now: number): boolean {
  const v = s.downloadedVersion ?? s.availableVersion
  if (!d || !v) return false
  return !isNewer(v, d.version) && d.at <= now && now - d.at < SNOOZE_MS
}

export interface UpdateEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  test: boolean
  hasFeed: boolean
  inApplications: boolean
}

export function disabledReason(env: UpdateEnv): string | null {
  if (env.test) return 'Updates are off in test runs.'
  if (!env.isPackaged) return 'Updates only work in the installed app, not in a development build.'
  if (env.platform !== 'darwin' && env.platform !== 'win32') return 'Update checks are available only on Mac and Windows.'
  return null
}

// A Mac app outside Applications may run translocated or read-only. The Windows install is per-user, so its
// installer runs without an admin prompt.
export function updateMode(env: Pick<UpdateEnv, 'platform' | 'inApplications' | 'hasFeed'>): UpdateMode {
  if (!env.hasFeed) return 'page'
  return (env.platform === 'darwin' && env.inApplications) || env.platform === 'win32' ? 'install' : 'page'
}

export function plainError(context: 'check' | 'download' | 'install', e: unknown): string {
  const text = String(e instanceof Error ? e.message : e)
  const offline =
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE)|fetch failed/.test(text) ||
    text === 'timeout'
  if (context === 'check') {
    if (offline) return 'I could not reach GitHub to check for updates. Check your internet connection, then try again.'
    if (isRateLimited(e)) return 'GitHub asked Reel Studio to wait before checking again. It will try again tomorrow.'
    return 'I could not check for updates. Try again later.'
  }
  if (context === 'download') {
    if (offline) return 'The download stopped because the internet connection dropped. Try again when you are back online.'
    if (/ENOSPC/i.test(text)) return 'Your computer is out of space for the download. Free some space, then try again.'
    if (/sha512|checksum/i.test(text)) return 'The download was damaged on the way. Try again.'
    return 'The download did not finish. Try again.'
  }
  return 'The update could not be installed. Try again, or download it from GitHub and install it over this version.'
}
