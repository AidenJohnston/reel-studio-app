// The main window and everything around it that belongs to the operating system: title bar per
// platform, remembered size/position, the macOS application menu (Edit roles, so copy and paste work
// in text fields), Dock / taskbar progress, and the "your reel is ready" notification.
import { app, BrowserWindow, Menu, nativeImage, Notification, screen, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isStrictlyInsideFolder } from './inside-folder'
import { DEFAULT, MIN, placeWindow, type Placement, type SavedBounds } from './window-bounds'
import type { AppCommand, JobEvent } from '../shared/api'
import { productName } from '../shared/channel'
import { titlebarHeight } from '../shared/chrome'
import { SITE_URL } from '../shared/config'

export const PAPER = '#F1F2EF'
export const INK = '#161917'
/** Height of the Windows title bar overlay (window buttons): the title-bar row the renderer leaves room for. */
export const WIN_TITLEBAR_HEIGHT = titlebarHeight('win32')
/** The modal scrim, as in styles.css `.modal-backdrop`: rgba(22, 30, 26, .3). */
export const SCRIM = '#161e1a'
export const SCRIM_ALPHA = 0.3
/** Fully transparent overlays draw wrong on Linux, so T3 Code uses alpha 1/255; this lets every surface, a modal's scrim
 * included, show through the strip behind the window buttons. */
export const OVERLAY = '#01000000'

/** `top` laid over `base` at `alpha`, both #rrggbb. */
export function blendHex(base: string, top: string, alpha: number): string {
  const ch = (hex: string, i: number): number => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  return '#' + [0, 1, 2].map((i) => Math.round(ch(base, i) * (1 - alpha) + ch(top, i) * alpha).toString(16).padStart(2, '0')).join('')
}

/** The window buttons' colour on the full-screen stage: white, like the stage's own controls on its dark --bezel. */
export const ON_DARK_SYMBOL = '#FFFFFF'

/**
 * Windows and Linux: the strip behind the system's window buttons is drawn by the OS in this colour, outside the
 * page, so a modal's scrim cannot cover it. While a modal is open it takes the scrim's colour instead. The buttons'
 * symbols are drawn in INK over the page; on the full-screen stage (onDark) the page under them is near-black, where
 * INK has a contrast of 1.04, so they turn white there.
 */
export function titleBarOverlay(dimmed: boolean, onDark = false): { color: string; symbolColor: string; height: number } {
  return { color: dimmed ? blendHex(PAPER, SCRIM, SCRIM_ALPHA) : OVERLAY, symbolColor: onDark ? ON_DARK_SYMBOL : INK, height: WIN_TITLEBAR_HEIGHT }
}
/**
 * macOS 26 draws each window button in a 14 x 14 frame that its circle fills, and Electron puts the frame's top `y`
 * below the window's top (window_buttons_proxy.mm), so this `y` centres the lights on the title-bar row.
 */
const MAC_BUTTON = 14
/** The row scales with page zoom; the native buttons don't, so their place is recomputed per zoom factor (T3 Code does the same). */
const lightsAt = (zoom: number) => ({ x: 16, y: Math.round((titlebarHeight('darwin') * zoom - MAC_BUTTON) / 2) })

export type { AppCommand }

function readBounds(file: string): SavedBounds | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as SavedBounds
    if (typeof b.width === 'number' && typeof b.height === 'number') return b
  } catch {
    /* first start, or a broken file: use the default */
  }
  return null
}

/** Where the window opens now: on a display that is still connected, no bigger than its work area (window-bounds.ts). */
function placement(file: string): Placement {
  const primary = screen.getPrimaryDisplay().id
  const displays = screen.getAllDisplays().map((d) => ({ workArea: d.workArea, primary: d.id === primary }))
  return placeWindow(existsSync(file) ? readBounds(file) : null, displays, titlebarHeight(process.platform))
}

