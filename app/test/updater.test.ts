import { createJobManager } from '../src/main/jobs'
import { releasePageBackend, type FoundUpdate, type FetchLike } from '../src/main/update-check'
import { describe, expect, it, vi } from 'vitest'
import { createUpdater, type UpdateBackend } from '../src/main/updater'
import { disabledReason, updateMode, type UpdateMemory } from '../src/main/update-machine'
import { showsUpdateButton, updateAction } from '../src/shared/update'
import { updateButtonLabel } from '../src/renderer/src/components/update-copy'

function setup(
  found: () => Promise<FoundUpdate | null>,
  opts: { download?: (p: (n: number) => void) => Promise<void>; verify?: () => Promise<void>; exporting?: boolean; prepareToQuit?: () => Promise<void>; load?: () => Promise<UpdateMemory>; memory?: Partial<UpdateMemory>; backend?: UpdateBackend; disabledReason?: string; mode?: 'install' | 'page' } = {}
) {
  const installs: number[] = []
  const opened: string[] = []
  let memory: UpdateMemory = { checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, ...opts.memory }
  let now = 1000
  const backend: UpdateBackend = {
    check: async () => {
      const update = await found()
      return { update, releases: update ? [update] : [] }
    },
    download: opts.download ?? (async (p) => [0, 40, 100].forEach(p)),
    verify: opts.verify ?? (async () => undefined),
    install: () => void installs.push(1)
  }
  const u = createUpdater({
    version: '0.1.2',
    mode: opts.mode ?? 'install',
    disabledReason: opts.disabledReason ?? null,
    backend: opts.backend ?? backend,
    load: opts.load ?? (async () => memory),
    save: async (patch) => void (memory = { ...memory, ...patch }),
    busy: () => ({ exporting: !!opts.exporting, working: 0 }),
    prepareToQuit: opts.prepareToQuit ?? (async () => undefined),
    openExternal: async (url) => { opened.push(url) },
    send: () => {},
    log: () => {},
    now: () => now
  })
  return { u, installs, opened, memory: () => memory, tick: (ms: number) => void (now += ms) }
}

const v013: FoundUpdate = { version: '0.1.3', notes: '## What\'s new\n\n* **Updates install themselves.** More text.\n', releaseUrl: 'https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.3' }

describe('state machine', () => {
  it('fails if a later check hides an already downloaded update', async () => {
    let latest: FoundUpdate | null = v013
    const { u } = setup(async () => latest)
    await u.check('test')
    await u.download()
    latest = null
    await u.check('again')
    expect(u.state()).toMatchObject({ status: 'downloaded', downloadedVersion: '0.1.3' })
  })

  it('fails if a stopped download cannot retry or a failed install loses the download', async () => {
    let broken = true
    let offline = false
    const { u } = setup(async () => {
      if (offline) throw new Error('getaddrinfo ENOTFOUND github.com')
      return v013
    }, {
      download: async () => {
        if (broken) throw new Error('sha512 checksum mismatch')
      }
    })
    await u.check('test')
    await u.download()
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'download', availableVersion: '0.1.3' })
    expect(updateAction(u.state())).toBe('download')

    broken = false
    offline = true
    await u.check('again')
    await u.download()
    expect(u.state().errorContext).toBe('download')
    offline = false
    await u.download()
    expect(u.state().status).toBe('downloaded')
    await u.install()
    u.installFailed(new Error('Code signature did not match'))
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'install', downloadedVersion: '0.1.3' })
    expect(updateAction(u.state())).toBe('install')
  })

  it('fails if installing interrupts an export', async () => {
    const { u, installs } = setup(async () => v013, { exporting: true })
    await u.check('test')
    await u.download()
    expect(await u.install()).toMatchObject({ accepted: false, refused: 'exporting' })
    expect(installs).toHaveLength(0)
  })
})

