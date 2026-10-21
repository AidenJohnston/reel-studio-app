// Preserve main's published vX.Y.Z selection, including GitHub prereleases.
import { RELEASES_REPO } from '../shared/config'
import type { UpdateBackend } from './updater'

/** The newest app release on GitHub: its version, release page and raw markdown notes. */
export interface FoundUpdate {
  version: string
  releaseUrl: string
  notes: string | null
}

export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases`
/** Every release page lives under here. The ONLY URLs the notice may open. */
export const RELEASE_PAGE_ORIGIN = 'https://github.com'
export const RELEASE_PAGE_PREFIX = `/${RELEASES_REPO}/releases/`
export const TIMEOUT_MS = 10_000

/** App releases only: `v1.2.3`. Other tags (e.g. `ffmpeg-7.1.1-rs2`, `v1.2`, `v1.2.3-beta`) are not app versions. */
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/
/** The running app's own version: `1.2.3`, optionally with a pre-release suffix (`1.2.3-beta.1`). */
const APP_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/

type Triple = [number, number, number]

export function parseTag(tag: unknown): Triple | null {
  if (typeof tag !== 'string') return null
  const m = TAG_RE.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

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

/** Only `https://github.com/AidenJohnston/reel-studio-app/releases/...`. Parsed, not string-matched, so
 * `..`, `%2e%2e`, backslashes, `user@`, other ports or look-alike hosts cannot sneak past. Returns the
 * normalised URL to open, or null. */
export function allowedReleaseUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.origin !== RELEASE_PAGE_ORIGIN || u.username || u.password) return null
  if (!u.pathname.startsWith(RELEASE_PAGE_PREFIX)) return null
  return u.href
}

export const pageFor = (tag: string): string => `${RELEASE_PAGE_ORIGIN}${RELEASE_PAGE_PREFIX}tag/${tag}`

/** The newest app release in GitHub's releases list, or null. Drafts and non-app tags are ignored;
 * pre-releases count (every release is a pre-release for now). Never throws on odd data. */
export function newestRelease(list: unknown): FoundUpdate | null {
  if (!Array.isArray(list)) return null
  let best: { t: Triple; tag: string; url: unknown; body: unknown } | null = null
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const { draft, tag_name, html_url, body } = r as { draft?: unknown; tag_name?: unknown; html_url?: unknown; body?: unknown }
    if (draft !== false) continue // drafts, and anything that does not say it is not one
    const t = parseTag(tag_name)
    if (!t) continue
    if (!best || cmp(t, best.t) > 0) best = { t, tag: tag_name as string, url: html_url, body }
  }
  if (!best) return null
  // The API's link is used only if it points at our releases; otherwise build the page link ourselves.
  return { version: best.t.join('.'), releaseUrl: allowedReleaseUrl(best.url) ?? pageFor(best.tag), notes: typeof best.body === 'string' ? best.body : null }
}

// ---- the request ---------------------------------------------------------------------------------

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}>

export type AskResult = { kind: 'ok'; latest: FoundUpdate | null } | { kind: 'rate-limited' } | { kind: 'failed'; why: string }

/** The exact headers sent. Nothing else: no token, no cookie, no machine or user detail. */
export function requestHeaders(appVersion: string): Record<string, string> {
  return { 'User-Agent': `ReelStudio/${appVersion}`, Accept: 'application/vnd.github+json' }
}

/** One GET of the releases list. Never throws. */
export async function askGitHub(fetchFn: FetchLike, appVersion: string, timeoutMs = TIMEOUT_MS, url = RELEASES_API): Promise<AskResult> {
  try {
    const res = await fetchFn(url, { headers: requestHeaders(appVersion), signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    // GitHub's unauthenticated limit is 60 an hour per IP (a shared campus or office IP can hit it):
    // 403/429 with x-ratelimit-remaining 0 or a retry-after. The updater backs off for a full day.
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')))) {
      return { kind: 'rate-limited' }
    }
    if (!res.ok) return { kind: 'failed', why: `HTTP ${res.status}` }
    return { kind: 'ok', latest: newestRelease(await res.json()) }
  } catch (e) {
    return { kind: 'failed', why: (e as Error)?.name === 'TimeoutError' ? 'timeout' : String((e as Error)?.message ?? e).slice(0, 120) }
  }
}

/** The newest app release if it is newer than `appVersion`, else null. Throws when GitHub could not tell
 * (a rate limit carries statusCode 429, so the updater waits a day). `url` is the releases list (a local
 * server in the update e2e). */
export async function newerRelease(fetchFn: FetchLike, appVersion: string, url = RELEASES_API): Promise<FoundUpdate | null> {
  const r = await askGitHub(fetchFn, appVersion, TIMEOUT_MS, url)
  if (r.kind === 'rate-limited') throw Object.assign(new Error('GitHub rate limit'), { statusCode: 429 })
  if (r.kind === 'failed') throw new Error(r.why)
  return r.latest && isNewer(r.latest.version, appVersion) ? r.latest : null
}

// Windows keeps the release-page route regardless of signing metadata.
export function releasePageBackend(fetchFn: FetchLike, appVersion: string): UpdateBackend {
  return {
    check: () => newerRelease(fetchFn, appVersion),
    download: () => Promise.reject(new Error('This copy opens the download page instead of downloading.')),
    install() {
      throw new Error('This copy opens the download page instead of installing.')
    }
  }
}
