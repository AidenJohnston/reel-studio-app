import { describe, expect, it, vi } from 'vitest'
import { createUpdater, type FoundUpdate, type UpdateBackend } from '../src/main/updater'
import { CHECK_INTERVAL_MS, SNOOZE_MS, updateMode, type UpdateMemory } from '../src/main/update-machine'
import { showsUpdateButton, updateAction } from '../src/shared/update'

function setup(
  found: () => Promise<FoundUpdate | null>,
  opts: { download?: (p: (n: number) => void) => Promise<void>; exporting?: boolean; memory?: Partial<UpdateMemory> } = {}
) {
  const installs: number[] = []
  let memory: UpdateMemory = { checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, ...opts.memory }
  let now = 1000
  const backend: UpdateBackend = {
    check: found,
    download: opts.download ?? (async (p) => [0, 40, 100].forEach(p)),
    install: () => void installs.push(1)
  }
  const u = createUpdater({
    version: '0.1.2',
    mode: 'install',
    disabledReason: null,
    backend,
    load: async () => memory,
    save: async (patch) => void (memory = { ...memory, ...patch }),
    busy: () => ({ exporting: !!opts.exporting, working: 0 }),
    prepareToQuit: async () => undefined,
    openExternal: async () => undefined,
    send: () => {},
    log: () => {},
    now: () => now
  })
  return { u, installs, memory: () => memory, tick: (ms: number) => void (now += ms) }
}

const v013: FoundUpdate = { version: '0.1.3', notes: '## What\'s new\n\n* **Updates install themselves.** More text.\n', releaseUrl: null }

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
      const { u } = setup(async () => (asks++, null), { memory: { updateCheckedAt: 1000 - CHECK_INTERVAL_MS + hour } })
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
    const a = setup(offline, { memory: { updateLatest: { version: '0.1.3', url: page, notes } } })
    await a.u.init()
    expect(a.u.state()).toMatchObject({ status: 'available', availableVersion: '0.1.3', releaseUrl: page, releaseNotes: notes })
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
    tick(SNOOZE_MS)
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

    await u.dismiss('0.1.4')
    tick(SNOOZE_MS)
    await u.check('test')
    expect(showsUpdateButton(u.state())).toBe(true)
  })
})

it('fails if Windows offers in-app installation', () => {
  expect(updateMode({ platform: 'win32', inApplications: true })).toBe('page')
})
