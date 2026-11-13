// The daily "is there a newer version" check: version order, the site's answer, silent failure, the privacy of the
// request (one server, never GitHub, never the download key) and the download-page allowlist (main/update-check.ts).
// When it runs, and what the app does with the answer, is main/updater.ts (test/updater.test.ts).
import { describe, expect, it } from 'vitest'
import { LATEST_URL, SITE_ORIGIN, UPDATE_PAGE, allowedReleaseUrl, askSite, isNewer, newerOnSite, siteLatest, type FetchLike } from '../src/main/update-check'
import { loadSettings, saveSettings } from '../src/main/settings'
import { setupPaths } from './helpers'

/** A GitHub release page, as an older version's fallback stored it. Never opened any more. */
const GITHUB_PAGE = 'https://github.com/owner/reel-studio-app/releases/tag/v0.1.1'
/** What GitHub's releases API answered. The site must never be mistaken for it. */
const githubList = [{ tag_name: 'v0.9.0', draft: false, prerelease: true, html_url: GITHUB_PAGE }]
/** What dl.getreelstudio.com/latest.json answers. */
const latestJson = (version: string, extra: Record<string, unknown> = {}) => ({ version, url: UPDATE_PAGE, files: { win: 'x.exe', mac: 'x.dmg' }, notes: [], ...extra })
const T0 = Date.UTC(2026, 9, 18, 12)

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  }
}
type Reply = ReturnType<typeof reply>
type Answer = () => Promise<Reply>

const siteDown: Answer = async () => reply(500, 'oops')
const offline: Answer = async () => Promise.reject(new TypeError('fetch failed'))

/** A fake site that records every request (any other URL is recorded too, then refused). */
function site(answer: Answer) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (url === LATEST_URL) return answer()
    throw new Error(`unexpected request to ${url}`)
  }
  return { fetch, calls, urls: () => calls.map((c) => c.url) }
}

/** A download-page URL carrying credentials, which allowedReleaseUrl must refuse. */
function withUserInfo(base: string, user: string, password = ''): string {
  const u = new URL(base)
  u.username = user
  u.password = password
  return u.toString()
}

describe('version order', () => {
  it('compares numbers, not text', () => {
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.2.0', '0.1.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.1.10', '0.1.9')).toBe(true)
  })
  it('the same or an older version is not news', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.0.9', '0.1.0')).toBe(false)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
  })
  it('a release beats a pre-release build of the same number', () => {
    expect(isNewer('0.2.0', '0.2.0-beta.1')).toBe(true)
    expect(isNewer('0.1.0', '0.2.0-beta.1')).toBe(false)
  })
  it('garbage is never newer', () => {
    expect(isNewer('banana', '0.1.0')).toBe(false)
    expect(isNewer('0.2', '0.1.0')).toBe(false)
    expect(isNewer('0.2.0', 'unknown')).toBe(false)
  })
})

describe("the site's latest.json", () => {
  it('reads the version and the page, and ignores the rest', () => {
    expect(siteLatest(latestJson('0.1.3'))).toEqual({ version: '0.1.3', url: UPDATE_PAGE })
    expect(siteLatest({ version: '0.1.3', url: `${SITE_ORIGIN}/download?v=0.1.3` })).toEqual({ version: '0.1.3', url: `${SITE_ORIGIN}/download?v=0.1.3` })
  })
  it('a page that is not ours becomes the update page', () => {
    for (const url of [GITHUB_PAGE, 'https://evil.example/update.html', 'http://getreelstudio.com/update.html', 'javascript:alert(1)', undefined, 7, ''])
      expect(siteLatest({ version: '0.1.3', url })).toEqual({ version: '0.1.3', url: UPDATE_PAGE })
  })
  it('only a plain X.Y.Z version counts', () => {
    for (const version of ['v0.1.3', '0.1', '0.1.3-beta.1', '0.1.3 ', 'latest', 13, null, undefined]) expect(siteLatest({ version, url: UPDATE_PAGE })).toBeNull()
  })
  it('survives malformed data', () => {
    for (const bad of [null, undefined, 'x', 42, {}, [], [latestJson('0.1.3')], { message: 'Not Found' }, githubList]) expect(siteLatest(bad)).toBeNull()
  })
})

describe('download page allowlist', () => {
  it('allows any page on getreelstudio.com', () => {
    expect(allowedReleaseUrl(UPDATE_PAGE)).toBe(UPDATE_PAGE)
    expect(allowedReleaseUrl('https://getreelstudio.com')).toBe('https://getreelstudio.com/')
    expect(allowedReleaseUrl('https://getreelstudio.com/')).toBe('https://getreelstudio.com/')
    expect(allowedReleaseUrl('https://getreelstudio.com/download?token=abc#mac')).toBe('https://getreelstudio.com/download?token=abc#mac')
    expect(allowedReleaseUrl('https://getreelstudio.com:443/update.html')).toBe(UPDATE_PAGE)
  })
  it.each([
    GITHUB_PAGE, // GitHub release pages were allowed before the site; no longer
    'https://github.com/owner/reel-studio-app/releases/latest',
    'https://api.github.com/repos/owner/reel-studio-app/releases',
    'http://getreelstudio.com/update.html',
    'https://getreelstudio.com.evil.example/update.html',
    'https://evil.example/getreelstudio.com/update.html',
    'https://evil.example/?https://getreelstudio.com/update.html',
    'https://www.getreelstudio.com/update.html',
    'https://dl.getreelstudio.com/latest.json',
    'https://getreelstudio.com:8443/update.html',
    'https://getreelstudio.co/update.html',
    withUserInfo(UPDATE_PAGE, 'user', 'pw'),
    withUserInfo(UPDATE_PAGE, 'evil'),
    withUserInfo('https://evil.example/getreelstudio.com/update.html', 'user'),
    'ftp://getreelstudio.com/update.html',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'getreelstudio.com/update.html',
    '//getreelstudio.com/update.html',
    ''
  ])('refuses %s', (url) => {
    expect(allowedReleaseUrl(url)).toBeNull()
  })
  it('refuses non-strings and absurdly long links', () => {
    for (const v of [null, undefined, 1, {}, [UPDATE_PAGE]]) expect(allowedReleaseUrl(v)).toBeNull()
    expect(allowedReleaseUrl(UPDATE_PAGE + '?' + 'a'.repeat(3000))).toBeNull()
  })
})

