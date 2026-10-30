// "Update available" notice. NOT an updater: it only tells the person a newer version is out and opens the
// download page in their browser. Mac auto-update needs Developer ID signing, and an updater that installs
// unsigned code is a worse hole than the one it closes.
//
// Privacy (the release notes promise "No account, no telemetry"): at most one GET a day to dl.getreelstudio.com
// (a small JSON file naming the newest version), and nothing else: if it fails, no other server is asked and no
// notice is shown. It carries a generic User-Agent and nothing else that could identify the person. Node's fetch
// has no cookie jar, so no Electron session cookies can ride along. Off with Settings > "Check for updates".
//
// This file never imports electron: index.ts wires it to app.getVersion(), shell.openExternal and the
// settings store, and tests drive it with fakes.
import { SITE_URL } from '../shared/config'
import type { UpdateNotice } from '../shared/api'

/** Where the installers are sold. Pages on this origin are the ONLY URLs the notice may open. */
export const SITE_ORIGIN = SITE_URL
/** The page a notice opens when the site's answer names no usable page. */
export const UPDATE_PAGE = `${SITE_ORIGIN}/update.html`
/** `{ "version": "0.1.3", "url": "https://getreelstudio.com/update.html", ... }`, the only thing ever asked. */
export const LATEST_URL = 'https://dl.getreelstudio.com/latest.json'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const TIMEOUT_MS = 10_000
/** First check this long after the window opens, so launch is never slower. */
export const FIRST_CHECK_DELAY_MS = 8_000

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

// ---- the stored state (main/settings.ts) --------------------------------------------------------

export interface UpdateState {
  /** Settings > "Check for updates". Default on. */
  checkUpdates: boolean
  /** When the site last answered (ms since 1970), or null. A failed ask does not count. */
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
  // A stored link that is not on the site (e.g. a GitHub release page saved by an older version) opens the
  // update page instead.
  const url = allowedReleaseUrl(l.url) ?? UPDATE_PAGE
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
  json(): Promise<unknown>
}>

export type AskResult = { kind: 'ok'; latest: UpdateNotice } | { kind: 'failed'; why: string }

/** The exact headers sent. Nothing else: no token, no cookie, no machine or user detail. */
export function requestHeaders(appVersion: string): Record<string, string> {
  return { 'User-Agent': `ReelStudio/${appVersion}`, Accept: 'application/json' }
}

/** One GET of the site's `latest.json`. A failure of any kind (down, slow, odd answer) is no answer: nothing
 * else is asked. A readable answer, newer or not, is a finished check. Never throws. */
export async function askSite(fetchFn: FetchLike, appVersion: string, timeoutMs = TIMEOUT_MS): Promise<AskResult> {
  try {
    const res = await fetchFn(LATEST_URL, { headers: requestHeaders(appVersion), signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!res.ok) return { kind: 'failed', why: `HTTP ${res.status}` }
    const latest = siteLatest(await res.json())
    return latest ? { kind: 'ok', latest } : { kind: 'failed', why: 'unreadable latest.json' }
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
 * Ask the site if it is time to, remember the answer, and return what to show (null = nothing). Throttled to
 * once per 24 h. An offline or failed ask is not remembered as a check, so the next launch tries again; no other
 * server is ever asked. Never throws: offline must be invisible.
 */
export async function checkForUpdate(d: CheckDeps): Promise<UpdateNotice | null> {
  try {
    let s = await d.load()
    if (isDue(s, d.now())) {
      const r = await askSite(d.fetch, d.version)
      // The person may have switched checks off while the request was out.
      if (!(await d.load()).checkUpdates) return null
      if (r.kind === 'ok') {
        await d.save({ updateCheckedAt: d.now(), updateLatest: r.latest })
        d.log(`[update] checked: newest ${r.latest.version}, running ${d.version}`)
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
    /** Never trusts the renderer: anything but a page on the site is refused. */
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
    /** First check a little after launch, then a look every hour (the 24 h throttle decides if anyone is asked). */
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
