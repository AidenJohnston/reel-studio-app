// EngineHost.captureWebsite: a screenshot of a web page, for b-roll when the speaker names an app or
// a site ("show the app's screen, not its logo"). Same technique as the animation renderer
// (animation.ts / render.mjs createElectronAdapter): an offscreen BrowserWindow, then capturePage.
//
// The page is someone else's code, so the window is locked down: sandboxed renderer, no node, no
// preload, an in-memory session of its own (never the user's cookies), no permissions, no
// downloads, no pop-ups, no navigation off http(s), and every request (page, frames, images,
// scripts, redirects) must go to a PUBLIC address: no localhost, no home network.
import { BrowserWindow, session, type Session } from 'electron'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertCapturable, CAPTURE_UA, captureError, CONSENT_SELECTORS, HIDE_CONSENT_OVERLAYS_JS, hostIsPublic, isBlank, LAYOUTS, type Layout, refusalPage, siteOf
} from './capture-guard'

export interface CaptureResult {
  path: string
  url: string
  site: string
  title: string
  width: number
  height: number
}

const PARTITION = 'reelstudio-capture' // no "persist:" prefix: memory only, gone when the app quits
const LOAD_TIMEOUT_MS = 25_000
const SETTLE_MS = 2_500

let ses: Session | null = null
const hostOk = new Map<string, Promise<boolean>>()

function captureSession(): Session {
  if (ses) return ses
  const s = session.fromPartition(PARTITION, { cache: false })
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.setPermissionCheckHandler(() => false)
  s.on('will-download', (e) => e.preventDefault())
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    let u: URL
    try {
      u = new URL(details.url)
    } catch {
      cb({ cancel: true })
      return
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return cb({})
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb({ cancel: true })
    let ok = hostOk.get(u.hostname)
    if (!ok) {
      ok = hostIsPublic(u.hostname)
      hostOk.set(u.hostname, ok)
      if (hostOk.size > 2000) hostOk.clear()
    }
    ok.then((pub) => cb({ cancel: !pub }), () => cb({ cancel: true }))
  })
  ses = s
  return s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function captureOnce(raw: string, outPath: string, layout: Layout): Promise<CaptureResult> {
  const target = await assertCapturable(raw)
  const { width, height, zoom } = LAYOUTS[layout]
  const s = captureSession()
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, resizable: false,
    enableLargerThanScreen: true, paintWhenInitiallyHidden: true, backgroundColor: '#ffffff',
    webPreferences: {
      session: s, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, devTools: false, backgroundThrottling: false,
      spellcheck: false, webgl: false, plugins: false, zoomFactor: zoom,
      autoplayPolicy: 'document-user-activation-required'
    }
  })
  try {
    // a window taller than the display is clamped at creation, even offscreen: size it again
    win.setContentSize(width, height)
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setUserAgent(CAPTURE_UA[layout])
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault()
    })
    wc.on('will-attach-webview', (e) => e.preventDefault())
    let lastPaint: Electron.NativeImage | null = null
    wc.on('paint', (_e, _dirty, image) => {
      lastPaint = image
    })
    let loadError: any = null
    await Promise.race([
      win.loadURL(target.href).catch((e) => {
        loadError = e
      }),
      sleep(LOAD_TIMEOUT_MS)
    ])
    if (win.isDestroyed()) throw captureError('CAPTURE_FAILED', 'window closed', 'The screenshot window closed. Try again.')
    const finalUrl = wc.getURL()
    if (loadError && (!finalUrl || finalUrl === 'about:blank')) {
      throw captureError('PAGE_FAILED', `${target.href}: ${loadError?.message ?? loadError}`,
        "That page wouldn't open. Check the address, or try the site's home page.")
    }
    wc.setZoomFactor(zoom)
    // a scrollbar down the edge reads as "a computer", not "the app"; a cookie banner covers the
    // screen (only the big consent tools' own containers are hidden: never the page's content)
    await wc.insertCSS(`html, body { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }
      ${CONSENT_SELECTORS} { display: none !important; }`).catch(() => {})
    await sleep(SETTLE_MS) // web apps draw after load: give them a moment, then capture what is there
    const info = await wc
      .executeJavaScript('({ t: document.title || "", b: (document.body && document.body.innerText) || "" })', true)
      .catch(() => ({ t: '', b: '' }))
    const refused = refusalPage(String(info?.t ?? ''), String(info?.b ?? ''))
    if (refused) throw captureError('SITE_REFUSED', `${finalUrl}: "${info?.t}"`, refused)
    await wc.executeJavaScript(HIDE_CONSENT_OVERLAYS_JS, true).catch(() => 0)
    await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', true).catch(() => {})
    let img = await wc.capturePage()
    if (img.isEmpty() && lastPaint) img = lastPaint
    let size = img.getSize()
    if (img.isEmpty() || !size.width) throw captureError('CAPTURE_FAILED', 'empty capture', "The page didn't draw anything. Try again.")
    if (size.width !== width) {
      // a HiDPI capture is scaled to the output width; the aspect is kept
      img = img.resize({ width, quality: 'best' })
      size = img.getSize()
    }
    if (isBlank(img.toBitmap(), size.width, size.height)) {
      throw captureError('BLANK_PAGE', `${finalUrl}: blank`, 'That page came out blank. Try the home page, or a different address.')
    }
    await mkdir(dirname(outPath), { recursive: true })
    const part = `${outPath}.part`
    await writeFile(part, img.toPNG())
    await rename(part, outPath)
    let site = siteOf(target)
    try {
      site = siteOf(new URL(finalUrl))
    } catch {
      /* keep the asked-for host */
    }
    return { path: outPath, url: finalUrl || target.href, site, title: String(info?.t ?? '').slice(0, 200), width: size.width, height: size.height }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    void s.clearStorageData().catch(() => {}) // nothing a page stored outlives its capture
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** One capture at a time (each opens its own window). Rejects with {code, message, userMessage}. */
export function captureWebsite(url: string, outPath: string, opts: { layout?: Layout } = {}): Promise<CaptureResult> {
  const layout: Layout = opts.layout === 'desktop' ? 'desktop' : 'phone'
  const run = (): Promise<CaptureResult> => captureOnce(url, outPath, layout).catch(async (e) => {
    await rm(`${outPath}.part`, { force: true }).catch(() => {})
    throw e?.userMessage ? e : captureError('CAPTURE_FAILED', String(e?.message ?? e), "I couldn't take that screenshot. Try again.")
  })
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
}
