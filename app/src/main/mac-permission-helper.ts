// The small window that sits on the System Settings window and says what to turn on, ported from T3 Code
// (apps/desktop/src/permissions/MacPermissionHelper.ts). It follows the Settings window, checks the permission every
// second where Reel Studio can read it, and closes itself and brings Reel Studio back once it is on.
import { app, BrowserWindow, ipcMain, nativeImage, shell, type IpcMainEvent } from 'electron'
import { helperHtml, macAppBundlePath, MAC_PANES, MAC_PERMISSION_HELPER_CHANNEL, settingsHelperBounds } from './mac-permission'
import { watchMacSettingsWindow, type SettingsWindow } from './mac-settings-window'
import type { SettingsPane } from '../shared/api'

/** Why the helper closed: it saw the permission on, or the person closed it (Done, ×, Esc, or closed Settings). */
export type HelperEnd = 'granted' | 'closed'

export interface HelperOptions {
  owner: BrowserWindow | null
  preload: string
  icon: string
  instruction: string
  /** Panes Reel Studio can read (MacPane.readable); checked every second. */
  isGranted?: () => boolean | Promise<boolean>
  onEnd?: (end: HelperEnd) => void
  /** Test builds: no System Settings to follow, so it shows at a fixed place on screen. */
  test?: boolean
}

export class MacPermissionHelper {
  private generation = 0
  private window: BrowserWindow | undefined

  close(): void {
    this.generation++
    this.window?.destroy()
    this.window = undefined
  }

  /** The helper window, for tests. */
  current(): BrowserWindow | undefined {
    return this.window
  }

  async show(paneId: SettingsPane, o: HelperOptions): Promise<void> {
    this.close()
    const generation = this.generation
    const pane = MAC_PANES[paneId]
    if (o.isGranted && (await o.isGranted())) return
    if (generation !== this.generation) return
    const bundle = macAppBundlePath(app.getPath('exe'))
    if (pane.kind === 'drag' && !bundle) return
    if (o.owner?.isDestroyed()) return
    const appIcon = nativeImage.createFromPath(o.icon)
    if (appIcon.isEmpty()) throw new Error(`The app icon is missing: ${o.icon}`)
    const icon = appIcon.resize({ width: 64, height: 64 })
    const window = new BrowserWindow({
      width: 560,
      height: 140,
      show: false,
      frame: false,
      transparent: true,
      roundedCorners: false,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: `Set up ${pane.title}`,
      webPreferences: { preload: o.preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.window = window
    let ended = false
    const finish = (end: HelperEnd): void => {
      if (ended) return
      ended = true
      window.close()
      if (o.owner && !o.owner.isDestroyed()) {
        o.owner.show()
        o.owner.focus()
      }
      o.onEnd?.(end)
    }
    let checking = false
    const check = async (): Promise<void> => {
      if (!o.isGranted || checking || window.isDestroyed()) return
      checking = true
      try {
        if ((await o.isGranted()) && !window.isDestroyed()) finish('granted')
      } catch {
        /* checked again in a second */
      } finally {
        checking = false
      }
    }
    const onMessage = (event: IpcMainEvent, action: unknown): void => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return
      if (action === 'drag' && pane.kind === 'drag' && bundle) {
        try {
          window.webContents.startDrag({ file: bundle, icon })
        } catch {
          shell.showItemInFolder(bundle)
        }
      } else if (action === 'finder' && pane.kind === 'drag' && bundle) {
        shell.showItemInFolder(bundle)
      } else if (action === 'close' || action === 'done') {
        finish('closed')
      }
    }
    let settingsWindow: SettingsWindow = null
    let foundSettings = false
    let trackingAvailable = true
    const syncPosition = (): void => {
      if (window.isDestroyed()) return
      if (!trackingAvailable) {
        window.hide()
        return
      }
      // System Settings was there and has been closed: the person is done with it.
      if (!settingsWindow && foundSettings) {
        finish('closed')
        return
      }
      if (!settingsWindow || (!settingsWindow.frontmost && !window.isFocused())) {
        window.hide()
        return
      }
      const bounds = settingsHelperBounds(settingsWindow)
      const now = window.getBounds()
      if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) window.setBounds(bounds, false)
      if (!window.isVisible()) window.showInactive()
    }
    let stopTracking = (): void => {}
    window.on('blur', syncPosition)
    const onOwnerClosed = (): void => window.destroy()
    ipcMain.on(MAC_PERMISSION_HELPER_CHANNEL, onMessage)
    const timer = setInterval(() => void check(), 1_000)
    o.owner?.once('closed', onOwnerClosed)
    window.once('closed', () => {
      clearInterval(timer)
      stopTracking()
      ipcMain.removeListener(MAC_PERMISSION_HELPER_CHANNEL, onMessage)
      o.owner?.removeListener('closed', onOwnerClosed)
      if (this.window === window) this.window = undefined
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    try {
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(helperHtml(pane, o.instruction, icon.toDataURL()))}`)
      if (window.isDestroyed()) return
      if (o.test) {
        window.setBounds(settingsHelperBounds({ x: 200, y: 120, width: 780, height: 620, frontmost: true }), false)
        window.showInactive()
        return
      }
      stopTracking = watchMacSettingsWindow(
        (current) => {
          trackingAvailable = true
          settingsWindow = current
          if (current) foundSettings = true
          syncPosition()
        },
        (ended) => {
          // With the tracker gone the helper can never be placed again: close it rather than leave it hidden.
          if (ended) return finish('closed')
          trackingAvailable = false
          syncPosition()
        }
      )
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  }
}
