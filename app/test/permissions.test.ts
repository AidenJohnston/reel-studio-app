import { describe, expect, it, vi } from 'vitest'
import { createPermissions, notificationsWanted, probeFolder } from '../src/main/permissions'
import { pollPermissions } from '../src/shared/permission-poll'

const err = (code: string) => Object.assign(new Error(code), { code })

it('reads folder access from the error: EPERM is macOS privacy, EACCES is not', async () => {
  expect(await probeFolder('/x', async () => [])).toBe('allowed')
  expect(await probeFolder('/x', async () => Promise.reject(err('EPERM')))).toBe('denied')
  expect(await probeFolder('/x', async () => Promise.reject(err('EACCES')))).toBe('unusable')
  expect(await probeFolder('/x', async () => Promise.reject(err('ENOENT')))).toBe('not-asked')
})

it('never looks at the folder before Allow, because looking is what makes macOS ask', async () => {
  const probe = vi.fn(async () => [])
  const p = createPermissions({
    platform: 'darwin',
    root: () => '/Users/z/Documents/Reel Studio',
    rootDisplay: () => 'Documents › Reel Studio',
    touched: false,
    ensureRoot: async () => {},
    load: async () => ({ notifications: null, firstRunDone: false }),
    save: async () => {},
    notificationsSupported: () => true,
    showTestNotification: async () => 'shown',
    openPane: async () => {},
    probe
  })
  expect((await p.status()).folder).toBe('not-asked')
  expect(probe).not.toHaveBeenCalled()
})

it('notifications: on for older installs, Windows and Linux; a new Mac user decides in setup', () => {
  expect(notificationsWanted({ notifications: null, firstRunDone: true }, 'darwin')).toBe(true)
  expect(notificationsWanted({ notifications: null, firstRunDone: false }, 'darwin')).toBe(false)
  expect(notificationsWanted({ notifications: null, firstRunDone: false }, 'win32')).toBe(true)
  expect(notificationsWanted({ notifications: false, firstRunDone: true }, 'darwin')).toBe(false)
})

describe('pollPermissions', () => {
  it('checks at once, on every tick and on focus, but not while the window is hidden', async () => {
    const timers: (() => void)[] = []
    const wakes: (() => void)[] = []
    let hidden = false
    const check = vi.fn(async () => 'ok')
    pollPermissions(check, { status: () => {}, error: () => {} }, {
      hidden: () => hidden,
      every: (fn) => (timers.push(fn), () => {}),
      onWake: (fn) => (wakes.push(fn), () => {})
    })
    const flush = () => new Promise((r) => setTimeout(r, 0))
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    hidden = true
    timers[0]()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    hidden = false
    wakes[0]()
    await flush()
    expect(check).toHaveBeenCalledTimes(2)
  })
})
