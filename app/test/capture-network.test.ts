import { expect, it, vi } from 'vitest'
import { createServer, request as realRequest, type RequestOptions } from 'node:http'
import { once } from 'node:events'

const network = vi.hoisted(() => ({
  lookups: 0,
  proxy: '',
  shutdown: undefined as (() => Promise<void>) | undefined,
  before: null as null | ((details: { url: string }, cb: (v: { cancel?: boolean }) => void) => void),
  status: 0,
  destinations: [] as string[],
  port: 0
}))
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: ++network.lookups <= 2 ? '93.184.215.14' : '127.0.0.1' }] }))
vi.mock('node:http', async (original) => {
  const http = await original<typeof import('node:http')>()
  return { ...http, request: (url: URL, options: RequestOptions, cb: Parameters<typeof realRequest>[2]) => {
    if (url.hostname === '127.0.0.1') return http.request(url, options, cb)
    let address = ''
    if (options.lookup) options.lookup(url.hostname, {}, (_err, value) => { if (typeof value === 'string') address = value })
    else address = ++network.lookups <= 2 ? '93.184.215.14' : '127.0.0.1'
    network.destinations.push(address)
    // Route the simulated public address locally; the checked socket destination is still recorded.
    const target = `http://127.0.0.1:${network.port}${address === '127.0.0.1' ? '/secret' : url.pathname}`
    return http.request(target, { ...options, lookup: undefined, headers: { host: url.host } }, cb)
  } }
})
vi.mock('electron', () => ({
  app: { once: (_event: string, close: () => Promise<void>) => { network.shutdown = close } },
  session: { fromPartition: () => ({
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    clearStorageData: async () => {},
    setProxy: async (config: { proxyRules: string }) => { network.proxy = config.proxyRules },
    webRequest: { onBeforeRequest: (_filter: unknown, handler: typeof network.before) => { network.before = handler } }
  }) },
  BrowserWindow: class {
    webContents = { setAudioMuted() {}, setUserAgent() {}, setWindowOpenHandler() {}, on() {} }
    setContentSize() {}
    isDestroyed() { return true }
    async loadURL(raw: string) {
      let url = raw
      for (let hop = 0; hop < 3; hop++) {
        const blocked = await new Promise<boolean>((resolve) => network.before!({ url }, (v) => resolve(!!v.cancel)))
        if (blocked) { network.status = 403; return }
        const { request } = await import('node:http')
        const response = await new Promise<Response>((resolve, reject) => {
          const target = network.proxy ? new URL(`http://${network.proxy}`) : new URL(url)
          request(target, network.proxy ? { path: url, headers: { host: new URL(url).host } } : {}, (res) => {
            res.resume()
            resolve(new Response(null, { status: res.statusCode, headers: res.headers.location ? { location: res.headers.location } : {} }))
          }).on('error', reject).end()
        })
        network.status = response.status
        const location = response.headers.get('location')
        if (!location) return
        url = new URL(location, url).href
      }
    }
  }
}))

it('fails if capture fetches a rebound loopback address, including after a redirect', async () => {
  let privateReads = 0
  const server = createServer((req, res) => {
    if (req.url === '/secret') { privateReads++; res.end('private service') }
    else { res.writeHead(302, { location: '/redirected' }); res.end() }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  network.port = address.port
  try {
    const { captureWebsite } = await import('../src/main/capture')
    await expect(captureWebsite('http://rebind.example/', '/unused.png')).rejects.toMatchObject({ code: 'CAPTURE_FAILED' })
    expect(privateReads).toBe(0)
    expect(network.destinations).toEqual(['93.184.215.14'])
    expect(network.status).toBe(403)
  } finally {
    await network.shutdown?.()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
  }
})
