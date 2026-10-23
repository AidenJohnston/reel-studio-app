import { expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { connect, createServer, type TcpNetConnectOpts } from 'node:net'

const network = vi.hoisted(() => ({ address: '93.184.215.14', port: 0, destinations: [] as string[] }))
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: network.address }] }))
vi.mock('node:net', async (original) => {
  const net = await original<typeof import('node:net')>()
  return { ...net, connect: (options: TcpNetConnectOpts, ready?: () => void) => {
    if (options.port !== 443) return net.connect(options, ready)
    network.destinations.push(options.host ?? '')
    return net.connect({ host: '127.0.0.1', port: network.port }, ready)
  } }
})
const { createCaptureProxy } = await import('../src/main/capture-proxy')

async function tunnel(port: number): Promise<string> {
  const socket = connect({ host: '127.0.0.1', port })
  try {
    await once(socket, 'connect')
    socket.write('CONNECT rebind.example:443 HTTP/1.1\r\nHost: rebind.example:443\r\n\r\nhello')
    return await new Promise<string>((resolve, reject) => {
      let reply = ''
      socket.on('data', (data) => {
        reply += data.toString()
        if (reply.includes('403 Forbidden') || reply.endsWith('hello')) resolve(reply)
      })
      socket.on('error', reject)
      socket.on('end', () => resolve(reply))
    })
  } finally {
    socket.destroy()
  }
}

it('CONNECT pins the tunnel, forwards received bytes, and blocks a later private resolution', async () => {
  network.address = '93.184.215.14'
  network.destinations = []
  const echo = createServer((socket) => socket.pipe(socket)).listen(0, '127.0.0.1')
  await once(echo, 'listening')
  const address = echo.address()
  if (!address || typeof address === 'string') throw new Error('Echo server did not bind')
  network.port = address.port
  const proxy = await createCaptureProxy()
  try {
    expect(await tunnel(proxy.port)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nhello')
    expect(network.destinations).toEqual(['93.184.215.14'])
    network.address = '127.0.0.1'
    expect(await tunnel(proxy.port)).toContain('403 Forbidden')
    expect(network.destinations).toEqual(['93.184.215.14'])
  } finally {
    await proxy.close()
    await new Promise<void>((resolve, reject) => echo.close((error) => error ? reject(error) : resolve()))
  }
})
