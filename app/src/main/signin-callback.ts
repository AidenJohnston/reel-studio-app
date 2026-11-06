// The loopback listener a platform's sign-in comes back to, through the sign-in service (docs/signin.md): one GET to
// http://127.0.0.1:<port><path> with the app's own state and the service's sealed handoff, never a token.
// Instagram and Facebook use it; TikTok's desktop sign-in has its own (tiktok-oauth.ts).
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export interface CallbackErrors {
  /** The person said no on the platform's page. */
  declined(): Error
  cancelled(): Error
  /** The listener couldn't open. */
  failed(): Error
}

export async function signinCallback(name: string, path: string, state: string, signal: AbortSignal, errors: CallbackErrors) {
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
    if (url.pathname !== path) { res.writeHead(404).end(); return }
    const got = Buffer.from(url.searchParams.get('state') ?? '')
    const want = Buffer.from(state)
    if (url.searchParams.getAll('state').length !== 1 || got.length !== want.length || !timingSafeEqual(got, want)) {
      res.writeHead(400).end('This sign-in link is not valid.')
      return
    }
    if (url.searchParams.has('error')) {
      res.writeHead(200).end(`${name} was not connected. Return to Reel Studio.`)
      finish(errors.declined())
      return
    }
    // a sealed handoff is a few hundred characters (server/signin/seal.ts)
    const handoff = url.searchParams.get('handoff')
    if (url.searchParams.getAll('handoff').length !== 1 || !handoff || !/^[A-Za-z0-9_-]{16,2048}$/.test(handoff)) {
      res.writeHead(400).end('The sign-in response is incomplete.')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`Return to Reel Studio to finish connecting ${name}.`)
    finish(handoff)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); ok() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw errors.failed()
  const abort = () => finish(errors.cancelled())
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    redirectUri: `http://127.0.0.1:${address.port}${path}`,
    result,
    close: () => {
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeAllConnections()
    }
  }
}
