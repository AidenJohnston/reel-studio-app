// The sign-in service on plain Node (docs/signin.md, "Run it on this computer"): a node:http server in front of the
// same handler Workers runs. Request bodies are capped before they reach the handler.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const LIMIT = 64 * 1024

export async function serveNode(handler: (req: Request) => Promise<Response>, port: number, host = '127.0.0.1'): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    void toRequest(req, `http://${req.headers.host ?? `${host}:${port}`}`)
      .then(handler)
      .then(async (r) => {
        const headers: Record<string, string> = {}
        r.headers.forEach((v, k) => (headers[k] = v))
        res.writeHead(r.status, headers)
        res.end(Buffer.from(await r.arrayBuffer()))
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{"error":{"code":"too_large"}}')
      })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, () => {
      server.removeListener('error', fail)
      ok()
    })
  })
  const a = server.address() as AddressInfo
  return { server, url: `http://${host}:${a.port}` }
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > LIMIT) throw new Error('too large')
    chunks.push(c as Buffer)
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  return new Request(new URL(req.url ?? '/', origin), { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
}
