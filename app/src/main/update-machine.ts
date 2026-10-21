// The updater's pure parts: state transitions (ported from T3 Code's apps/desktop/src/updates/updateMachine.ts),
// when to check next, why updates may be off, and whether this copy may install updates itself.
// No electron here; main/updater.ts drives it and the tests call it directly.
import type { ReleaseNotes, UpdateMode, UpdateState } from '../shared/update'

// ---- transitions ---------------------------------------------------------------------------------

/** A look while an update is already known is quiet: the button keeps showing it (T3 Code switches to
 * "checking", which here would hide the sidebar button and bring it back a moment later). */
export function onCheckStart(s: UpdateState, at: number): UpdateState {
  if (s.availableVersion !== null) return { ...s, checkedAt: at }
  return { ...s, status: 'checking', checkedAt: at, releaseNotes: null, releaseUrl: null, downloadPercent: null, message: null, errorContext: null }
}

/** A failed look never takes away an update already found or downloaded. */
export function onCheckFailed(s: UpdateState, message: string, at: number): UpdateState {
  if (s.availableVersion !== null) return { ...s, checkedAt: at }
  return { ...s, status: 'error', message, checkedAt: at, downloadPercent: null, errorContext: 'check' }
}

export function onAvailable(s: UpdateState, version: string, at: number, notes: ReleaseNotes | null, releaseUrl: string | null): UpdateState {
  const already = s.downloadedVersion === version
  return {
    ...s,
    status: already ? 'downloaded' : 'available',
    availableVersion: version,
    downloadedVersion: already ? version : null,
    releaseNotes: already && !notes ? s.releaseNotes : notes,
    releaseUrl: releaseUrl ?? (already ? s.releaseUrl : null),
    downloadPercent: already ? 100 : null,
    checkedAt: at,
    message: null,
    errorContext: null
  }
}

export function onUpToDate(s: UpdateState, at: number): UpdateState {
  if (s.downloadedVersion !== null) {
    return { ...s, status: 'downloaded', availableVersion: s.downloadedVersion, downloadPercent: 100, checkedAt: at, message: null, errorContext: null }
  }
  return {
    ...s,
    status: 'up-to-date',
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadPercent: null,
    checkedAt: at,
    message: null,
    errorContext: null
  }
}

export function onDownloadStart(s: UpdateState): UpdateState {
  return { ...s, status: 'downloading', downloadPercent: 0, message: null, errorContext: null }
}

export function onDownloadProgress(s: UpdateState, percent: number): UpdateState {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  return { ...s, status: 'downloading', downloadPercent: p, message: null, errorContext: null }
}

/** T3 Code drops back to "available"; here the button stays visible as "Try the download again" (shared/update.ts
 * updateAction), so the person sees that the download stopped instead of it silently starting over. */
export function onDownloadFailed(s: UpdateState, message: string): UpdateState {
  return { ...s, status: 'error', message, downloadPercent: null, errorContext: 'download' }
}

export function onDownloaded(s: UpdateState, version: string): UpdateState {
  return { ...s, status: 'downloaded', availableVersion: version, downloadedVersion: version, downloadPercent: 100, message: null, errorContext: null }
}

export function onInstallFailed(s: UpdateState, message: string): UpdateState {
  return { ...s, status: 'error', message, errorContext: 'install' }
}

/** Only the renderer's progress ring needs fine steps; a broadcast per percent is plenty. */
export function progressWorthSending(s: UpdateState, percent: number): boolean {
  return s.status !== 'downloading' || s.downloadPercent === null || Math.floor(percent) !== Math.floor(s.downloadPercent) || percent >= 100
}

// ---- when to check -------------------------------------------------------------------------------

/** First check this long after start, so launch is never slower (T3 Code: 15 s). */
export const FIRST_CHECK_DELAY_MS = 15_000
/**
 * Then every 4 hours. T3 Code polls its own feed every 4 minutes; Reel Studio asks GitHub, anonymously. The
 * Windows page check uses GitHub's API, which allows 60 unauthenticated requests an hour per IP address, and a
 * school or office network puts many people behind one address. Every 4 h is at most 6 checks a day per copy,
 * so about 240 copies can share one address before the limit; releases come weeks apart, so a person still
 * hears about one the same day. The Mac check (electron-updater's GitHub provider) asks github.com itself, not
 * the API, and gets the same pace.
 */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** After a failed check (offline, GitHub down): 30 min, then 1 h, 2 h, never longer than the interval. */
