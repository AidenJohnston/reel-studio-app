// "Update available" notice: version order, which releases count, the 24 h throttle, silent failure,
// the privacy of the request and the release-page allowlist (main/update-check.ts).
import { describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  RELEASES_API,
  UPDATE_DEFAULTS,
  allowedReleaseUrl,
  askGitHub,
  checkForUpdate,
  createUpdateService,
  isDue,
  isNewer,
  newestRelease,
  noticeToShow,
  parseTag,
  type FetchLike,
  type UpdateState
} from '../src/main/update-check'
import { loadSettings, saveSettings } from '../src/main/settings'
import { setupPaths } from './helpers'

const PAGE = (tag: string) => `https://github.com/AidenJohnston/reel-studio-app/releases/tag/${tag}`
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: true, html_url: PAGE(tag), ...extra })
const DAY = CHECK_INTERVAL_MS
const T0 = Date.UTC(2026, 9, 18, 12)

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  }
}

/** A settings store in memory, plus a fake GitHub that records every request. */
function world(initial: Partial<UpdateState> = {}, answer: () => Promise<ReturnType<typeof reply>> = async () => reply(200, [rel('v0.1.0')])) {
  let state: UpdateState = { ...UPDATE_DEFAULTS, ...initial }
  let now = T0
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return answer()
  }
  const logs: string[] = []
  const deps = {
    load: async () => ({ ...state }),
    save: async (p: Partial<UpdateState>) => {
      state = { ...state, ...p }
    },
    fetch,
    version: '0.1.0',
    now: () => now,
    log: (l: string) => logs.push(l)
  }
  return {
    deps,
    calls,
    logs,
    state: () => state,
    tick: (ms: number) => (now += ms)
  }
}

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
    expect(newestRelease([rel('ffmpeg-7.1.1-rs2'), rel('v0.1.0')])).toEqual({ version: '0.1.0', url: PAGE('v0.1.0') })
  })
  it('ignores drafts, and anything that does not say it is not a draft', () => {
    expect(newestRelease([rel('v0.1.0'), rel('v0.2.0', { draft: true }), rel('v0.3.0', { draft: undefined }), rel('v0.4.0', { draft: 'false' })])).toEqual({
      version: '0.1.0',
      url: PAGE('v0.1.0')
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
    expect(newestRelease([rel('v0.1.1', { html_url: 'https://evil.example/AidenJohnston/reel-studio-app/releases/tag/v0.1.1' })])).toEqual({
      version: '0.1.1',
      url: PAGE('v0.1.1')
    })
    expect(newestRelease([rel('v0.1.1', { html_url: undefined })])?.url).toBe(PAGE('v0.1.1'))
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

describe('the 24 hour throttle', () => {
  it('asks when never asked, then not again for a day', async () => {
    const w = world()
    await checkForUpdate(w.deps)
    expect(w.calls).toHaveLength(1)
    w.tick(DAY - 1)
    await checkForUpdate(w.deps)
    expect(w.calls).toHaveLength(1)
    w.tick(1)
    await checkForUpdate(w.deps)
    expect(w.calls).toHaveLength(2)
  })
  it('a launch inside the day still shows the newer version found earlier', async () => {
    const w = world({}, async () => reply(200, [rel('v0.1.1'), rel('v0.1.0')]))
    expect(await checkForUpdate(w.deps)).toEqual({ version: '0.1.1', url: PAGE('v0.1.1') })
    w.tick(60_000)
    expect(await checkForUpdate(w.deps)).toEqual({ version: '0.1.1', url: PAGE('v0.1.1') })
    expect(w.calls).toHaveLength(1)
  })
  it('after updating, the remembered version is no longer news', async () => {
    const w = world({ updateCheckedAt: T0, updateLatest: { version: '0.1.1', url: PAGE('v0.1.1') } })
    expect(await checkForUpdate({ ...w.deps, version: '0.1.1' })).toBeNull()
  })
  it('switched off: never asks, never shows', async () => {
    const w = world({ checkUpdates: false, updateLatest: { version: '0.9.0', url: PAGE('v0.9.0') } })
    expect(await checkForUpdate(w.deps)).toBeNull()
    expect(w.calls).toHaveLength(0)
    expect(isDue({ checkUpdates: false, updateCheckedAt: null }, T0)).toBe(false)
  })
  it('a clock set backwards does not block checks for days', () => {
    expect(isDue({ checkUpdates: true, updateCheckedAt: T0 + 5 * DAY }, T0)).toBe(true)
    expect(isDue({ checkUpdates: true, updateCheckedAt: Number.NaN }, T0)).toBe(true)
  })
})

describe('fails silently', () => {
  const failures: [string, () => Promise<ReturnType<typeof reply>>][] = [
    ['offline', async () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout', async () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))],
    ['server error', async () => reply(500, 'oops')],
    ['not found', async () => reply(404, { message: 'Not Found' })],
    ['bad JSON', async () => reply(200, '{not json')],
    ['odd JSON', async () => reply(200, { message: 'hi' })]
  ]
  it.each(failures)('%s: no notice, no throw', async (_name, answer) => {
    const w = world({}, answer)
    await expect(checkForUpdate(w.deps)).resolves.toBeNull()
  })
  it('a failed ask is not counted as a check, so the next launch tries again', async () => {
    let online = false
    const w = world({}, async () => (online ? reply(200, [rel('v0.1.1')]) : Promise.reject(new TypeError('fetch failed'))))
    await checkForUpdate(w.deps)
    expect(w.state().updateCheckedAt).toBeNull()
    online = true
    w.tick(1000)
    expect((await checkForUpdate(w.deps))?.version).toBe('0.1.1')
    expect(w.calls).toHaveLength(2)
  })
  it('a broken settings store does not throw either', async () => {
    const w = world()
    await expect(checkForUpdate({ ...w.deps, load: async () => Promise.reject(new Error('disk')) })).resolves.toBeNull()
  })
  it('a slow GitHub is cut off after the timeout', async () => {
    const slow: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))
    expect(await askGitHub(slow, '0.1.0', 30)).toEqual({ kind: 'failed', why: 'timeout' })
  })
})

describe('GitHub rate limit', () => {
  it.each([
    ['403 with remaining 0', reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })],
    ['403 with retry-after', reply(403, {}, { 'retry-after': '60' })],
    ['429', reply(429, {})]
  ])('%s: quiet, and no more asking today', async (_n, r) => {
    const w = world({}, async () => r)
    expect(await checkForUpdate(w.deps)).toBeNull()
    expect(w.state().updateCheckedAt).toBe(T0)
    w.tick(DAY / 2)
    await checkForUpdate(w.deps)
    expect(w.calls).toHaveLength(1)
  })
  it('keeps showing what an earlier check found', async () => {
    const w = world({ updateCheckedAt: T0 - DAY, updateLatest: { version: '0.1.1', url: PAGE('v0.1.1') } }, async () => reply(429, {}))
    expect((await checkForUpdate(w.deps))?.version).toBe('0.1.1')
  })
})

describe('the request carries nothing about the person', () => {
  it('one GET to the releases list (not /latest, which skips pre-releases), two generic headers', async () => {
    const w = world()
    await checkForUpdate(w.deps)
    expect(w.calls).toEqual([
      { url: 'https://api.github.com/repos/AidenJohnston/reel-studio-app/releases', headers: { 'User-Agent': 'ReelStudio/0.1.0', Accept: 'application/vnd.github+json' } }
    ])
    expect(RELEASES_API.endsWith('/releases')).toBe(true)
  })
})

describe('"Not now"', () => {
  const latest = { version: '0.1.1', url: PAGE('v0.1.1') }
  const s = (d: UpdateState['updateDismissed']): UpdateState => ({ ...UPDATE_DEFAULTS, updateCheckedAt: T0, updateLatest: latest, updateDismissed: d })
  it('hides it for the rest of the day', () => {
    expect(noticeToShow(s({ version: '0.1.1', at: T0 }), '0.1.0', T0 + 1000)).toBeNull()
  })
  it('shows it again the next day', () => {
    expect(noticeToShow(s({ version: '0.1.1', at: T0 }), '0.1.0', T0 + DAY)).toEqual(latest)
  })
  it('shows a newer version at once', () => {
    expect(noticeToShow(s({ version: '0.1.0', at: T0 }), '0.1.0', T0 + 1000)).toEqual(latest)
  })
  it('a stored link that is not ours is never shown', () => {
    expect(noticeToShow({ ...s(null), updateLatest: { version: '0.1.1', url: 'https://evil.example/x' } }, '0.1.0', T0)).toBeNull()
  })
})

describe('the service behind the buttons', () => {
  function service(initial: Partial<UpdateState> = {}, answer?: () => Promise<ReturnType<typeof reply>>, active = true) {
    const w = world(initial, answer)
    const opened: string[] = []
    const sent: unknown[] = []
    const svc = createUpdateService({ ...w.deps, active, openExternal: async (u) => void opened.push(u), send: (n) => void sent.push(n) })
    return { w, svc, opened, sent }
  }

  it('Download opens only our release pages, whatever the page asks', async () => {
    const { svc, opened } = service()
    await svc.open(PAGE('v0.1.1'))
    await expect(svc.open('https://evil.example/')).rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    await expect(svc.open('file:///etc/passwd')).rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    await expect(svc.open({ toString: () => PAGE('v0.1.1') })).rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    expect(opened).toEqual([PAGE('v0.1.1')])
  })
  it('pushes a newer version to the window once', async () => {
    const { svc, sent } = service({}, async () => reply(200, [rel('v0.1.1')]))
    await svc.run()
    await svc.run()
    expect(sent).toEqual([{ version: '0.1.1', url: PAGE('v0.1.1') }])
  })
  it('Not now is remembered, and garbage versions are ignored', async () => {
    const { svc, w } = service()
    await svc.dismiss('not a version')
    expect(w.state().updateDismissed).toBeNull()
    await svc.dismiss('0.1.1')
    expect(w.state().updateDismissed).toEqual({ version: '0.1.1', at: T0 })
  })
  it('turning checks off hides the notice; turning them on checks', async () => {
    const { svc, w, sent } = service({ updateCheckedAt: T0, updateLatest: { version: '0.1.1', url: PAGE('v0.1.1') } })
    expect((await svc.status()).notice?.version).toBe('0.1.1')
    expect(await svc.setEnabled(false)).toEqual({ enabled: false, notice: null })
    expect(sent).toEqual([null])
    w.tick(DAY)
    await svc.setEnabled(true)
    await svc.run()
    expect(w.calls).toHaveLength(1)
    expect((await svc.status()).enabled).toBe(true)
  })
  it('switched off while the request was out: nothing is saved or shown', async () => {
    let release!: () => void
    const { svc, w } = service({}, () => new Promise((r) => (release = () => r(reply(200, [rel('v0.1.1')])))))
    const pending = svc.run()
    await vi.waitFor(() => expect(w.calls).toHaveLength(1))
    await svc.setEnabled(false)
    release()
    expect(await pending).toBeNull()
    expect(w.state().updateLatest).toBeNull()
  })
  it('test runs never touch the network', async () => {
    const { svc, w } = service({}, undefined, false)
    expect(await svc.run()).toBeNull()
    svc.start(0, 10)
    await new Promise((r) => setTimeout(r, 30))
    svc.stop()
    expect(w.calls).toHaveLength(0)
  })
  it('start() checks a little after launch, not during it', async () => {
    vi.useFakeTimers()
    try {
      const { svc, w } = service()
      svc.start(8000)
      expect(w.calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(8000)
      expect(w.calls).toHaveLength(1)
      svc.stop()
    } finally {
      vi.useRealTimers()
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
