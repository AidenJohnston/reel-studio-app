import { describe, expect, it, vi } from 'vitest'
import { createPermissions, notificationsWanted, probeFolder, type PermissionDeps } from '../src/main/permissions'
import { pollPermissions } from '../src/shared/permission-poll'

const err = (code: string) => Object.assign(new Error(code), { code })

it('reads folder access from the error: EPERM is macOS privacy, EACCES is not', async () => {
  expect(await probeFolder('/x', 'darwin', async () => [])).toBe('allowed')
  expect(await probeFolder('/x', 'darwin', async () => Promise.reject(err('EPERM')))).toBe('denied')
  expect(await probeFolder('/x', 'darwin', async () => Promise.reject(err('EACCES')))).toBe('unusable')
  expect(await probeFolder('/x', 'darwin', async () => Promise.reject(err('ENOENT')))).toBe('not-asked')
})

const mac = (over: Partial<PermissionDeps> = {}) =>
  createPermissions({
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
    ...over
  })

it('on Windows an EPERM folder is one to replace, not a Mac privacy switch to turn on', async () => {
  // Node reports an ordinary "access denied" on Windows as EPERM, e.g. a network share the account can't list
  const probe = async () => Promise.reject(err('EPERM'))
  expect(await probeFolder('\\\\server\\share', 'win32', probe)).toBe('unusable')
  const perms = mac({ platform: 'win32', touched: true, probe })
  expect((await perms.status()).folder).toBe('unusable')
  // the folder could not be made at all: it stays missing, and Allow must not be offered forever
  const missing = mac({ platform: 'win32', ensureRoot: async () => Promise.reject(err('EPERM')), probe: async () => Promise.reject(err('ENOENT')) })
  expect((await missing.allowFolder()).folder).toBe('unusable')
})

it('never looks at the folder before Allow, because looking is what makes macOS ask', async () => {
  const probe = vi.fn(async () => [])
  expect((await mac({ probe }).status()).folder).toBe('not-asked')
  expect(probe).not.toHaveBeenCalled()
})

it('never reports notifications as allowed, because a shown notification does not mean macOS let it appear', async () => {
  let saved: boolean | null = null
  const load = async () => ({ notifications: saved, firstRunDone: true })
  const save = async (patch: { notifications: boolean }) => void (saved = patch.notifications)
  expect((await mac({ load, save }).setNotifications(true)).notifications).toBe('unverified')
  // after a restart
  expect((await mac({ load, save }).status()).notifications).toBe('unverified')
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
