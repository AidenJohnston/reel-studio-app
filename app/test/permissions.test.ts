// macOS permission status (main/permissions.ts), the live checklist poller (shared/permission-poll.ts) and the
// first-run stage order (shared/setup.ts).
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPermissions,
  notificationsWanted,
  notifyAccess,
  parseFakes,
  probeFolder,
  type PermissionDeps
} from '../src/main/permissions'
import { CHECK_FAILED, PERMISSION_POLL_MS, pollPermissions, type PollEnv } from '../src/shared/permission-poll'
import { nextStage, setupStages } from '../src/shared/setup'

const err = (code: string) => Object.assign(new Error(code), { code })

describe('probeFolder', () => {
  it('reads the answer from the error: EPERM is macOS privacy, EACCES is not', async () => {
    expect(await probeFolder('/x', async () => [])).toBe('allowed')
    expect(await probeFolder('/x', async () => Promise.reject(err('EPERM')))).toBe('denied')
    expect(await probeFolder('/x', async () => Promise.reject(err('EACCES')))).toBe('unusable')
    expect(await probeFolder('/x', async () => Promise.reject(err('ENOTDIR')))).toBe('unusable')
    expect(await probeFolder('/x', async () => Promise.reject(err('ENOENT')))).toBe('not-asked')
  })

  it('a folder the drive will not let us write to is unusable, not allowed', async () => {
    const p = createPermissions(deps({ ensureRoot: async () => Promise.reject(err('EROFS')) }))
    expect((await p.allowFolder()).folder).toBe('unusable')
    p.markTouched() // a folder picked elsewhere starts over
    expect((await p.status()).folder).toBe('allowed')
  })

  it('works on a real folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-perm-'))
    expect(await probeFolder(dir)).toBe('allowed')
    expect(await probeFolder(join(dir, 'missing'))).toBe('not-asked')
  })
})

describe('notifications', () => {
  it('nothing chosen means on for older installs, Windows and Linux, off for a Mac still in setup', () => {
    expect(notificationsWanted({ notifications: null, firstRunDone: true }, 'darwin')).toBe(true)
    expect(notificationsWanted({ notifications: null, firstRunDone: false }, 'darwin')).toBe(false)
    expect(notificationsWanted({ notifications: null, firstRunDone: false }, 'win32')).toBe(true)
    expect(notificationsWanted({ notifications: null, firstRunDone: false }, 'linux')).toBe(true)
    expect(notificationsWanted({ notifications: false, firstRunDone: true }, 'win32')).toBe(false)
    expect(notificationsWanted({ notifications: true, firstRunDone: false }, 'darwin')).toBe(true)
  })

  it('maps the last test notification to a row state', () => {
    expect(notifyAccess({ supported: false, wanted: true, result: 'shown' })).toBe('unsupported')
    expect(notifyAccess({ supported: true, wanted: false, result: 'failed' })).toBe('off')
    expect(notifyAccess({ supported: true, wanted: true, result: null })).toBe('on')
    expect(notifyAccess({ supported: true, wanted: true, result: 'shown' })).toBe('on')
    expect(notifyAccess({ supported: true, wanted: true, result: 'failed' })).toBe('blocked')
    expect(notifyAccess({ supported: true, wanted: true, result: 'pending' })).toBe('asking')
  })
})

describe('parseFakes', () => {
  it('reads the test switch and refuses anything else loudly', () => {
    expect(parseFakes(undefined)).toEqual({})
    expect(parseFakes('folder=denied, notifications=failed')).toEqual({ folder: 'denied', notifications: 'failed' })
    expect(() => parseFakes('folder=maybe')).toThrow(/folder=maybe/)
    expect(() => parseFakes('camera=denied')).toThrow(/camera=denied/)
  })
})

type Help = Parameters<PermissionDeps['openPane']>[1]

function deps(over: Partial<PermissionDeps> = {}): PermissionDeps & { saved: { notifications?: boolean }; opened: { pane: string; help: Help }[] } {
  const saved: { notifications?: boolean } = {}
  const opened: { pane: string; help: Help }[] = []
  return {
    saved,
    opened,
    platform: 'darwin',
    root: () => '/Users/z/Documents/Reel Studio',
    rootDisplay: () => 'Documents › Reel Studio',
    touched: false,
    ensureRoot: async () => {},
    load: async () => ({ notifications: saved.notifications ?? null, firstRunDone: false, phoneNetworkAsked: false }),
    save: async (p) => Object.assign(saved, p),
    notificationsSupported: () => true,
    showTestNotification: async () => 'shown',
    openPane: async (pane, help) => void opened.push({ pane, help }),
    probe: async () => [],
    ...over
  }
}

