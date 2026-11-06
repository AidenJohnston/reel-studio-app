// The companion server: what a paired phone or browser on the home network talks to. One listener on the LAN
// address Send to my phone uses, only while Settings > Phone and browser > "Phone and browser" is on. Routes and signatures:
// shared/contract.ts. No Electron imports, so the unit tests run it under plain Node.
//
// What it guards, and how (the person is told the rest in the pairing sheet):
// - Every request's Host must be exactly <address>:<port> (a page elsewhere can't rebind a name to it); every POST's
//   Origin must be this server's; a cross-site fetch is refused everywhere.
// - Nothing but the page, its build assets and /api/time answers without a paired device's signature.
// - Media is named by what it is (shared/contract.ts MediaRef); the service maps a ref to a file inside that reel's
//   folder and the file is opened before it's checked, so it can't be swapped between the check and the read.
// - It does not guard the traffic itself: this is plain HTTP on the home network, as Send to my phone is.
import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { extname, join } from 'node:path'
import { checkCall, CONTRACT_VERSION, HEADERS, VERSION_HEADER, type ContractEvent, type Reply } from '../../shared/contract'
import { parseRange } from '../phone-share'
import type { DeviceRegistry, Refusal } from './devices'
import type { CompanionService } from './service'

export const LIMITS = {
  /** A call body: far above any note (NOTE_MAX_CHARS). */
  callBytes: 64 * 1024,
  pairBytes: 1024,
  /** Open event streams, across devices; a fifth from one device closes its oldest. */
  streams: 32,
  streamsPerDevice: 4,
  /** A stream this far behind is a stuck tab: it is closed rather than held in memory. */
  streamBacklog: 1024 * 1024,
  keepAliveMs: 25_000
}

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp'
}

/** What a refusal answers, in the page's terms (renderer/src/companion/client.ts). */
const REFUSED: Record<Refusal, { status: number; code: string }> = {
  unknown: { status: 401, code: 'NOT_PAIRED' },
  'bad-signature': { status: 401, code: 'NOT_PAIRED' },
  stale: { status: 401, code: 'CLOCK' },
  replayed: { status: 401, code: 'REPLAYED' },
  expired: { status: 403, code: 'EXPIRED' },
  rate: { status: 429, code: 'TOO_MANY' }
}

export interface CompanionServerOptions {
  /** The LAN address to listen on (phone-share lanAddresses()), or 127.0.0.1 in tests. */
  host: string
  /** The port to try first (the one devices were paired on); another is picked when it's taken. */
  port?: number
  /** The renderer build: companion.html and assets/. */
  staticDir: string
  devices: DeviceRegistry
  service: CompanionService
  log: (line: string) => void
}

export interface CompanionServer {
  host: string
  port: number
  origin: string
  publish(e: ContractEvent): void
  /** Ends a removed device's event streams, after telling it. */
  revoke(deviceId: string): void
  stop(): Promise<void>
}

const isRefusal = (v: unknown): v is Refusal => typeof v === 'string'

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        over = true
        req.destroy()
        resolve(null)
      } else chunks.push(c)
    })
    req.on('end', () => !over && resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const b = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(b.length) })
  res.end(b)
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)) })
  res.end(text)
}

