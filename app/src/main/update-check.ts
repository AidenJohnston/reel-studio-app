// "Is there a newer version?": one anonymous GET of dl.getreelstudio.com/latest.json, at most once a day
// (main/updater.ts decides when). Installing what it finds is main/updater-electron.ts.
//
// Privacy (the release notes promise "No account, no telemetry"): the check carries a generic User-Agent and
// nothing else that could identify the person: never the download key, which only the update download itself
// sends (main/updater-electron.ts). If it fails, no other server is asked. Node's fetch has no cookie jar, so no
// Electron session cookies can ride along. Off with Settings > "Check for updates".
//
// This file never imports electron, so tests drive it with fakes.
import { SITE_URL } from '../shared/config'
import type { UpdateNotice } from '../shared/api'

/** Where the installers are sold. Pages on this origin are the ONLY URLs the notice may open. */
export const SITE_ORIGIN = SITE_URL
/** The page a notice opens when the site's answer names no usable page. */
export const UPDATE_PAGE = `${SITE_ORIGIN}/update.html`
/** "Turn on automatic updates": the person enters the email they bought with and gets a link carrying their key. */
export const AUTO_UPDATES_PAGE = `${SITE_ORIGIN}/updates.html`
/** `{ "version": "0.1.3", "url": "https://getreelstudio.com/update.html", ... }`, the only thing ever asked. */
export const LATEST_URL = 'https://dl.getreelstudio.com/latest.json'
export const TIMEOUT_MS = 10_000

/** The site's `version`: a plain `1.2.3`, no `v`, no suffix. */
const SITE_VERSION_RE = /^\d+\.\d+\.\d+$/
/** The running app's own version: `1.2.3`, optionally with a pre-release suffix (`1.2.3-beta.1`). */
const APP_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/

type Triple = [number, number, number]

function parseAppVersion(v: string): { t: Triple; pre: boolean } | null {
  const m = APP_VERSION_RE.exec(v.trim())
  return m ? { t: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : null
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/** Is release `release` (e.g. "0.1.1") newer than the running app `current` (e.g. "0.1.0")? Semver order;
 * a release of the same number as a pre-release build (0.2.0 vs 0.2.0-beta.1) is newer. */
export function isNewer(release: string, current: string): boolean {
  const r = parseAppVersion(release)
  const c = parseAppVersion(current)
  if (!r || !c || r.pre) return false
  const d = cmp(r.t, c.t)
  return d > 0 || (d === 0 && c.pre)
}

/** Only pages on `https://getreelstudio.com` (any path). Parsed, not string-matched, so `user@`, `http://`,
 * other ports or look-alike hosts (`getreelstudio.com.evil.example`) cannot sneak past. Returns the normalised
 * URL to open, or null. */
export function allowedReleaseUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  return u.origin === SITE_ORIGIN ? u.href : null
}

/** The site's `latest.json` as a notice, or null if it is not `{ version: "X.Y.Z", ... }`. Its `url` is used
 * only if it points at the site; otherwise the update page. Never throws on odd data. */
export function siteLatest(body: unknown): UpdateNotice | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { version, url } = body as { version?: unknown; url?: unknown }
  if (typeof version !== 'string' || !SITE_VERSION_RE.test(version)) return null
  return { version, url: allowedReleaseUrl(url) ?? UPDATE_PAGE }
}

// ---- the request ---------------------------------------------------------------------------------

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export type AskResult = { kind: 'ok'; latest: UpdateNotice } | { kind: 'failed'; why: string }

/** The exact headers sent. Nothing else: no token, no cookie, no machine or user detail. */
export function requestHeaders(appVersion: string): Record<string, string> {
  return { 'User-Agent': `ReelStudio/${appVersion}`, Accept: 'application/json' }
}

/** One GET of the site's `latest.json`. A failure of any kind (down, slow, odd answer) is no answer: nothing
 * else is asked. A readable answer, newer or not, is a finished check. Never throws. */
export async function askSite(fetchFn: FetchLike, appVersion: string, timeoutMs = TIMEOUT_MS, url = LATEST_URL): Promise<AskResult> {
  try {
    const res = await fetchFn(url, { headers: requestHeaders(appVersion), signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!res.ok) return { kind: 'failed', why: `HTTP ${res.status}` }
    const latest = siteLatest(await res.json())
    return latest ? { kind: 'ok', latest } : { kind: 'failed', why: 'unreadable latest.json' }
  } catch (e) {
    return { kind: 'failed', why: (e as Error)?.name === 'TimeoutError' ? 'timeout' : String((e as Error)?.message ?? e).slice(0, 120) }
  }
}

/** The release latest.json names if it is newer than `appVersion`, else null. Throws when the site could not
 * tell, so the updater tries again later. `url` is a local server in the update e2e. */
export async function newerOnSite(fetchFn: FetchLike, appVersion: string, url = LATEST_URL): Promise<UpdateNotice | null> {
  const r = await askSite(fetchFn, appVersion, TIMEOUT_MS, url)
  if (r.kind === 'failed') throw new Error(r.why)
  return isNewer(r.latest.version, appVersion) ? r.latest : null
}