function saveBounds(file: string, w: BrowserWindow): void {
  try {
    const maximized = w.isMaximized()
    const b = maximized ? w.getNormalBounds() : w.getBounds()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...b, maximized }))
  } catch {
    /* never block closing on this */
  }
}

export function createMainWindow(opts: { preload: string; stateFile: string; test: boolean }): BrowserWindow {
  const mac = process.platform === 'darwin'
  // Tests always get the same size so screenshots compare.
  const p: Placement = opts.test ? { bounds: { x: 0, y: 0, ...DEFAULT }, min: MIN, maximized: false } : placement(opts.stateFile)
  const win = new BrowserWindow({
    ...(opts.test ? DEFAULT : p.bounds),
    minWidth: p.min.width,
    minHeight: p.min.height,
    show: false,
    title: productName(app.getVersion()),
    backgroundColor: PAPER,
    // macOS: traffic lights inset over the sidebar. Windows: our own paper-coloured bar with the
    // system's window buttons drawn on top, so there is no grey strip and no stray menu bar.
    titleBarStyle: 'hidden',
    ...(mac
      ? { trafficLightPosition: lightsAt(1) }
      : { titleBarOverlay: titleBarOverlay(false) }),
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  // The page's <title> says Reel Studio; the window (Windows taskbar, Mission Control) keeps the channel's name.
  win.on('page-title-updated', (e) => e.preventDefault())
  if (p.maximized && !opts.test) win.maximize()
  if (!opts.test) {
    win.on('close', () => saveBounds(opts.stateFile, win))
  }
  return win
}

function zoom(w: Electron.BaseWindow | undefined, step: -1 | 0 | 1): void {
  if (!(w instanceof BrowserWindow)) return
  const wc = w.webContents
  wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step * 0.5)
  if (!w.isFullScreen()) w.setWindowButtonPosition(lightsAt(wc.getZoomFactor()))
}

/**
 * macOS needs an application menu with the Edit roles, or Cmd+C / Cmd+V do nothing in text fields
 * (pasting a key fails). Windows gets no menu bar: Ctrl+C/V work natively there and the renderer
 * handles the app shortcuts itself (and checks for updates from Settings).
 */
export function installMenu(
  send: (c: AppCommand) => void,
  dev: boolean,
  toggleTimeline: (shown: boolean) => void,
  checkForUpdates: () => void,
  copyDiagnostics?: () => void
): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const name = productName(app.getVersion())
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: `About ${name}` },
        { label: 'Check for Updates…', click: checkForUpdates },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send({ type: 'settings' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${name}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${name}` }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Reel', accelerator: 'Cmd+N', click: () => send({ type: 'new-video' }) },
        { label: 'Share…', accelerator: 'Cmd+E', click: () => send({ type: 'export' }) },
        { type: 'separator' },
        { label: 'Library', accelerator: 'Cmd+L', click: () => send({ type: 'library' }) },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...(dev ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
        { label: 'Actual Size', accelerator: 'Cmd+0', click: (_i, w) => zoom(w, 0) },
        { label: 'Zoom In', accelerator: 'Cmd+Plus', click: (_i, w) => zoom(w, 1) },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: (_i, w) => zoom(w, -1) },
        { type: 'separator' },
        // checked until the saved setting says otherwise (showTimelineInMenu)
        { id: TIMELINE_ITEM, label: 'Show Timeline', type: 'checkbox', checked: true, accelerator: 'Shift+Cmd+T', click: (i) => toggleTimeline(i.checked) },
        // the same chord the page handles (Sidebar.tsx), so the menu shows it; the menu sees it first on a Mac
        { id: 'resize-sidebar', label: 'Resize Sidebar', accelerator: 'Shift+Cmd+\\', click: () => send({ type: 'resize-sidebar' }) },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Reel Studio website', click: () => void shell.openExternal(SITE_URL) },
        ...(copyDiagnostics ? ([{ label: 'Copy Diagnostics', click: () => copyDiagnostics() }] as MenuItemConstructorOptions[]) : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const TIMELINE_ITEM = 'show-timeline'

/** View › Show Timeline's check, after the setting changed somewhere else (the Reel screen's own button). */
export function showTimelineInMenu(shown: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(TIMELINE_ITEM)
  if (item) item.checked = shown
}

/** What the OS was told, for the e2e (notifications are not shown in tests). */
export const feedbackLog: { progress: number[]; notifications: { title: string; body: string }[]; attention: number } = {
  progress: [],
  notifications: [],
  attention: 0
}

/**
 * Dock / taskbar progress while a first edit runs, and a system notification + Dock bounce /
 * taskbar flash when it finishes while the window is in the background.
 */
export function createJobFeedback(opts: {
  window: () => BrowserWindow | null
  title: (slug: string) => Promise<string>
  send: (c: AppCommand) => void
  test: boolean
  /** The Dock bounce stays either way. */
  notificationsOn: () => boolean
}) {
  // per running job: its bar (the job flow's `overall`, never backwards)
  const stages = new Map<string, { bar: number }>()

  const setBar = (p: number): void => {
    const w = opts.window()
    if (!w || w.isDestroyed()) return
    feedbackLog.progress.push(p)
    w.setProgressBar(p)
  }

  const attention = (): void => {
    const w = opts.window()
    if (!w || w.isDestroyed() || w.isFocused()) return
    feedbackLog.attention++
    if (opts.test) return
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    else w.flashFrame(true)
  }

  const notify = (title: string, body: string, slug: string | null): void => {
    const w = opts.window()
    if (w && !w.isDestroyed() && w.isFocused()) return
    if (!opts.notificationsOn()) return
    feedbackLog.notifications.push({ title, body })
    if (opts.test || !Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const win = opts.window()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      if (slug) opts.send({ type: 'open-reel', slug })
    })
    n.show()
  }

  return {
    onJobEvent(e: JobEvent): void {
      const key = e.jobId
      if (e.type === 'status') {
        const s = stages.get(key) ?? { bar: 0 }
        s.bar = Math.max(s.bar, e.overall)
        stages.set(key, s)
        setBar(s.bar / 100)
        return
      }
      // only the end of a job clears the bar (tool, render, reply, heard are mid-job news)
      if (e.type !== 'done' && e.type !== 'error' && e.type !== 'cancelled' && e.type !== 'paused') return
      stages.delete(key)
      if (!stages.size) setBar(-1)
      if (!e.slug) return
      const slug = e.slug
      // only a job that made a version is news (a script, a share or an export makes none)
      if (e.type === 'done' && e.version !== undefined) {
        const n = e.version
        void opts.title(slug).then((t) => notify(`${t}: Version ${n} is ready`, 'Open Reel Studio to watch it.', slug))
        attention()
      } else if (e.type === 'error') {
        void opts.title(slug).then((t) => notify(`${t} didn't finish`, 'Open Reel Studio to see why and try again.', slug))
        attention()
      }
    }
  }
}

/**
 * Drag the finished reel out of the app, onto the desktop, a folder or a browser upload box
 * (delight 2). Only files inside the Reel Studio folders; the cover is the drag picture.
 */
export function startDragOut(sender: WebContents, file: string, roots: string[]): void {
  const f = resolve(String(file))
  const inside = roots.some((r) => isStrictlyInsideFolder(f, r))
  if (!inside || !existsSync(f)) return
  const cover = join(dirname(f), 'cover.png')
  let icon = existsSync(cover) ? nativeImage.createFromPath(cover) : nativeImage.createEmpty()
  if (!icon.isEmpty()) icon = icon.resize({ width: 72 })
  else icon = nativeImage.createFromDataURL(DRAG_DOT)
  sender.startDrag({ file: f, icon })
}

// A small ink square, for when there is no cover yet.
const DRAG_DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGOQlZb4TwlmGDVg1IBRA4aLAQBSWU8QNHK3mAAAAABJRU5ErkJggg=='

export function windowStateFile(settingsDir: string): string {
  return join(settingsDir, 'window.json')
}