/** `Content-Disposition` with a plain-ASCII fallback and the real (possibly accented) name. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

function userError(e: unknown): { code: string; userMessage: string } {
  if (e && typeof e === 'object' && 'userMessage' in e && typeof (e as { userMessage: unknown }).userMessage === 'string') {
    const code = (e as { code?: unknown }).code
    return { code: typeof code === 'string' ? code : 'ERROR', userMessage: (e as { userMessage: string }).userMessage }
  }
  return { code: 'ERROR', userMessage: 'Something went wrong on the computer. Try again.' }
}

export async function startCompanionServer(o: CompanionServerOptions): Promise<CompanionServer> {
  let host = ''
  let origin = ''
  let stopped = false
  const sockets = new Set<Socket>()
  const streams = new Map<ServerResponse, { device: string; timer: NodeJS.Timeout }>()

  const endStream = (res: ServerResponse): void => {
    const s = streams.get(res)
    if (!s) return
    clearInterval(s.timer)
    streams.delete(res)
    res.end()
  }

  const write = (res: ServerResponse, chunk: string): void => {
    if (res.writableLength > LIMITS.streamBacklog) {
      o.log('[companion] closed a stream that fell behind')
      endStream(res)
      res.destroy()
      return
    }
    res.write(chunk)
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/' || path === '/index.html') {
      const html = await fs.readFile(join(o.staticDir, 'companion.html')).catch(() => null)
      if (!html) return plain(res, 503, 'The phone page is missing from this build of Reel Studio.')
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(html.length), 'Content-Security-Policy': CSP })
      return void res.end(req.method === 'HEAD' ? undefined : html)
    }
    const m = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(path)
    const type = m && ASSET_TYPES[extname(m[1]).toLowerCase()]
    if (!m || !type || m[1].startsWith('.')) return plain(res, 404, 'Not found')
    const body = await fs.readFile(join(o.staticDir, 'assets', m[1])).catch(() => null)
    if (!body) return plain(res, 404, 'Not found')
    // Vite puts a content hash in each asset's name, so a name always means the same bytes.
    res.writeHead(200, { ...BASE_HEADERS, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': type, 'Content-Length': String(body.length) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, LIMITS.pairBytes)
    if (raw === null) return json(res, 413, { error: 'TOO_BIG' })
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw)
    } catch {
      return json(res, 400, { error: 'BAD_REQUEST' })
    }
    const r = await o.devices.completePairing(body ?? {})
    if (isRefusal(r)) {
      const status = r === 'rate' ? 429 : r === 'bad-signature' ? 401 : 404
      return json(res, status, { error: r === 'rate' ? 'TOO_MANY' : r === 'bad-signature' ? 'NOT_PAIRED' : r === 'expired' ? 'EXPIRED' : 'UNKNOWN' })
    }
    o.log(`[companion] paired a ${r.kind}`)
    json(res, 200, { device: r.id, installationId: await o.devices.installationId(), scopes: r.scopes, now: Math.floor(Date.now() / 1000) })
  }

  async function call(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers[VERSION_HEADER] !== String(CONTRACT_VERSION)) return json(res, 426, { error: 'CONTRACT', contract: CONTRACT_VERSION })
    const raw = await readBody(req, LIMITS.callBytes)
    if (raw === null) return json(res, 413, { error: 'TOO_BIG' })
    const h = req.headers
    const device = await o.devices.checkCall({ device: h[HEADERS.device], time: h[HEADERS.time], nonce: h[HEADERS.nonce], sig: h[HEADERS.sig] }, raw)
    if (isRefusal(device)) return json(res, REFUSED[device].status, { error: REFUSED[device].code })
    let reply: Reply
    try {
      const { method, args } = checkCall(JSON.parse(raw))
      reply = { ok: true, value: await o.service.call(device, method, args) }
    } catch (e) {
      const u = userError(e)
      if (u.code !== 'BAD_MOMENT' && u.code !== 'EMPTY') o.log(`[companion] call failed: ${u.code}`)
      reply = { ok: false, error: u }
    }
    json(res, 200, reply)
  }

  async function events(req: IncomingMessage, res: ServerResponse, q: URLSearchParams): Promise<void> {
    const device = await o.devices.checkEvents({ d: q.get('d'), t: q.get('t'), n: q.get('n'), s: q.get('s') })
    if (isRefusal(device)) return json(res, REFUSED[device].status, { error: REFUSED[device].code })
    const mine = [...streams].filter(([, s]) => s.device === device.id)
    if (mine.length >= LIMITS.streamsPerDevice) endStream(mine[0][0])
    if (streams.size >= LIMITS.streams) return json(res, 503, { error: 'BUSY' })
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const timer = setInterval(() => write(res, ': keep-alive\n\n'), LIMITS.keepAliveMs)
    timer.unref?.()
    streams.set(res, { device: device.id, timer })
    // The response's close, not the request's: a GET's request side can finish long before the stream does.
    res.on('close', () => endStream(res))
    write(res, `data: ${JSON.stringify({ type: 'ready' } satisfies ContractEvent)}\n\n`)
  }

  async function media(req: IncomingMessage, res: ServerResponse, ref: string, q: URLSearchParams): Promise<void> {
    const save = q.get('save') === '1'
    const device = await o.devices.checkMedia(ref, { d: q.get('d'), e: q.get('e'), s: q.get('s'), save: save ? '1' : '0' })
    if (isRefusal(device)) return plain(res, REFUSED[device].status === 401 ? 403 : REFUSED[device].status, 'Not allowed')
    const found = await o.service.mediaFile(ref)
    if (!found) return plain(res, 404, 'Not found')
    // Opened first, then measured through the same handle: what is checked is what is sent.
    const fh = await fs.open(found.file, 'r').catch(() => null)
    if (!fh) return plain(res, 404, 'Not found')
    try {
      const st = await fh.stat()
      if (!st.isFile()) return plain(res, 404, 'Not found')
      const size = st.size
      const range = parseRange(req.headers.range, size)
      const headers: Record<string, string> = {
        ...BASE_HEADERS,
        'Content-Type': found.type,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition(save ? 'attachment' : 'inline', found.name)
      }
      if (range === 'invalid') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
        return void res.end()
      }
      const { start, end } = range ?? { start: 0, end: size - 1 }
      if (range) {
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
        res.writeHead(206, { ...headers, 'Content-Length': String(end - start + 1) })
      } else res.writeHead(200, { ...headers, 'Content-Length': String(size) })
      if (req.method === 'HEAD' || size === 0) return void res.end()
      const stream = createReadStream('', { fd: fh.fd, start, end, autoClose: false })
      await new Promise<void>((resolve) => {
        stream.on('error', () => {
          res.destroy()
          resolve()
        })
        res.on('close', () => {
          stream.destroy()
          resolve()
        })
        stream.pipe(res)
      })
    } finally {
      await fh.close().catch(() => {})
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (stopped) return plain(res, 503, 'Stopped')
      if ((req.headers.host ?? '').toLowerCase() !== host) return plain(res, 421, 'Wrong address')
      if (req.headers['sec-fetch-site'] === 'cross-site') return plain(res, 403, 'Not allowed')
      const url = new URL(req.url ?? '/', origin)
      const path = url.pathname
      const get = req.method === 'GET' || req.method === 'HEAD'
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) return plain(res, 403, 'Not allowed')
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return plain(res, 415, 'JSON only')
        if (path === '/api/pair') return pair(req, res)
        if (path === '/api/call') return call(req, res)
        return plain(res, 404, 'Not found')
      }
      if (!get) return plain(res, 405, 'Not allowed')
      if (path === '/api/time') return json(res, 200, { now: Math.floor(Date.now() / 1000), contract: CONTRACT_VERSION })
      if (path === '/api/events' && req.method === 'GET') return events(req, res, url.searchParams)
      if (path.startsWith('/media/')) {
        let ref: string
        try {
          ref = decodeURIComponent(path.slice('/media/'.length))
        } catch {
          return plain(res, 404, 'Not found')
        }
        return media(req, res, ref, url.searchParams)
      }
      return serveStatic(req, res, path)
    })().catch((e) => {
      o.log(`[companion] request failed: ${String(e)}`)
      if (!res.headersSent) plain(res, 500, 'Something went wrong')
      else res.destroy()
    })
  })
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000 // receiving the request only; a video or an event stream may run far longer
  server.keepAliveTimeout = 5_000
  server.maxConnections = 64
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: o.host, port, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen(o.port ?? 0)
  } catch (e) {
    // The paired port is taken: devices will need pairing again on the new one (their saved origin names the port).
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !o.port) throw e
    o.log('[companion] the usual port is taken; using another')
    await listen(0)
  }
  const port = (server.address() as AddressInfo).port
  host = `${o.host}:${port}`.toLowerCase()
  origin = `http://${o.host}:${port}`

  return {
    host: o.host,
    port,
    origin,
    publish(e) {
      const line = `data: ${JSON.stringify(e)}\n\n`
      for (const res of [...streams.keys()]) write(res, line)
    },
    revoke(deviceId) {
      const line = `data: ${JSON.stringify({ type: 'revoked' } satisfies ContractEvent)}\n\n`
      for (const [res, s] of [...streams]) {
        if (s.device !== deviceId) continue
        write(res, line)
        endStream(res)
      }
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const res of [...streams.keys()]) endStream(res)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const s of sockets) s.destroy()
      })
    }
  }
}
