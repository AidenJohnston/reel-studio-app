// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// The sign-in service redirects a sealed handoff to this loopback listener, never a token (docs/signin.md).
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { InstagramError } from './instagram-http'

export async function instagramCallback(state: string, signal: AbortSignal) {
  let resolve!: (handoff: string) => void
  let reject!: (error: Error) => void
  let settled = false
  const result = new Promise<string>((ok, fail) => { resolve = ok; reject = fail })
  void result.catch(() => undefined)
  const finish = (value: string | Error) => {
    if (settled) return
    settled = true
    if (value instanceof Error) reject(value)
    else resolve(value)
  }
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    const addr = server.address()
    const host = addr && typeof addr === 'object' ? `127.0.0.1:${addr.port}` : ''
    if (req.method !== 'GET' || req.headers.host !== host || settled) { res.writeHead(404).end(); return }
    let url: URL
    try { url = new URL(req.url ?? '/', `http://${host}`) } catch { res.writeHead(400).end(); return }
    if (url.pathname !== '/instagram/callback') { res.writeHead(404).end(); return }
    const got = Buffer.from(url.searchParams.get('state') ?? '')
    const want = Buffer.from(state)
    if (url.searchParams.getAll('state').length !== 1 || got.length !== want.length || !timingSafeEqual(got, want)) {
      res.writeHead(400).end('This sign-in link is not valid.')
      return
    }
    if (url.searchParams.has('error')) {
      res.writeHead(200).end('Instagram was not connected. Return to Reel Studio.')
      finish(new InstagramError('IG_DECLINED', 'Instagram was not connected. You can try again in Settings.'))
      return
    }
    const handoff = url.searchParams.get('handoff')
    if (url.searchParams.getAll('handoff').length !== 1 || !handoff || !/^[A-Za-z0-9_-]{16,2048}$/.test(handoff)) {
      res.writeHead(400).end('The sign-in response is incomplete.')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Return to Reel Studio to finish connecting Instagram.')
    finish(handoff)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); ok() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new InstagramError('IG_CALLBACK', 'Could not open the Instagram callback. Try again.')
  const abort = () => finish(new InstagramError('IG_CANCELLED', 'Instagram connection was cancelled.'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    redirectUri: `http://127.0.0.1:${address.port}/instagram/callback`,
    result,
    close: () => {
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeAllConnections()
    }
  }
}