describe('createPermissions', () => {
  it('never looks at the folder before Allow, because looking is what makes macOS ask', async () => {
    const probe = vi.fn(async () => [])
    const p = createPermissions(deps({ probe }))
    const st = await p.status()
    expect(st.folder).toBe('not-asked')
    expect(st.folderDisplay).toBe('Documents › Reel Studio')
    expect(probe).not.toHaveBeenCalled()
  })

  it('an existing install has touched the folder already, so its status is real from the start', async () => {
    const p = createPermissions(deps({ touched: true, probe: async () => Promise.reject(err('EPERM')) }))
    expect((await p.status()).folder).toBe('denied')
  })

  it('Allow makes the folder; a macOS "no" comes back as denied, not as an error', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rs-perm-'))
    const root = join(base, 'Reel Studio')
    const ok = createPermissions(deps({ root: () => root, probe: undefined, ensureRoot: async () => void mkdirSync(root, { recursive: true }) }))
    expect((await ok.allowFolder()).folder).toBe('allowed')
    expect(existsSync(root)).toBe(true)

    const no = createPermissions(deps({ ensureRoot: async () => Promise.reject(err('EPERM')), probe: async () => Promise.reject(err('EPERM')) }))
    expect((await no.allowFolder()).folder).toBe('denied')
  })

  it('after a "no", Allow opens Files and Folders with the helper, which closes once the folder can be made', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rs-perm-'))
    const root = join(base, 'Reel Studio')
    let denied = true
    const d = deps({
      root: () => root,
      probe: undefined,
      // macOS says no until it is turned on in System Settings; then the folder is made by itself
      ensureRoot: async () => (denied ? Promise.reject(err('EPERM')) : void mkdirSync(root, { recursive: true }))
    })
    const p = createPermissions({ ...d, probe: async (path) => (denied ? Promise.reject(err('EPERM')) : readdir(path)) })
    expect((await p.allowFolder()).folder).toBe('denied')
    expect(d.opened.map((o) => o.pane)).toEqual(['folder'])
    const granted = d.opened[0].help.isGranted!
    expect(await granted()).toBe(false)
    denied = false
    expect(await granted()).toBe(true)
    expect(existsSync(root)).toBe(true)
    expect((await p.status()).folder).toBe('allowed')
  })

  it('a folder picked in the system picker counts as asked', async () => {
    const p = createPermissions(deps())
    p.markTouched()
    expect((await p.status()).folder).toBe('allowed')
  })

  it('fakes stand in for macOS answers in test builds, and can change like System Settings would', async () => {
    const ensureRoot = vi.fn(async () => {})
    const p = createPermissions(deps({ ensureRoot, fakes: { folder: 'denied', notifications: 'failed' } }))
    expect((await p.allowFolder()).folder).toBe('denied')
    expect(ensureRoot).not.toHaveBeenCalled()
    expect((await p.setNotifications(true)).notifications).toBe('blocked')
    delete p.fakes.folder
    expect((await p.status()).folder).toBe('allowed')
  })

  it('turning notifications on shows one, and the answer decides the row; off forgets it', async () => {
    let answer: 'shown' | 'failed' | 'pending' = 'failed'
    const d = deps({ showTestNotification: async () => answer })
    const p = createPermissions(d)
    expect((await p.status()).notifications).toBe('off')
    expect((await p.setNotifications(true)).notifications).toBe('blocked')
    expect(d.saved.notifications).toBe(true)
    // blocked: the Notifications page opens; macOS cannot be asked, so closing the helper tries one notification
    expect(d.opened.map((o) => o.pane)).toEqual(['notifications'])
    expect(d.opened[0].help.isGranted).toBeUndefined()
    answer = 'shown'
    d.opened[0].help.onEnd!()
    await vi.waitFor(async () => expect((await p.status()).notifications).toBe('on'))
    answer = 'failed'
    expect((await p.setNotifications(true)).notifications).toBe('blocked')
    answer = 'pending'
    expect((await p.setNotifications(true)).notifications).toBe('asking')
    answer = 'shown'
    expect((await p.setNotifications(true)).notifications).toBe('on')
    expect((await p.setNotifications(false)).notifications).toBe('off')
    expect(d.saved.notifications).toBe(false)
  })

  it('says "asking" while the notification is still out', async () => {
    let finish: (v: 'shown') => void = () => {}
    const p = createPermissions(deps({ showTestNotification: () => new Promise((r) => (finish = r)) }))
    const pending = p.setNotifications(true)
    await vi.waitFor(async () => expect((await p.status()).notifications).toBe('asking'))
    finish('shown')
    expect((await pending).notifications).toBe('on')
  })

  it('opens only the known System Settings pages, and only on a Mac', async () => {
    const d = deps()
    const p = createPermissions(d)
    await p.openSettings('network')
    expect(d.opened.map((o) => o.pane)).toEqual(['network'])
    await expect(p.openSettings('https://example.com')).rejects.toThrow(/unknown settings page/)
    const win = deps({ platform: 'win32' })
    await createPermissions(win).openSettings('folder')
    expect(win.opened).toEqual([])
  })
})

