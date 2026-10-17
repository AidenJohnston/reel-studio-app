// "Send to my phone" server: token required, range requests, every other path 404, auto-stop.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lanAddresses, parseRange, startShare, type ShareEvent, type ShareServer } from '../src/main/phone-share'
import { qrMatrix, qrSvg } from '../src/shared/qr'

const dir = mkdtempSync(join(tmpdir(), 'rs-phone-'))
const video = join(dir, 'Family time - Version 4.mp4')
const bytes = Buffer.alloc(100_000)
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
writeFileSync(video, bytes)
writeFileSync(join(dir, 'secret.txt'), 'do not serve me')

let share: ShareServer | null = null
afterEach(async () => {
  await share?.stop()
  share = null
})

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function get(url: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function start(extra: { ttlMs?: number; caption?: string } = {}): Promise<{ s: ShareServer; events: ShareEvent[] }> {
  const events: ShareEvent[] = []
  share = await startShare({
    file: video,
    title: 'Family time - Version 4',
    caption: extra.caption ?? 'Three things <b>I</b> learned',
    host: '127.0.0.1',
    ttlMs: extra.ttlMs,
    onEvent: (e) => events.push(e)
  })
  return { s: share, events }
}

describe('phone share server', () => {
  it('serves the page and the video only with the token', async () => {
    const { s, events } = await start()
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/$/)
    const page = await get(s.url)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    const html = page.body.toString()
    expect(html).toContain('src="video.mp4#t=0.1"')
    expect(html).toContain('Three things &lt;b&gt;I&lt;/b&gt; learned') // escaped, never raw HTML
    expect(page.headers['content-security-policy']).toMatch(/default-src 'none'/)
    expect(page.headers['access-control-allow-origin']).toBeUndefined()
    expect(page.headers['cache-control']).toBe('no-store')
    expect(events).toEqual([{ kind: 'page' }])

    const v = await get(s.url + 'video.mp4')
    expect(v.status).toBe(200)
    expect(v.headers['content-type']).toBe('video/mp4')
    expect(v.headers['content-length']).toBe(String(bytes.length))
    expect(v.headers['accept-ranges']).toBe('bytes')
    expect(v.headers['content-disposition']).toMatch(/^inline; filename="Family time - Version 4\.mp4"/)
    expect(v.body.equals(bytes)).toBe(true)
    expect(events).toEqual([{ kind: 'page' }, { kind: 'video' }])

    const save = await get(s.url + 'video.mp4?save=1', { method: 'HEAD' })
    expect(save.status).toBe(200)
    expect(save.headers['content-disposition']).toMatch(/^attachment;/)
    expect(save.body.length).toBe(0)
  })

  it('answers range requests the way iPhone Safari asks for them', async () => {
    const { s } = await start()
    const probe = await get(s.url + 'video.mp4', { headers: { Range: 'bytes=0-1' } })
    expect(probe.status).toBe(206)
    expect(probe.headers['content-range']).toBe(`bytes 0-1/${bytes.length}`)
    expect(probe.headers['content-length']).toBe('2')
    expect([...probe.body]).toEqual([0, 1])

    const mid = await get(s.url + 'video.mp4', { headers: { Range: 'bytes=1000-' } })
    expect(mid.status).toBe(206)
    expect(mid.body.equals(bytes.subarray(1000))).toBe(true)

    const tail = await get(s.url + 'video.mp4', { headers: { Range: 'bytes=-10' } })
    expect(tail.headers['content-range']).toBe(`bytes ${bytes.length - 10}-${bytes.length - 1}/${bytes.length}`)
    expect(tail.body.equals(bytes.subarray(-10))).toBe(true)

    const past = await get(s.url + 'video.mp4', { headers: { Range: `bytes=${bytes.length}-` } })
    expect(past.status).toBe(416)
    expect(past.headers['content-range']).toBe(`bytes */${bytes.length}`)
  })

  it('refuses every other path, a wrong token, other methods and a foreign Host', async () => {
    const { s, events } = await start()
    const origin = `http://127.0.0.1:${s.port}`
    const token = new URL(s.url).pathname.split('/')[1]
    const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    const bad = [
      '/',
      '/favicon.ico',
      `/${token}`, // no trailing slash
      `/${wrong}/`,
      `/${wrong}/video.mp4`,
      `/${token.slice(0, 20)}/video.mp4`,
      `/${token}/secret.txt`,
      `/${token}/../secret.txt`,
      `/${token}/..%2fsecret.txt`,
      `/${token}/video.mp4/`,
      `/${token}/video.mp4?file=../secret.txt`,
      `/${token}/sub/video.mp4`,
      `/${token}/?list=1`
    ]
    for (const p of bad) {
      const r = await get(origin + p)
      expect(r.status, p).toBe(404)
      expect(r.body.toString(), p).toBe('Not found')
    }
    expect((await get(s.url, { method: 'POST' })).status).toBe(404)
    expect((await get(s.url, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } })).status).toBe(404)
    // DNS rebinding: a page on another name pointed at this address does not get in, even with the token.
    expect((await get(s.url, { headers: { Host: 'evil.example' } })).status).toBe(404)
    expect(events).toEqual([]) // none of that counts as "the phone opened it"
  })

  it('stops by itself after its time and on stop(), and then nothing answers', async () => {
    const { s, events } = await start({ ttlMs: 300 })
    expect((await get(s.url)).status).toBe(200)
    await new Promise((r) => setTimeout(r, 600))
    expect(events.at(-1)).toEqual({ kind: 'stopped', reason: 'timeout' })
    await expect(get(s.url)).rejects.toThrow()

    const b = await start()
    await b.s.stop()
    expect(b.events.at(-1)).toEqual({ kind: 'stopped', reason: 'closed' })
    await expect(get(b.s.url)).rejects.toThrow()
    await b.s.stop() // twice is fine
  })

  it('uses a different token each time', async () => {
    const a = await start()
    const first = a.s.url
    await a.s.stop()
    const b = await start()
    expect(new URL(b.s.url).pathname).not.toBe(new URL(first).pathname)
  })

  it('leaves the caption card out when there is no caption', async () => {
    const { s } = await start({ caption: '  ' })
    expect((await get(s.url)).body.toString()).not.toContain('id="copy"')
  })
})

