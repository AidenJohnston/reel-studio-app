// Stop during a website screenshot (main/capture.ts). A public page can replace requestAnimationFrame so the
// capture's frame wait never ends; Stop must still end the capture, and the next capture must not queue behind it.
import { expect, it, vi } from 'vitest'

const page = vi.hoisted(() => ({
  loads: 0,
  shutdown: undefined as (() => Promise<void>) | undefined,
  /** resolves once the page is waiting on its (never-ending) frame */
  framed: null as null | (() => void)
}))
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.215.14' }] }))
vi.mock('electron', () => ({
  app: { once: (_event: string, close: () => Promise<void>) => { page.shutdown = close } },
  session: { fromPartition: () => ({
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    clearStorageData: async () => {},
    setProxy: async () => {},
    webRequest: { onBeforeRequest() {} }
  }) },
  BrowserWindow: class {
    destroyed = false
    webContents = {
      setAudioMuted() {}, setUserAgent() {}, setWindowOpenHandler() {}, on() {}, setZoomFactor() {},
      getURL: () => 'https://hostile.example/',
      insertCSS: async () => '',
      // the page's own requestAnimationFrame never calls back: this wait never ends
      executeJavaScript: (code: string) => {
        if (!code.includes('requestAnimationFrame')) return Promise.resolve({ t: 'Hostile', b: 'hello' })
        page.framed?.()
        return new Promise(() => undefined)
      }
    }
    setContentSize() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
    async loadURL() { page.loads++ }
  }
}))

it('fails if Stop leaves a screenshot of a page that never draws a frame waiting forever, or blocks the next one', async () => {
  const { captureWebsite } = await import('../src/main/capture')
  try {
    const stop = new AbortController()
    const framed = new Promise<void>((resolve) => (page.framed = resolve))
    const shot = captureWebsite('https://hostile.example/', '/unused/one.png', { signal: stop.signal })
    await framed
    stop.abort()
    await expect(shot).rejects.toMatchObject({ code: 'CANCELLED' })
    // the queue moved on: the next capture opens its page
    const next = new AbortController()
    const second = new Promise<void>((resolve) => (page.framed = resolve))
    const again = captureWebsite('https://hostile.example/', '/unused/two.png', { signal: next.signal })
    await second
    expect(page.loads).toBe(2)
    next.abort()
    await expect(again).rejects.toMatchObject({ code: 'CANCELLED' })
  } finally {
    await page.shutdown?.()
  }
}, 30_000)