describe('the site is the only server', () => {
  it('a newer version on the site: the version and the site page', async () => {
    const w = site(async () => reply(200, latestJson('0.1.1', { url: `${SITE_ORIGIN}/download` })))
    expect(await newerOnSite(w.fetch, '0.1.0')).toEqual({ version: '0.1.1', url: `${SITE_ORIGIN}/download` })
    expect(w.urls()).toEqual([LATEST_URL])
  })
  it('a page that is not ours in the answer: the update page instead', async () => {
    expect(await newerOnSite(site(async () => reply(200, latestJson('0.1.1', { url: 'https://evil.example/update.html' }))).fetch, '0.1.0')).toEqual({ version: '0.1.1', url: UPDATE_PAGE })
    expect(await newerOnSite(site(async () => reply(200, { version: '0.1.1' })).fetch, '0.1.0')).toEqual({ version: '0.1.1', url: UPDATE_PAGE })
  })
  it('the site says the running version, or an older one: nothing to offer, and no error', async () => {
    for (const v of ['0.1.0', '0.0.9']) expect(await newerOnSite(site(async () => reply(200, latestJson(v))).fetch, '0.1.0')).toBeNull()
  })
  const siteFailures: [string, Answer][] = [
    ['server error', siteDown],
    ['not found', async () => reply(404, 'nope')],
    ['rate limited', async () => reply(429, {})],
    ['offline', offline],
    ['timeout', async () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))],
    ['bad JSON', async () => reply(200, '{not json')],
    ['odd JSON', async () => reply(200, { message: 'hi' })],
    ['a GitHub-shaped answer', async () => reply(200, githubList)],
    ['a v-prefixed version', async () => reply(200, latestJson('v0.1.1'))]
  ]
  // The updater keeps what an earlier check found and tries again in an hour (test/updater.test.ts).
  it.each(siteFailures)('site %s: a failed check, and GitHub (or anyone else) is never asked', async (_name, answer) => {
    const w = site(answer)
    await expect(newerOnSite(w.fetch, '0.1.0')).rejects.toThrow()
    expect(w.urls()).toEqual([LATEST_URL])
  })
})

describe('fails without throwing', () => {
  it('a slow server is cut off after the timeout', async () => {
    const slow: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))
    expect(await askSite(slow, '0.1.0', 30)).toEqual({ kind: 'failed', why: 'timeout' })
  })
  it('askSite never throws and names the reason', async () => {
    expect(await askSite(async () => reply(503, ''), '0.1.0')).toEqual({ kind: 'failed', why: 'HTTP 503' })
    expect(await askSite(async () => reply(200, '{not json'), '0.1.0')).toMatchObject({ kind: 'failed' })
    expect(await askSite(async () => reply(200, { version: 'latest' }), '0.1.0')).toEqual({ kind: 'failed', why: 'unreadable latest.json' })
    expect(await askSite(async () => Promise.reject(new TypeError('fetch failed')), '0.1.0')).toEqual({ kind: 'failed', why: 'fetch failed' })
    expect(await askSite(async () => reply(200, latestJson('0.1.3')), '0.1.0')).toEqual({ kind: 'ok', latest: { version: '0.1.3', url: UPDATE_PAGE } })
  })
})

describe('the request carries nothing about the person', () => {
  it('one GET to latest.json, two generic headers, whatever the site answers', async () => {
    for (const answer of [async () => reply(200, latestJson('0.1.1')), siteDown]) {
      const w = site(answer)
      await newerOnSite(w.fetch, '0.1.0').catch(() => null)
      expect(w.calls).toEqual([{ url: 'https://dl.getreelstudio.com/latest.json', headers: { 'User-Agent': 'ReelStudio/0.1.0', Accept: 'application/json' } }])
    }
  })
})

describe('settings store', () => {
  it('defaults to checking, and overlapping saves keep each other', async () => {
    setupPaths()
    expect((await loadSettings()).checkUpdates).toBe(true)
    await Promise.all([saveSettings({ firstRunDone: true }), saveSettings({ updateCheckedAt: T0 }), saveSettings({ aiAutoPicked: true })])
    const s = await loadSettings()
    expect(s).toMatchObject({ firstRunDone: true, updateCheckedAt: T0, aiAutoPicked: true, checkUpdates: true })
  })
})
