import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { normaliseCaptureUrl, publicHostAddress } from './capture-guard'

// Keep Chromium's TLS, cookies and decoding, but resolve and connect here so DNS cannot change
// between the public-address check and the connection. Redirects use this proxy too.
export async function createCaptureProxy(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const url = normaliseCaptureUrl(req.url ?? '')
      const address = await publicHostAddress(url.hostname)
      if (!address) { res.writeHead(403).end(); return }
      if (res.destroyed) return
      const upstream = request(url, {
        method: req.method, headers: req.headers, agent: false,
        lookup: (_host, options, cb) => {
          const family = isIP(address)
          if (options.all) cb(null, [{ address, family }])
          else cb(null, address, family)
        }
      }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.on('error', () => res.destroy())
        reply.pipe(res)
      })
      upstream.on('error', () => res.destroy())
      res.on('close', () => upstream.destroy())
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
    } catch {
      res.writeHead(403).end()
    }
  })
  server.on('connect', async (req, client, head) => {
    try {
      const url = normaliseCaptureUrl(`https://${req.url}`)
      const address = await publicHostAddress(url.hostname)
      if (!address) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      if (client.destroyed) return
      const upstream = connect({ host: address, port: Number(url.port || 443) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.on('close', () => upstream.destroy())
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    }
  })
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Capture proxy did not bind a TCP port')
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    }
  }
}
