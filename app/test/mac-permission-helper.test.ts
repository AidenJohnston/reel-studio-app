// The helper window's life (main/mac-permission-helper.ts), with Electron and the Settings tracker faked, as in
// T3 Code's MacPermissionHelper.test.ts.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SettingsWindow } from '../src/main/mac-settings-window'

const mocks = vi.hoisted(() => ({
  createFromPath: vi.fn(),
  startDrag: vi.fn(),
  loadURL: vi.fn(),
  stopTracking: vi.fn(),
  settingsChanged: undefined as ((s: SettingsWindow) => void) | undefined,
  trackingFailed: undefined as ((ended: boolean) => void) | undefined,
  ipc: undefined as unknown as import('node:events').EventEmitter
}))
const windows = vi.hoisted(
  () =>
    [] as Array<{
      destroyed: boolean
      webContents: { mainFrame: object }
      setBounds: ReturnType<typeof vi.fn>
      hide: ReturnType<typeof vi.fn>
      showInactive: ReturnType<typeof vi.fn>
      emit: (e: string) => void
    }>
)
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class MockWindow extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, startDrag: mocks.startDrag, setWindowOpenHandler: vi.fn() })
    constructor(_options: unknown) {
      super()
      windows.push(this as never)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    close() {
      this.destroy()
    }
    loadURL = mocks.loadURL
    showInactive = vi.fn()
    hide = vi.fn()
    setBounds = vi.fn()
    isVisible = () => false
    isFocused = () => false
    show = vi.fn()
    focus = vi.fn()
    getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
  }
  mocks.ipc = new EventEmitter()
  return {
    app: { getPath: () => '/Applications/Reel Studio.app/Contents/MacOS/Reel Studio' },
    nativeImage: { createFromPath: mocks.createFromPath },
    BrowserWindow: class extends MockWindow {},
    ipcMain: mocks.ipc,
    shell: { showItemInFolder: vi.fn() }
  }
})
vi.mock('../src/main/mac-settings-window', () => ({
  watchMacSettingsWindow: (onChange: (s: SettingsWindow) => void, onUnavailable: (ended: boolean) => void) => {
    mocks.settingsChanged = onChange
    mocks.trackingFailed = onUnavailable
    return mocks.stopTracking
  }
}))

const { MacPermissionHelper } = await import('../src/main/mac-permission-helper')
const { MAC_PERMISSION_HELPER_CHANNEL } = await import('../src/main/mac-permission')

let helper: InstanceType<typeof MacPermissionHelper>
const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() })
const opts = (o: Record<string, unknown> = {}) => ({ owner: null, preload: '/p.js', icon: '/icon.png', instruction: 'Turn on Reel Studio in the list above', ...o })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  const icon = { toDataURL: () => 'data:image/png;base64,abc' }
  mocks.createFromPath.mockReturnValue({ isEmpty: () => false, resize: () => icon })
  mocks.loadURL.mockResolvedValue(undefined)
  windows.length = 0
  helper = new MacPermissionHelper()
})
afterEach(() => {
  helper.close()
  vi.useRealTimers()
})

it('does not reopen a superseded helper when its first check completes', async () => {
  let resolve: (v: boolean) => void = () => {}
  const first = helper.show('folder', opts({ isGranted: () => new Promise<boolean>((r) => (resolve = r)) }))
  await helper.show('network', opts())
  resolve(false)
  await first
  expect(windows).toHaveLength(1)
  expect(windows[0].destroyed).toBe(false)
})

it('opens nothing when the permission is already on', async () => {
  await helper.show('folder', opts({ isGranted: () => true }))
  expect(windows).toHaveLength(0)
})

it('closes itself and brings Reel Studio back once the permission is on', async () => {
  let granted = false
  const own = owner()
  const onEnd = vi.fn()
  await helper.show('folder', opts({ owner: own, isGranted: () => granted, onEnd }))
  expect(windows).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(windows[0].destroyed).toBe(false)
  granted = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(windows[0].destroyed).toBe(true)
  expect(own.focus).toHaveBeenCalled()
  expect(onEnd).toHaveBeenCalledWith('granted')
})

it('follows the Settings window, and closes when Settings is closed', async () => {
  const onEnd = vi.fn()
  await helper.show('network', opts({ onEnd }))
  const w = windows[0]
  mocks.settingsChanged!({ x: 100, y: 50, width: 900, height: 620, frontmost: true })
  expect(w.setBounds).toHaveBeenCalledWith({ x: 378, y: 514, width: 560, height: 140 }, false)
  expect(w.showInactive).toHaveBeenCalled()
  mocks.settingsChanged!({ x: 100, y: 50, width: 900, height: 620, frontmost: false })
  expect(w.hide).toHaveBeenCalled()
  mocks.settingsChanged!(null)
  expect(w.destroyed).toBe(true)
  expect(onEnd).toHaveBeenCalledWith('closed')
  expect(mocks.stopTracking).toHaveBeenCalled()
})

it('hides while the tracker stumbles, and closes for good when the tracker dies', async () => {
  const onEnd = vi.fn()
  await helper.show('network', opts({ onEnd }))
  const w = windows[0]
  mocks.trackingFailed!(false)
  expect(w.hide).toHaveBeenCalled()
  expect(w.destroyed).toBe(false)
  mocks.trackingFailed!(true)
  expect(w.destroyed).toBe(true)
  expect(onEnd).toHaveBeenCalledWith('closed')
})

it('Done from its own page closes it; messages from anywhere else are ignored', async () => {
  const onEnd = vi.fn()
  await helper.show('network', opts({ onEnd }))
  const w = windows[0]
  mocks.ipc.emit(MAC_PERMISSION_HELPER_CHANNEL, { sender: {}, senderFrame: {} }, 'done')
  expect(w.destroyed).toBe(false)
  mocks.ipc.emit(MAC_PERMISSION_HELPER_CHANNEL, { sender: w.webContents, senderFrame: w.webContents.mainFrame }, 'drag')
  expect(mocks.startDrag).not.toHaveBeenCalled() // a switch pane has nothing to drag
  mocks.ipc.emit(MAC_PERMISSION_HELPER_CHANNEL, { sender: w.webContents, senderFrame: w.webContents.mainFrame }, 'done')
  expect(w.destroyed).toBe(true)
  expect(onEnd).toHaveBeenCalledWith('closed')
})