export const RETRY_FIRST_MS = 30 * 60 * 1000
/** GitHub said slow down (403 rate limit or 429): wait a full day. */
export const RATE_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000

export type CheckOutcome = 'ok' | 'failed' | 'rate-limited'

export function nextCheckDelay(outcome: CheckOutcome, failuresInARow: number): number {
  if (outcome === 'rate-limited') return RATE_LIMIT_WAIT_MS
  if (outcome === 'ok') return CHECK_INTERVAL_MS
  return Math.min(CHECK_INTERVAL_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failuresInARow - 1))
}

/** A GitHub answer that means "too many requests": the error's status, or the code in its message
 * (electron-updater wraps the HTTP error in its own, keeping only the text). */
export function isRateLimited(e: unknown): boolean {
  const status = (e as { statusCode?: unknown })?.statusCode
  if (status === 429 || status === 403) return true
  return /\b(429|403)\b|rate limit/i.test(String((e as Error)?.message ?? e))
}

// ---- may this copy update itself? ----------------------------------------------------------------

export interface UpdateEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** REELSTUDIO_TEST=1 or --self-test: never touch the network. */
  test: boolean
  /** The packaged app's resources/app-update.yml (electron-builder writes it from the publish config), or null. */
  feed: FeedFile | null
  /** macOS: app.isInApplicationsFolder(). Squirrel.Mac cannot replace an app on the disk image or a translocated copy. */
  inApplications: boolean
}

/** Why updates are off, in plain words (T3 Code's getAutoUpdateDisabledReason), or null. */
export function disabledReason(env: UpdateEnv): string | null {
  if (env.test) return 'Updates are off in test runs.'
  if (!env.isPackaged) return 'Updates only work in the installed app, not in a development build.'
  if (env.platform !== 'darwin' && env.platform !== 'win32') return 'Reel Studio updates itself only on Mac and Windows.'
  if (updateMode(env) === 'install' && !env.feed) return 'This copy of Reel Studio was built without an update address. Download new versions from GitHub.'
  return null
}

/**
 * Install in the app, or only point at the download page.
 *
 * Windows decision point: electron-updater checks a downloaded Windows installer's signature against the
 * `publisherName` in app-update.yml, and electron-builder writes that name only when the build is signed. With
 * no name it skips the check altogether (NsisUpdater.verifySignature returns null), so an unsigned build would
 * run whatever installer the download handed it. Until the Windows installer is signed, Windows keeps the old
 * behavior: say a version is out and open its page. Signing alone switches it on; never turn the check off.
 *
 * macOS installs only from the Applications folder; anywhere else (still on the disk image, or a copy macOS
 * moved to a random read-only place) the page is the honest answer too.
 */
export function updateMode(env: Pick<UpdateEnv, 'platform' | 'feed' | 'inApplications'>): UpdateMode {
  if (env.platform === 'win32') return env.feed?.publisherName ? 'install' : 'page'
  if (env.platform === 'darwin') return env.inApplications ? 'install' : 'page'
  return 'page'
}

// ---- plain-words errors --------------------------------------------------------------------------

export function plainError(context: 'check' | 'download' | 'install', e: unknown): string {
  const text = String((e as Error)?.message ?? e)
  // Network error codes only: an HTTP error's text carries its response headers ("Keep-Alive: timeout=5").
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

export type FeedFile = Record<string, string | string[]>

/**
 * resources/app-update.yml as electron-builder writes it (flat `key: value` lines; a list such as
 * `publisherName:` on Windows is `  - item` lines below its key). Only what the mode decision reads.
 */
export function parseFeedFile(text: string): FeedFile {
  const out: FeedFile = {}
  let list: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && list) {
      list.push(unquote(item[1]))
      continue
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    list = null
    if (kv[2] === '') out[kv[1]] = list = []
    else out[kv[1]] = unquote(kv[2])
  }
  return out
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2')