describe('once a day', () => {
  it("fails if reopening the app checks again before a day has passed", async () => {
    vi.useFakeTimers()
    try {
      let asks = 0
      const hour = 60 * 60 * 1000
      const { u } = setup(async () => (asks++, null), { memory: { updateCheckedAt: 1000 - 86_400_000 + hour } })
      await u.init()
      u.start()
      await vi.advanceTimersByTimeAsync(hour - 1)
      expect(asks).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(asks).toBe(1)
      u.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a check that falls while a download runs', () => {
  it('fails if a busy automatic check spins instead of retrying later', async () => {
    vi.useFakeTimers()
    try {
      let asks = 0
      let finish!: () => void
      const page = 'https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.3'
      const { u } = setup(async () => (asks++, v013), {
        memory: { updateLatest: { version: '0.1.3', url: page } },
        download: () => new Promise<void>((r) => (finish = r))
      })
      await u.init()
      // Busy retries do not call the backend, so their delay must be observed to catch a CPU-spinning loop.
      const timers = vi.spyOn(globalThis, 'setTimeout')
      u.start()
      void u.download() // reads the release (one ask), then downloads until finish()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(asks).toBe(1)
      expect(timers.mock.calls.some(([, ms]) => ms === 0)).toBe(false)
      timers.mockRestore()
      finish()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(asks).toBe(2)
      u.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('remembered across launches', () => {
  it('fails if an offline start loses its notice or keeps an installed version', async () => {
    const offline = async (): Promise<FoundUpdate | null> => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'))
    const page = 'https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.3'
    const notes = { version: '0.1.3', items: ['Updates install themselves.'], totalItems: 1 }
    const a = setup(offline, { memory: { updateLatest: { version: '0.1.3', url: page, notes: [notes] } } })
    await a.u.init()
    expect(a.u.state()).toMatchObject({ status: 'available', availableVersion: '0.1.3', releaseUrl: page, releaseNotes: [notes] })
    await a.u.download()
    expect(a.u.state()).toMatchObject({ status: 'error', errorContext: 'download', availableVersion: '0.1.3' })

    const b = setup(offline, { memory: { updateLatest: { version: '0.1.2', url: page } } })
    await b.u.init()
    expect(b.u.state().status).toBe('idle')
    expect(b.memory().updateLatest).toBeNull()
  })
})

describe('turning "Check for updates" back on', () => {
  it('fails if enabling checks loses a remembered, snoozed update', async () => {
    const page = 'https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.3'
    const { u, tick } = setup(async () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')), {
      memory: { checkUpdates: false, updateLatest: { version: '0.1.3', url: page }, updateDismissed: { version: '0.1.3', at: 1000 } }
    })
    await u.init()
    expect(u.state().availableVersion).toBeNull()
    await u.setEnabled(true)
    expect(u.state()).toMatchObject({ status: 'available', availableVersion: '0.1.3', releaseUrl: page, snoozed: true })
    tick(86_400_000)
    await u.setEnabled(false)
    expect(showsUpdateButton(u.state())).toBe(false)
  })
})

describe('"Not now"', () => {
  it('fails if snooze is not persisted, expires early, or hides a newer release', async () => {
    let latest = v013
    const { u, tick, memory } = setup(async () => latest)
    await u.init()
    await u.check('test')
    await u.dismiss('0.1.3')
    expect(memory().updateDismissed).toEqual({ version: '0.1.3', at: 1000 })
    expect(showsUpdateButton(u.state())).toBe(false)
    expect(updateAction(u.state())).toBe('download')

    latest = { ...v013, version: '0.1.4' }
    await u.check('test')
    expect(showsUpdateButton(u.state())).toBe(true)

    vi.useFakeTimers()
    try {
      await u.dismiss('0.1.4')
      tick(86_399_999)
      await vi.advanceTimersByTimeAsync(86_399_999)
      expect(showsUpdateButton(u.state())).toBe(false)
      tick(2)
      await vi.advanceTimersByTimeAsync(2)
      expect(showsUpdateButton(u.state())).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

it('fails if Windows cannot install in-app, or a copy without an update feed tries to', () => {
  expect(updateMode({ platform: 'win32', inApplications: false, hasFeed: true })).toBe('install')
  expect(updateMode({ platform: 'darwin', inApplications: true, hasFeed: true })).toBe('install')
  expect(updateMode({ platform: 'darwin', inApplications: false, hasFeed: true })).toBe('page')
  for (const platform of ['win32', 'darwin'] as const) expect(updateMode({ platform, inApplications: true, hasFeed: false })).toBe('page')
})

it('fails if Download or Restart is dropped during a background check', async () => {
  let finish: ((value: FoundUpdate | null) => void) | undefined
  let slow = false
  const { u, installs } = setup(() => slow ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(v013))
  await u.check('first')
  slow = true
  const checking = u.check('background')
  const downloading = u.download()
  finish!(v013)
  await checking
  expect((await downloading).state.downloadedVersion).toBe('0.1.3')
  const nextCheck = u.check('background')
  const installing = u.install()
  finish!(v013)
  await nextCheck
  expect((await installing).accepted).toBe(true)
  expect(installs).toHaveLength(1)
})

it('fails if new work is allowed during restart preparation or remains blocked after failure', async () => {
  let fail!: (error: Error) => void
  let releaseRead!: () => void
  let reading!: () => void
  const readStarted = new Promise<void>((resolve) => { reading = resolve })
  const { u } = setup(async () => v013, {
    prepareToQuit: () => new Promise((_resolve, reject) => { fail = reject }),
    load: () => new Promise((resolve) => {
      releaseRead = () => resolve({ checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null })
      reading()
    })
  })
  const enabling = u.setEnabled(true)
  await readStarted
  await u.check('first')
  await u.download()
  const installing = u.install()
  releaseRead()
  await enabling
  expect(u.state().status).toBe('installing')
  const jobs = createJobManager(() => {}, () => {}, undefined, undefined, () => u.assertCanStartWork())
  expect(() => jobs.start(null, 'rerender', async () => ({ summary: '' }))).toThrow(expect.objectContaining({ code: 'UPDATING' }))
  expect(jobs.runningCount()).toBe(0)
  fail(new Error('shutdown failed'))
  await installing
  expect(() => u.assertCanStartWork()).not.toThrow()
})

it.each(['auto', 'auto reenabled', 'manual', 'joined manual'])('fails if opt-out publishes an automatic result or drops an explicit check: %s', async (reason) => {
  let finish!: (value: FoundUpdate | null) => void
  const { u, memory } = setup(() => new Promise((resolve) => { finish = resolve }))
  await u.init()
  const checking = u.check(reason === 'manual' ? 'button' : 'auto')
  await u.setEnabled(false)
  if (reason === 'auto reenabled') await u.setEnabled(true)
  const manual = reason === 'joined manual' ? u.check('button') : null
  finish(v013)
  await checking
  await manual
  const explicit = reason === 'manual' || reason === 'joined manual'
  expect(u.state().status).toBe(explicit ? 'available' : 'idle')
  expect(memory().updateLatest?.version ?? null).toBe(explicit ? '0.1.3' : null)
  expect(memory().updateCheckedAt).toBe(explicit ? 1000 : null)
})

it.each([
  [429, {}],
  [403, { 'x-ratelimit-remaining': '0' }],
  [403, { 'retry-after': '60' }]
] satisfies [number, Record<string, string>][])('fails if GitHub rate limit %s loses the notice or checks again within 24 hours', async (status, headers) => {
  vi.useFakeTimers()
  const responseHeaders = new Map(Object.entries(headers))
  const fetch: FetchLike = vi.fn(async () => ({ ok: false, status, headers: { get: (name: string) => responseHeaders.get(name) ?? null }, json: async () => ({}) }))
  const notice = { version: v013.version, url: v013.releaseUrl }
  const backend = releasePageBackend(fetch, '0.1.2')
  const { u, memory } = setup(async () => null, { backend, memory: { updateLatest: notice } })
  let reopened: ReturnType<typeof setup> | undefined
  try {
    await u.init()
    await u.check('auto')
    expect(memory().updateCheckedAt).toBe(1000)
    expect(memory().updateLatest).toEqual(notice)
    expect(u.state().availableVersion).toBe('0.1.3')
    reopened = setup(async () => null, { backend, memory: memory() })
    await reopened.u.init()
    reopened.u.start()
    reopened.tick(86_399_999)
    await vi.advanceTimersByTimeAsync(86_399_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    reopened.tick(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    reopened?.u.stop()
    u.stop()
    vi.useRealTimers()
  }
})

it.each(['HTTP failure', 'malformed JSON', 'timeout'])('fails if a failed request is remembered and suppresses a reopened app: %s', async (failure) => {
  const fetch: FetchLike = vi.fn(async () => {
    if (failure === 'timeout') throw new DOMException('The operation timed out', 'TimeoutError')
    return { ok: failure !== 'HTTP failure', status: failure === 'HTTP failure' ? 500 : 200, headers: { get: () => null }, json: async () => JSON.parse('{broken') }
  })
  const backend = releasePageBackend(fetch, '0.1.2')
  const first = setup(async () => null, { backend, memory: { updateCheckedAt: -86_400_000 } })
  await first.u.init()
  await first.u.check('auto')
  expect(first.memory().updateCheckedAt).toBe(-86_400_000)
  const reopened = setup(async () => null, { backend, memory: first.memory() })
  vi.useFakeTimers()
  try {
    await reopened.u.init()
    reopened.u.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(reopened.memory().updateCheckedAt).toBe(-86_400_000)
  } finally {
    reopened.u.stop()
    vi.useRealTimers()
  }
})

it.each([86_400_000 * 5, NaN])('fails if a future or invalid persisted check time suppresses startup: %s', async (updateCheckedAt) => {
  const found = vi.fn(async () => null)
  const { u } = setup(found, { memory: { updateCheckedAt } })
  vi.useFakeTimers()
  try {
    await u.init()
    u.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(found).toHaveBeenCalledTimes(1)
  } finally {
    u.stop()
    vi.useRealTimers()
  }
})

it('fails if Windows cannot find an eligible release or opens an untrusted release URL', async () => {
  const fetch: FetchLike = async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => [
      { tag_name: 'ffmpeg-7.1.1-rs3', draft: false },
      { tag_name: 'v0.1.4', draft: true },
      { tag_name: 'v0.1.3', draft: false, prerelease: true, html_url: 'https://evil.example/release' }
    ]
  })
  const { u, opened } = setup(async () => null, { mode: 'page', backend: releasePageBackend(fetch, '0.1.2') })
  await u.init()
  await u.check('button')
  expect(updateAction(u.state())).toBe('open-page')
  await u.openRelease()
  expect(opened).toEqual([v013.releaseUrl])
  const malicious = setup(async () => ({ ...v013, releaseUrl: 'file:///tmp/update' }), { mode: 'page' })
  await malicious.u.check('button')
  await malicious.u.openRelease()
  expect(malicious.opened).toEqual([v013.releaseUrl])
})

it.each(['opted out', 'test run', 'development build'])('fails if automatic network requests run when disabled: %s', async (configuration) => {
  const found = vi.fn(async () => v013)
  const { u } = setup(found, { memory: { checkUpdates: configuration !== 'opted out' }, disabledReason: disabledReason({ platform: 'darwin', isPackaged: configuration !== 'development build', test: configuration === 'test run', hasFeed: true, inApplications: true }) ?? undefined })
  vi.useFakeTimers()
  try {
    await u.init()
    u.start()
    await vi.advanceTimersByTimeAsync(2 * 86_400_000)
    await u.check('auto')
    expect(found).not.toHaveBeenCalled()
    if (configuration === 'opted out') {
      await u.check('button')
      expect(found).toHaveBeenCalledTimes(1)
    }
  } finally {
    u.stop()
    vi.useRealTimers()
  }
})

describe('release notes from the GitHub list', () => {
  const page = (tag: string) => `https://github.com/AidenJohnston/reel-studio-app/releases/tag/${tag}`
  const whatsNew = (...items: string[]) => ["## What's new", '', ...items.map((i) => `* ${i}`), '', '## Download', '', '* Windows: the installer.'].join('\n')
  const installOnly = '# Reel Studio 0.1.3 (preview)\n\nTurn a raw talking-head video into a finished, postable Reel. Drop in your takes.\n\n## First open\n\n* **Windows:** SmartScreen says "Windows protected your PC".'
  const list = [
    { tag_name: 'ffmpeg-7.1.1-rs3', draft: false, body: 'Source.', published_at: '2026-11-20T10:00:00Z' },
    { tag_name: 'v0.1.6', draft: true, body: whatsNew('Draft.') },
    { tag_name: 'v0.1.4', draft: false, html_url: page('v0.1.4'), body: whatsNew('**Send to my phone over a QR code.** Scan it once.'), published_at: '2026-11-09T18:00:00Z' },
    { tag_name: 'v0.1.5', draft: false, html_url: page('v0.1.5'), body: whatsNew('**Captions you can drag.** Grab one.', 'Music ducks under your voice'), published_at: '2026-11-18T18:00:00Z' },
    { tag_name: 'v0.1.3', draft: false, html_url: page('v0.1.3'), body: installOnly, published_at: '2026-10-30T18:00:00Z' },
    { tag_name: 'v0.1.2', draft: false, html_url: page('v0.1.2'), body: whatsNew('**Use your own Claude.** Every installer offers it.'), published_at: '2026-10-21T00:47:16Z' }
  ]
  const github = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body })

  it("fails if the update popover drops a skipped release's notes or shows install steps as changes", async () => {
    const { u } = setup(async () => null, { backend: releasePageBackend(github(list), '0.1.2'), mode: 'page' })
    await u.check('button')
    expect(u.state().releaseNotes).toEqual([
      { version: '0.1.5', items: ['Captions you can drag.', 'Music ducks under your voice'], totalItems: 2 },
      { version: '0.1.4', items: ['Send to my phone over a QR code.'], totalItems: 1 }
    ])
    expect(JSON.stringify(u.state())).not.toContain('SmartScreen')
  })

})

it('fails if a download that does not pass its check stops a video or offers the same cached file again', async () => {
  let jobs!: ReturnType<typeof createJobManager>
  let downloads = 0
  const { u, installs, opened } = setup(async () => v013, {
    download: async () => void downloads++,
    verify: async () => { throw new Error('Update bundle version 0.1.4 does not match the newer release 0.1.3.') },
    prepareToQuit: () => jobs.cancelAll()
  })
  jobs = createJobManager(() => {}, () => {}, undefined, undefined, () => u.assertCanStartWork())
  await u.check('button')
  await u.download()
  jobs.start(null, 'rerender', (_emit, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))))
  await u.install()
  expect(jobs.runningCount()).toBe(1)
  expect(installs).toHaveLength(0)
  expect(u.state()).toMatchObject({ status: 'error', mode: 'page', availableVersion: '0.1.3', downloadedVersion: null })
  expect(u.state().message).toContain('download page')
  expect(updateAction(u.state())).toBe('open-page')
  expect(updateButtonLabel(u.state())).toBe('Open download page')
  expect(showsUpdateButton(u.state())).toBe(true)
  expect((await u.download()).accepted).toBe(false)
  await u.check('later')
  expect(updateAction(u.state())).toBe('open-page')
  await u.openRelease()
  expect(opened).toEqual([v013.releaseUrl])
  expect(downloads).toBe(1)
})

it('fails if a download started with automatic checks off, or after Not now, leaves no strip to restart from', async () => {
  const { u, memory } = setup(async () => v013, { memory: { checkUpdates: false } })
  await u.init()
  await u.check('button')
  await u.dismiss('0.1.3')
  expect(showsUpdateButton(u.state())).toBe(false)
  await u.download()
  expect(u.state().status).toBe('downloaded')
  expect(showsUpdateButton(u.state())).toBe(true)
  expect(memory().updateDismissed).toBeNull()
})