/** A hand-driven clock and window for the poller. */
function fakeEnv() {
  const timers: (() => void)[] = []
  const wakes: (() => void)[] = []
  let hidden = false
  let every = 0
  const env: PollEnv = {
    hidden: () => hidden,
    every: (fn, ms) => {
      every = ms
      timers.push(fn)
      return () => timers.splice(timers.indexOf(fn), 1)
    },
    onWake: (fn) => {
      wakes.push(fn)
      return () => wakes.splice(wakes.indexOf(fn), 1)
    }
  }
  return {
    env,
    tick: () => timers.forEach((f) => f()),
    wake: () => wakes.forEach((f) => f()),
    hide: (h: boolean) => (hidden = h),
    interval: () => every,
    listeners: () => timers.length + wakes.length
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('pollPermissions', () => {
  it('checks at once, every 1.5 s, and on focus', async () => {
    const f = fakeEnv()
    const check = vi.fn(async () => 'ok')
    const seen: string[] = []
    pollPermissions(check, { status: (s) => seen.push(s), error: () => {} }, f.env)
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    expect(f.interval()).toBe(PERMISSION_POLL_MS)
    expect(PERMISSION_POLL_MS).toBe(1500)
    f.tick()
    await flush()
    f.wake()
    await flush()
    expect(check).toHaveBeenCalledTimes(3)
    expect(seen).toEqual(['ok', 'ok', 'ok'])
  })

  it('does not check while the window is hidden', async () => {
    const f = fakeEnv()
    f.hide(true)
    const check = vi.fn(async () => 1)
    pollPermissions(check, { status: () => {}, error: () => {} }, f.env)
    f.tick()
    await flush()
    expect(check).not.toHaveBeenCalled()
    f.hide(false)
    f.wake()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('runs one check at a time', async () => {
    const f = fakeEnv()
    let release: () => void = () => {}
    const check = vi.fn(() => new Promise<number>((r) => (release = () => r(1))))
    pollPermissions(check, { status: () => {}, error: () => {} }, f.env)
    f.tick()
    f.wake()
    expect(check).toHaveBeenCalledTimes(1)
    release()
    await flush()
    f.tick()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('says a check failed, keeps trying, and clears the message when one works', async () => {
    const f = fakeEnv()
    let fail = true
    const errors: (string | null)[] = []
    pollPermissions(async () => (fail ? Promise.reject(new Error('x')) : 1), { status: () => {}, error: (e) => errors.push(e) }, f.env)
    await flush()
    expect(errors).toEqual([CHECK_FAILED])
    fail = false
    f.tick()
    await flush()
    expect(errors).toEqual([CHECK_FAILED, null])
  })

  it('stops completely, and drops an answer that arrives after it stopped', async () => {
    const f = fakeEnv()
    let release: () => void = () => {}
    const seen: number[] = []
    const stop = pollPermissions(() => new Promise<number>((r) => (release = () => r(1))), { status: (s) => seen.push(s), error: () => {} }, f.env)
    stop()
    expect(f.listeners()).toBe(0)
    release()
    await flush()
    expect(seen).toEqual([])
  })
})

describe('setup stages', () => {
  it('asks the Mac questions first, and skips them on Windows and Linux', () => {
    expect(setupStages('darwin')).toEqual(['mac', 'listening', 'ai'])
    expect(setupStages('win32')).toEqual(['listening', 'ai'])
    expect(setupStages('linux')).toEqual(['listening', 'ai'])
  })

  it('walks the stages in order and ends after the AI editor', () => {
    const mac = setupStages('darwin')
    expect(nextStage(mac, 'mac')).toBe('listening')
    expect(nextStage(mac, 'listening')).toBe('ai')
    expect(nextStage(mac, 'ai')).toBeNull()
    expect(() => nextStage(setupStages('win32'), 'mac')).toThrow(/unknown setup stage/)
  })
})
