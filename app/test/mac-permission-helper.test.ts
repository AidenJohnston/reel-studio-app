// The helper window follows System Settings (main/mac-permission-helper.ts), with Electron and the Settings tracker
// faked as in T3 Code's MacPermissionHelper.test.ts. Closing itself once access works is covered in e2e/onboarding.spec.ts.
import { expect, it, vi } from 'vitest'
import type { SettingsWindow } from '../src/main/mac-settings-window'

const mocks = vi.hoisted(() => ({
  createFromPath: vi.fn(),
  loadURL: vi.fn(),
  stopTracking: vi.fn(),
  settingsChanged: undefined as ((s: SettingsWindow) => void) | undefined
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
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() })
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
  return {
    nativeImage: { createFromPath: mocks.createFromPath },
    BrowserWindow: class extends MockWindow {},
    ipcMain: new EventEmitter()
  }
})
vi.mock('../src/main/mac-settings-window', () => ({
  watchMacSettingsWindow: (onChange: (s: SettingsWindow) => void) => {
    mocks.settingsChanged = onChange
    return mocks.stopTracking
  }
}))

const { MacPermissionHelper } = await import('../src/main/mac-permission-helper')

it('sits on the System Settings window, hides behind other apps, and closes when Settings closes', async () => {
  vi.useFakeTimers()
  const icon = { toDataURL: () => 'data:image/png;base64,abc' }
  mocks.createFromPath.mockReturnValue({ isEmpty: () => false, resize: () => icon })
  mocks.loadURL.mockResolvedValue(undefined)
  const helper = new MacPermissionHelper()
  const onEnd = vi.fn()
  await helper.show('notifications', { owner: null, preload: '/p.js', icon: '/icon.png', instruction: 'Turn on Allow notifications', onEnd })
  const w = windows[0]
  mocks.settingsChanged!({ x: 100, y: 50, width: 900, height: 620, frontmost: true })
  expect(w.setBounds).toHaveBeenCalledWith({ x: 378, y: 514, width: 560, height: 140 }, false)
  expect(w.showInactive).toHaveBeenCalled()
  mocks.settingsChanged!({ x: 100, y: 50, width: 900, height: 620, frontmost: false })
  expect(w.hide).toHaveBeenCalled()
  mocks.settingsChanged!(null)
  expect(w.destroyed).toBe(true)
  expect(onEnd).toHaveBeenCalledOnce()
  expect(mocks.stopTracking).toHaveBeenCalled()
  vi.useRealTimers()
})
