// The main window and everything around it that belongs to the operating system: title bar per
// platform, remembered size/position, the macOS application menu (Edit roles, so copy and paste work
// in text fields), Dock / taskbar progress, and the "your reel is ready" notification.
import { app, BrowserWindow, Menu, nativeImage, Notification, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { AppCommand, JobEvent } from '../shared/api'
import { RELEASES_REPO } from '../shared/config'

export const PAPER = '#f7f5f1'
export const INK = '#1d1b18'
/** Height of the Windows title bar overlay (window buttons). The renderer leaves this much room at the top. */
export const WIN_TITLEBAR_HEIGHT = 40

export type { AppCommand }

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const MIN = { width: 1024, height: 700 }
const DEFAULT: Bounds = { width: 1280, height: 820 }

function readBounds(file: string): Bounds {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Bounds
    if (typeof b.width === 'number' && typeof b.height === 'number') {
      return { ...b, width: Math.max(MIN.width, b.width), height: Math.max(MIN.height, b.height) }
    }
  } catch {
    /* first start, or a broken file: use the default */
  }
  return DEFAULT
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
  const b = opts.test || !existsSync(opts.stateFile) ? DEFAULT : readBounds(opts.stateFile)
  const win = new BrowserWindow({
    ...b,
    minWidth: MIN.width,
    minHeight: MIN.height,
    show: false,
    title: 'Reel Studio',
    backgroundColor: PAPER,
    // macOS: traffic lights inset over the sidebar. Windows: our own paper-coloured bar with the
    // system's window buttons drawn on top, so there is no grey strip and no stray menu bar.
    titleBarStyle: 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { color: PAPER, symbolColor: INK, height: WIN_TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  if (b.maximized && !opts.test) win.maximize()
  if (!opts.test) {
    win.on('close', () => saveBounds(opts.stateFile, win))
  }
  return win
}

/**
 * macOS needs an application menu with the Edit roles, or Cmd+C / Cmd+V do nothing in text fields
 * (pasting a key fails). Windows gets no menu bar: Ctrl+C/V work natively there and the renderer
 * handles the app shortcuts itself.
 */
export function installMenu(send: (c: AppCommand) => void, dev: boolean): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const name = app.name || 'Reel Studio'
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: `About ${name}` },
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
        { label: 'New Video', accelerator: 'Cmd+N', click: () => send({ type: 'new-video' }) },
        { label: 'Export for Instagram', accelerator: 'Cmd+E', click: () => send({ type: 'export' }) },
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
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Reel Studio on GitHub', click: () => void shell.openExternal(`https://github.com/${RELEASES_REPO}`) }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
      if (e.type !== 'done' && e.type !== 'error' && e.type !== 'cancelled') return
      stages.delete(key)
      if (!stages.size) setBar(-1)
      if (!e.slug) return
      const slug = e.slug
      if (e.type === 'done') {
        void opts.title(slug).then((t) => notify('Your reel is ready', `"${t}" is ready to watch.`, slug))
        attention()
      } else if (e.type === 'error') {
        void opts.title(slug).then((t) => notify('That did not work', `I could not finish "${t}". Open Reel Studio to try again.`, slug))
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
  const inside = roots.some((r) => {
    const root = resolve(r)
    return f.startsWith(root.endsWith(sep) ? root : root + sep)
  })
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