describe('parseRange', () => {
  it('reads single ranges and rejects nonsense', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=2-100', 10)).toEqual({ start: 2, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull() // multi-range: whole file
    expect(parseRange('bytes=5-2', 10)).toBe('invalid')
    expect(parseRange('bytes=-', 10)).toBe('invalid')
    expect(parseRange('bytes=-0', 10)).toBe('invalid')
    expect(parseRange('items=0-1', 10)).toBe('invalid')
  })
})

describe('lanAddresses', () => {
  const nic = (address: string, extra: Partial<{ internal: boolean; family: string }> = {}) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    ...extra
  })
  it('puts the real Wi-Fi first and drops what a phone cannot reach', () => {
    const list = lanAddresses({
      'vEthernet (WSL)': [nic('172.29.16.1')],
      Tailscale: [nic('100.101.102.103')],
      'Wi-Fi': [nic('192.168.1.23'), { ...nic('fe80::1'), family: 'IPv6' }],
      Loopback: [nic('127.0.0.1', { internal: true })],
      'Ethernet 2': [nic('169.254.10.2')],
      NordLynx: [nic('10.5.0.2')],
      Ethernet: [nic('10.0.0.7')]
    } as never)
    expect(list.map((a) => a.address)).toEqual(['192.168.1.23', '10.0.0.7', '10.5.0.2', '172.29.16.1'])
    expect(list[0]).toMatchObject({ label: 'Wi-Fi (192.168.1.23)', likely: true })
    expect(list.find((a) => a.address === '172.29.16.1')?.likely).toBe(false)
  })
  it('knows Mac adapter names', () => {
    const list = lanAddresses({ utun3: [nic('10.8.0.2')], en0: [nic('192.168.0.40')], bridge100: [nic('192.168.64.1')] } as never)
    expect(list[0].address).toBe('192.168.0.40')
    expect(list.at(-1)!.likely).toBe(false)
  })
})

describe('qr', () => {
  it('encodes a share link into a scannable-size code with a quiet zone', () => {
    const url = 'http://192.168.1.23:54321/' + 'A'.repeat(43) + '/'
    const m = qrMatrix(url)
    expect(m.size).toBeGreaterThanOrEqual(21)
    expect(m.size).toBeLessThanOrEqual(45) // version 7 at most: big modules on screen
    // The three finder patterns: dark 7x7 corners.
    for (const [x, y] of [[0, 0], [m.size - 7, 0], [0, m.size - 7]]) {
      expect(m.dark[y][x]).toBe(true)
      expect(m.dark[y + 6][x + 6]).toBe(true)
      expect(m.dark[y + 1][x + 1]).toBe(false)
      expect(m.dark[y + 3][x + 3]).toBe(true)
    }
    const svg = qrSvg(url)
    expect(svg.side).toBe(m.size + 8)
    expect(svg.path.startsWith('M4 4h7v1h-7z')).toBe(true)
  })
})
