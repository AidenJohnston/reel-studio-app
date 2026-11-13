// The update state machine (main/updater.ts) on a fake backend: what each answer offers, the once-a-day schedule,
// "Not now", restarting safely, and what a missing or refused download key does.
import { createJobManager } from '../src/main/jobs'
import { AUTO_UPDATES_PAGE, UPDATE_PAGE, newerOnSite, type FetchLike } from '../src/main/update-check'
import { describe, expect, it, vi } from 'vitest'
import { createUpdater, menuCheckForUpdates, type PageReason, type UpdateBackend } from '../src/main/updater'
import { disabledReason, updateMode, type UpdateMemory } from '../src/main/update-machine'
import { showsUpdateButton, updateAction } from '../src/shared/update'
import type { UpdateNotice } from '../src/shared/api'
import { updateButtonLabel } from '../src/renderer/src/components/update-copy'

function setup(
  found: () => Promise<UpdateNotice | null>,
  opts: {
    download?: (version: string, p: (n: number) => void) => Promise<PageReason | null | void>
    verify?: () => Promise<void>
    exporting?: boolean
    prepareToQuit?: () => Promise<void>
    load?: () => Promise<UpdateMemory>
    memory?: Partial<UpdateMemory>
    backend?: UpdateBackend
    disabledReason?: string
    mode?: 'install' | 'page'
    /** A download key is saved. Default yes. */
    keyed?: boolean
  } = {}
) {
  const installs: number[] = []
  const opened: string[] = []
  let memory: UpdateMemory = { checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, ...opts.memory }
  let now = 1000
  const key = { saved: opts.keyed ?? true }
  const backend: UpdateBackend = {
    check: found,
    hasKey: async () => key.saved,
    download: async (version, p) => (await (opts.download ?? (async (_v, pr) => [0, 40, 100].forEach(pr)))(version, p)) ?? null,
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
  return { u, installs, opened, key, memory: () => memory, tick: (ms: number) => void (now += ms) }
}

const PAGE = `${UPDATE_PAGE}?v=0.1.3`
const v013: UpdateNotice = { version: '0.1.3', url: PAGE }

describe('state machine', () => {
  it('fails if a later check hides an already downloaded update', async () => {
    let latest: UpdateNotice | null = v013
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
      if (offline) throw new Error('getaddrinfo ENOTFOUND dl.getreelstudio.com')
      return v013
    }, {
      download: async () => {
        if (broken) throw new Error('sha512 checksum mismatch')
        if (offline) throw new Error('getaddrinfo ENOTFOUND dl.getreelstudio.com')
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
      const { u } = setup(async () => (asks++, v013), {
        memory: { updateLatest: { version: '0.1.3', url: PAGE } },
        download: () => new Promise<void>((r) => (finish = r))
      })
      await u.init()
      // Busy retries do not call the backend, so their delay must be observed to catch a CPU-spinning loop.
      const timers = vi.spyOn(globalThis, 'setTimeout')
      u.start()
      void u.download() // confirms the remembered release (one ask), then downloads until finish()
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
  it('fails if an offline start loses its notice, keeps an installed version, or drops one an older build saved', async () => {
    const offline = async (): Promise<UpdateNotice | null> => Promise.reject(new Error('getaddrinfo ENOTFOUND dl.getreelstudio.com'))
    const a = setup(offline, { memory: { updateLatest: { version: '0.1.3', url: PAGE } } })
    await a.u.init()
    expect(a.u.state()).toMatchObject({ status: 'available', availableVersion: '0.1.3', releaseUrl: PAGE })
    await a.u.download()
    expect(a.u.state()).toMatchObject({ status: 'error', errorContext: 'download', availableVersion: '0.1.3' })

    const b = setup(offline, { memory: { updateLatest: { version: '0.1.2', url: PAGE } } })
    await b.u.init()
    expect(b.u.state().status).toBe('idle')
    expect(b.memory().updateLatest).toBeNull()

    // A GitHub release page saved before downloads moved to getreelstudio.com: the update page instead.
    const c = setup(offline, { memory: { updateLatest: { version: '0.1.3', url: 'https://github.com/owner/reel-studio-app/releases/tag/v0.1.3' } } })
    await c.u.init()
    expect(c.u.state()).toMatchObject({ status: 'available', releaseUrl: UPDATE_PAGE })
  })

  it('fails if a remembered release downloads without asking latest.json again, or downloads one it no longer names', async () => {
    const downloaded: string[] = []
    const { u } = setup(async () => ({ version: '0.1.4', url: UPDATE_PAGE }), {
      memory: { updateLatest: { version: '0.1.3', url: PAGE } },
      download: async (v) => void downloaded.push(v)
    })
    await u.init()
    await u.download()
    expect(downloaded).toEqual([])
    expect(u.state()).toMatchObject({ status: 'available', availableVersion: '0.1.4' })
    await u.download()
    expect(downloaded).toEqual(['0.1.4'])
  })
})

describe('turning "Check for updates" back on', () => {
  it('fails if enabling checks loses a remembered, snoozed update', async () => {
    const page = PAGE
    const { u, tick } = setup(async () => Promise.reject(new Error('getaddrinfo ENOTFOUND dl.getreelstudio.com')), {
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

  it('fails if the Mac menu sends someone to the sidebar button after Not now hid it', async () => {
    const { u } = setup(async () => v013)
    await u.init()
    await u.check('test')
    await u.download()
    const said: string[] = []
    const ui = { focus: () => {}, show: async (o: { detail?: string }) => { said.push(o.detail ?? ''); return { response: 0 } } }
    await menuCheckForUpdates(u, ui)
    expect(said.at(-1)).toMatch(/sidebar/)
    await u.dismiss('0.1.3')
    await menuCheckForUpdates(u, ui)
    expect(showsUpdateButton(u.state())).toBe(false)
    expect(said.at(-1)).toBe('To install it, open Settings and choose Restart to update.')
  })
})

it('fails if a copy that cannot replace itself tries to: Windows (for now), a Mac app outside Applications, no update feed', () => {
  expect(updateMode({ platform: 'win32', inApplications: false, hasFeed: true })).toBe('page')
  expect(updateMode({ platform: 'darwin', inApplications: true, hasFeed: true })).toBe('install')
  expect(updateMode({ platform: 'darwin', inApplications: false, hasFeed: true })).toBe('page')
  for (const platform of ['win32', 'darwin'] as const) expect(updateMode({ platform, inApplications: true, hasFeed: false })).toBe('page')
})

it('fails if Download or Restart is dropped during a background check', async () => {
  let finish: ((value: UpdateNotice | null) => void) | undefined
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
  let finish!: (value: UpdateNotice | null) => void
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

it.each(['HTTP failure', 'malformed JSON', 'timeout'])('fails if a failed request is remembered and suppresses a reopened app: %s', async (failure) => {
  const fetch: FetchLike = vi.fn(async () => {
    if (failure === 'timeout') throw new DOMException('The operation timed out', 'TimeoutError')
    return { ok: failure !== 'HTTP failure', status: failure === 'HTTP failure' ? 500 : 200, json: async () => JSON.parse('{broken') }
  })
  const check = () => newerOnSite(fetch, '0.1.2')
  const first = setup(check, { memory: { updateCheckedAt: -86_400_000 } })
  await first.u.init()
  await first.u.check('auto')
  expect(first.memory().updateCheckedAt).toBe(-86_400_000)
  const reopened = setup(check, { memory: first.memory() })
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

it('fails if a download page opens anything but a page on the site', async () => {
  const { u, opened } = setup(async () => ({ version: '0.1.3', url: 'file:///tmp/update' }), { mode: 'page' })
  await u.check('button')
  expect(updateAction(u.state())).toBe('open-page')
  await u.openRelease()
  await u.openAutoUpdatesPage()
  expect(opened).toEqual([UPDATE_PAGE, AUTO_UPDATES_PAGE])
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
  expect(opened).toEqual([PAGE])
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

describe('the download key', () => {
  it('fails if a copy with no key offers a download instead of the page and "Turn on automatic updates", or misses a key saved later', async () => {
    const downloaded: string[] = []
    const { u, key } = setup(async () => v013, { keyed: false, download: async (v) => void downloaded.push(v) })
    await u.init()
    await u.check('button')
    expect(u.state()).toMatchObject({ status: 'available', mode: 'page', keyNeeded: true })
    expect(updateButtonLabel(u.state())).toBe('Open download page')
    expect((await u.download()).accepted).toBe(false)
    expect(downloaded).toEqual([])
    key.saved = true
    u.keyChanged(true)
    expect(u.state()).toMatchObject({ status: 'available', mode: 'install', keyNeeded: false })
    await u.download()
    expect(downloaded).toEqual(['0.1.3'])
  })

  it('fails if a key the server refuses (401) keeps offering downloads, or a refused purchase (403) asks for a key', async () => {
    let answer: PageReason = 'key-rejected'
    const { u } = setup(async () => v013, { download: async () => answer })
    await u.check('button')
    await u.download()
    // The backend has cleared the key (test/updater-electron.test.ts): the page, and the way to turn updates on again.
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'download', mode: 'page', keyNeeded: true, downloadedVersion: null })
    expect(u.state().message).toMatch(/did not accept the download key/)
    expect(updateAction(u.state())).toBe('open-page')

    u.keyChanged(true) // a new key from the receipt email
    expect(u.state()).toMatchObject({ status: 'available', mode: 'install' })
    answer = 'not-entitled'
    await u.download()
    expect(u.state()).toMatchObject({ status: 'error', mode: 'page', keyNeeded: false })
    expect(u.state().message).toMatch(/no longer includes new versions/)
    await u.check('later') // the same release stays on the page until another key arrives
    expect(u.state()).toMatchObject({ mode: 'page', keyNeeded: false })
    u.keyChanged(true)
    expect(u.state()).toMatchObject({ status: 'available', mode: 'install' })
  })

  it('fails if a feed that names another version, or none for this platform, hides the update', async () => {
    const { u } = setup(async () => v013, { download: async () => 'feed' })
    await u.check('button')
    await u.download()
    expect(u.state()).toMatchObject({ status: 'error', mode: 'page', keyNeeded: false, availableVersion: '0.1.3' })
    expect(showsUpdateButton(u.state())).toBe(true)
    expect(updateAction(u.state())).toBe('open-page')
  })
})
