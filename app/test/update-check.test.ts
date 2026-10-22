// GitHub releases helpers (main/update-check.ts): version order, which releases count, the release-page
// allowlist, and what one request sends.
import { describe, expect, it } from 'vitest'
import { RELEASES_API, allowedReleaseUrl, appReleases, askGitHub, isNewer, parseTag, type FetchLike } from '../src/main/update-check'
import { loadSettings, saveSettings } from '../src/main/settings'
import { setupPaths } from './helpers'

const PAGE = (tag: string) => `https://github.com/AidenJohnston/reel-studio-app/releases/tag/${tag}`
const newestRelease = (list: unknown) => appReleases(list)[0] ?? null
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: true, html_url: PAGE(tag), ...extra })

/** A release-page URL carrying credentials, which allowedReleaseUrl must refuse. */
function withUserInfo(user: string, password = ''): string {
  const u = new URL('https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.1')
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

describe('which releases count', () => {
  it('only vX.Y.Z tags', () => {
    expect(parseTag('v0.1.1')).toEqual([0, 1, 1])
    for (const t of ['ffmpeg-7.1.1-rs2', '0.1.1', 'v0.1', 'v0.1.1-beta', 'v0.1.1 ', ' v0.1.1', 'V0.1.1', 'v1.2.3.4', 'vx.y.z', '', null, 5])
      expect(parseTag(t)).toBeNull()
  })
  it('ignores the ffmpeg tag even though its numbers are bigger', () => {
    expect(newestRelease([rel('ffmpeg-7.1.1-rs2'), rel('v0.1.0')])).toMatchObject({ version: '0.1.0', releaseUrl: PAGE('v0.1.0') })
  })
  it('ignores drafts, and anything that does not say it is not a draft', () => {
    expect(newestRelease([rel('v0.1.0'), rel('v0.2.0', { draft: true }), rel('v0.3.0', { draft: undefined }), rel('v0.4.0', { draft: 'false' })])).toMatchObject({
      version: '0.1.0',
      releaseUrl: PAGE('v0.1.0')
    })
  })
  it('counts pre-releases (every release is one for now) and picks the highest, in any order', () => {
    expect(newestRelease([rel('v0.1.0'), rel('v0.1.10'), rel('v0.1.9')])?.version).toBe('0.1.10')
  })
  it('survives malformed data', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { message: 'Not Found' }, [null, 1, 'v0.2.0', [], { tag_name: 7 }]]) expect(newestRelease(bad)).toBeNull()
    expect(newestRelease([null, rel('v0.1.1'), { draft: false }])?.version).toBe('0.1.1')
  })
  it('never passes on a link that is not our release page', () => {
    expect(newestRelease([rel('v0.1.1', { html_url: 'https://evil.example/AidenJohnston/reel-studio-app/releases/tag/v0.1.1' })])).toMatchObject({
      version: '0.1.1',
      releaseUrl: PAGE('v0.1.1')
    })
    expect(newestRelease([rel('v0.1.1', { html_url: undefined })])?.releaseUrl).toBe(PAGE('v0.1.1'))
  })
})

describe('release page allowlist', () => {
  it('allows our release pages', () => {
    expect(allowedReleaseUrl(PAGE('v0.1.1'))).toBe(PAGE('v0.1.1'))
    expect(allowedReleaseUrl('https://github.com/AidenJohnston/reel-studio-app/releases/latest')).toBeTruthy()
    expect(allowedReleaseUrl('https://github.com:443/AidenJohnston/reel-studio-app/releases/tag/v1.0.0')).toBe(PAGE('v1.0.0'))
  })
  it.each([
    'http://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.1',
    'https://github.com.evil.example/AidenJohnston/reel-studio-app/releases/tag/v0.1.1',
    'https://evil.example/https://github.com/AidenJohnston/reel-studio-app/releases/',
    'https://api.github.com/repos/AidenJohnston/reel-studio-app/releases',
    'https://gist.github.com/AidenJohnston/reel-studio-app/releases/x',
    'https://github.com:8443/AidenJohnston/reel-studio-app/releases/tag/v0.1.1',
    withUserInfo('user', 'pw'), // https://user:pw at github.com/... (built so the export leak gate sees no e-mail address)
    withUserInfo('evil'),
    'https://github.com/AidenJohnston/reel-studio-app/releases',
    'https://github.com/AidenJohnston/reel-studio-app/releases/../../evil/repo/releases/x',
    'https://github.com/AidenJohnston/reel-studio-app/releases/%2e%2e/%2e%2e/evil',
    'https://github.com/AidenJohnston/reel-studio-app/releases\\..\\..\\evil',
    'https://github.com/AidenJohnston/reel-studio-app-evil/releases/tag/v0.1.1',
    'https://github.com/someoneelse/reel-studio-app/releases/tag/v0.1.1',
    'https://github.com/AidenJohnston/reel-studio-app/archive/main.zip',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.1',
    ''
  ])('refuses %s', (url) => {
    expect(allowedReleaseUrl(url)).toBeNull()
  })
  it('refuses non-strings and absurdly long links', () => {
    for (const v of [null, undefined, 1, {}, ['https://github.com/AidenJohnston/reel-studio-app/releases/x']]) expect(allowedReleaseUrl(v)).toBeNull()
    expect(allowedReleaseUrl(PAGE('v0.1.1') + '?' + 'a'.repeat(3000))).toBeNull()
  })
})

describe('the request carries nothing about the person', () => {
  it('one GET to the releases list (not /latest, which skips pre-releases), two generic headers', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers })
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [rel('v0.1.0')] }
    }
    await askGitHub(fetch, '0.1.0')
    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/AidenJohnston/reel-studio-app/releases', headers: { 'User-Agent': 'ReelStudio/0.1.0', Accept: 'application/vnd.github+json' } }
    ])
    expect(RELEASES_API.endsWith('/releases')).toBe(true)
  })
})

describe('settings store', () => {
  it('defaults to checking, and overlapping saves keep each other', async () => {
    setupPaths()
    expect((await loadSettings()).checkUpdates).toBe(true)
    await Promise.all([saveSettings({ firstRunDone: true }), saveSettings({ root: '/x' }), saveSettings({ aiAutoPicked: true })])
    const s = await loadSettings()
    expect(s).toMatchObject({ firstRunDone: true, root: '/x', aiAutoPicked: true, checkUpdates: true })
  })
})

it('fails if a stalled GitHub request does not abort at its deadline', async () => {
  const fetch: FetchLike = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await expect(askGitHub(fetch, '0.1.2', 10)).resolves.toEqual({ kind: 'failed', why: 'timeout' })
})
