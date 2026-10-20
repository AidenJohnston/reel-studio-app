// "Update available" notice. NOT an updater: it only tells the person a newer version is out and opens the
// release page in their browser. Mac auto-update needs Developer ID signing, and an updater that installs
// unsigned code is a worse hole than the one it closes.
//
// Privacy (the release notes promise "No account, no telemetry"): at most one GET a day to GitHub's public
// releases list, with a generic User-Agent and nothing else that could identify the person. Node's fetch has
// no cookie jar, so no Electron session cookies can ride along. Off with Settings > "Check for updates".
//
// This file never imports electron: index.ts wires it to app.getVersion(), shell.openExternal and the
// settings store, and tests drive it with fakes.
import { RELEASES_REPO } from '../shared/config'
import type { UpdateNotice } from '../shared/api'

export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases`
/** Every release page lives under here. The ONLY URLs the notice may open. */
export const RELEASE_PAGE_ORIGIN = 'https://github.com'
export const RELEASE_PAGE_PREFIX = `/${RELEASES_REPO}/releases/`
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const TIMEOUT_MS = 10_000
/** First check this long after the window opens, so launch is never slower. */
export const FIRST_CHECK_DELAY_MS = 8_000

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

const pageFor = (tag: string): string => `${RELEASE_PAGE_ORIGIN}${RELEASE_PAGE_PREFIX}tag/${tag}`

/** The newest app release in GitHub's releases list, or null. Drafts and non-app tags are ignored;
 * pre-releases count (every release is a pre-release for now). Never throws on odd data. */
export function newestRelease(list: unknown): UpdateNotice | null {
  if (!Array.isArray(list)) return null
  let best: { t: Triple; tag: string; url: unknown } | null = null
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const { draft, tag_name, html_url } = r as { draft?: unknown; tag_name?: unknown; html_url?: unknown }
    if (draft !== false) continue // drafts, and anything that does not say it is not one
    const t = parseTag(tag_name)
    if (!t) continue
    if (!best || cmp(t, best.t) > 0) best = { t, tag: tag_name as string, url: html_url }
  }
  if (!best) return null
  // The API's link is used only if it points at our releases; otherwise build the page link ourselves.
  return { version: best.t.join('.'), url: allowedReleaseUrl(best.url) ?? pageFor(best.tag) }
}

// ---- the stored state (main/settings.ts) --------------------------------------------------------

export interface UpdateState {
  /** Settings > "Check for updates". Default on. */
  checkUpdates: boolean
  /** When GitHub was last asked (ms since 1970), or null. Only answered or rate-limited asks count. */
  updateCheckedAt: number | null
  /** The newest release found by the last check, kept so a launch inside the 24 h still shows it. */
  updateLatest: UpdateNotice | null
  /** "Not now": which version was waved off, and when. */
  updateDismissed: { version: string; at: number } | null
}

export const UPDATE_DEFAULTS: UpdateState = { checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null }

export function isDue(s: Pick<UpdateState, 'checkUpdates' | 'updateCheckedAt'>, now: number): boolean {
  if (!s.checkUpdates) return false
  const at = s.updateCheckedAt
  // A clock that went backwards (at in the future) must not block checks for days.
  return typeof at !== 'number' || !Number.isFinite(at) || now - at >= CHECK_INTERVAL_MS || at > now
}

/** What the renderer should show right now, or null. */
export function noticeToShow(s: UpdateState, current: string, now: number): UpdateNotice | null {
  if (!s.checkUpdates) return null
  const l = s.updateLatest
  if (!l || typeof l.version !== 'string' || !isNewer(l.version, current)) return null
  const url = allowedReleaseUrl(l.url)
  if (!url) return null
  const d = s.updateDismissed
  if (d && typeof d.version === 'string' && typeof d.at === 'number') {
    const sameOrOlder = !isNewer(l.version, d.version)
    const recent = now - d.at < CHECK_INTERVAL_MS && d.at <= now
    if (sameOrOlder && recent) return null
  }
  return { version: l.version, url }
}

// ---- the request ---------------------------------------------------------------------------------

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}>

export type AskResult = { kind: 'ok'; latest: UpdateNotice | null } | { kind: 'rate-limited' } | { kind: 'failed'; why: string }

/** The exact headers sent. Nothing else: no token, no cookie, no machine or user detail. */
export function requestHeaders(appVersion: string): Record<string, string> {
  return { 'User-Agent': `ReelStudio/${appVersion}`, Accept: 'application/vnd.github+json' }
}

/** One GET of the releases list. Never throws. */
export async function askGitHub(fetchFn: FetchLike, appVersion: string, timeoutMs = TIMEOUT_MS): Promise<AskResult> {
  try {
    const res = await fetchFn(RELEASES_API, { headers: requestHeaders(appVersion), signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    // GitHub's unauthenticated limit is 60 an hour per IP (a shared campus or office IP can hit it):
    // 403/429 with x-ratelimit-remaining 0 or a retry-after. Back off for the full day, quietly.
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')))) {
      return { kind: 'rate-limited' }
    }
    if (!res.ok) return { kind: 'failed', why: `HTTP ${res.status}` }
    return { kind: 'ok', latest: newestRelease(await res.json()) }
  } catch (e) {
    return { kind: 'failed', why: (e as Error)?.name === 'TimeoutError' ? 'timeout' : String((e as Error)?.message ?? e).slice(0, 120) }
  }
}

export interface CheckDeps {
  load(): Promise<UpdateState>
  save(patch: Partial<UpdateState>): Promise<unknown>
  fetch: FetchLike
  /** app.getVersion() */
  version: string
  now(): number
  log(line: string): void
}

/**
 * Ask GitHub if it is time to, remember the answer, and return what to show (null = nothing). Throttled to
 * once per 24 h. An offline or failed ask is not remembered as a check, so the next launch tries again; a
 * rate-limited one is (so we stop asking for the day). Never throws: offline must be invisible.
 */
export async function checkForUpdate(d: CheckDeps): Promise<UpdateNotice | null> {
  try {
    let s = await d.load()
    if (isDue(s, d.now())) {
      const r = await askGitHub(d.fetch, d.version)
      // The person may have switched checks off while the request was out.
      if (!(await d.load()).checkUpdates) return null
      if (r.kind === 'ok') {
        await d.save({ updateCheckedAt: d.now(), updateLatest: r.latest })
        d.log(`[update] checked: newest ${r.latest?.version ?? 'none'}, running ${d.version}`)
      } else if (r.kind === 'rate-limited') {
        await d.save({ updateCheckedAt: d.now() })
        d.log('[update] GitHub rate limit: trying again tomorrow')
      } else {
        d.log(`[update] check failed (${r.why}): trying again next launch`)
      }
      s = await d.load()
    }
    return noticeToShow(s, d.version, d.now())
  } catch (e) {
    d.log(`[update] ${String(e)}`)
    return null
  }
}

// ---- the service behind the IPC (main/index.ts wires electron to it) -----------------------------

export interface ServiceDeps extends CheckDeps {
  /** False = never touch the network (test runs). Settings still work. */
  active: boolean
  /** shell.openExternal. Only ever called with an allowedReleaseUrl() result. */
  openExternal(url: string): Promise<void>
  /** Push to the renderer: a notice to show, or null to hide it. */
  send(n: UpdateNotice | null): void
}

export const NOT_A_RELEASE_PAGE = { code: 'NOT_ALLOWED', userMessage: 'That link is not a Reel Studio download page.' }

export function createUpdateService(d: ServiceDeps) {
  let running: Promise<UpdateNotice | null> | null = null
  let pushed: string | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  let hourly: ReturnType<typeof setInterval> | null = null

  async function run(): Promise<UpdateNotice | null> {
    if (!d.active) return null
    if (!running) running = checkForUpdate(d).finally(() => (running = null))
    const n = await running
    if (n && n.version !== pushed) {
      pushed = n.version
      d.send(n)
    }
    return n
  }

  async function status() {
    const s = await d.load()
    return { enabled: !!s.checkUpdates, notice: d.active ? noticeToShow(s, d.version, d.now()) : null }
  }

  return {
    run,
    status,
    async setEnabled(on: unknown) {
      const enabled = on === true
      await d.save({ checkUpdates: enabled })
      if (enabled) void run()
      else {
        pushed = null
        d.send(null)
      }
      return status()
    },
    /** Never trusts the renderer: anything but one of our release pages is refused. */
    async open(url: unknown) {
      const ok = allowedReleaseUrl(url)
      if (!ok) {
        d.log(`[update] refused to open ${String(url).slice(0, 200)}`)
        throw NOT_A_RELEASE_PAGE
      }
      await d.openExternal(ok)
    },
    async dismiss(version: unknown) {
      if (typeof version !== 'string' || !parseAppVersion(version)) return
      await d.save({ updateDismissed: { version, at: d.now() } })
      pushed = null // so tomorrow's check (app left open) can show it again
    },
    /** First check a little after launch, then a look every hour (the 24 h throttle decides if GitHub is asked). */
    start(firstDelayMs = FIRST_CHECK_DELAY_MS, everyMs = 60 * 60 * 1000) {
      if (!d.active) return
      first = setTimeout(() => void run(), firstDelayMs)
      hourly = setInterval(() => void run(), everyMs)
      first.unref?.()
      hourly.unref?.()
    },
    stop() {
      if (first) clearTimeout(first)
      if (hourly) clearInterval(hourly)
      first = hourly = null
    }
  }
}
