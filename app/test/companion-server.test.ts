// The phone and browser companion (main/companion/): pairing, signed calls, events and media, through a real HTTP
// listener on loopback with the real device registry and service over a fake reel on disk. Signatures are made with
// the page's own shared/sha256.ts, so these also prove the page and the computer agree.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectDetail, ProjectSummary } from '../src/shared/api'
import {
  callMessage, eventsMessage, mediaMessage, mediaRef, pairMessage, parsePairingFragment, sign, CONTRACT_VERSION, type ContractEvent
} from '../src/shared/contract'
import { fromHex } from '../src/shared/sha256'
import { mediaUrl } from '../src/main/media-url'
import { createDeviceRegistry, DEVICE_IDLE_MS, PAIRING_TTL_MS, type DeviceRegistry } from '../src/main/companion/devices'
import { startCompanionServer, type CompanionServer } from '../src/main/companion/server'
import { contractEvent, createCompanionService, type ServiceDeps } from '../src/main/companion/service'

const root = mkdtempSync(join(tmpdir(), 'rs-companion-'))
const projects = join(root, 'Projects')
const reelDir = join(projects, 'family-time')
mkdirSync(join(reelDir, 'versions', 'v1'), { recursive: true })
const video = join(reelDir, 'versions', 'v1', 'video.mp4')
const bytes = Buffer.alloc(50_000)
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
writeFileSync(video, bytes)
writeFileSync(join(reelDir, 'versions', 'v1', 'cover.jpg'), 'jpg')
const outside = join(root, 'secret.mp4')
writeFileSync(outside, 'not part of any reel')
const staticDir = join(root, 'renderer')
mkdirSync(join(staticDir, 'assets'), { recursive: true })
writeFileSync(join(staticDir, 'companion.html'), '<!doctype html><title>Reel Studio</title>')
writeFileSync(join(staticDir, 'assets', 'companion-abc123.js'), 'console.log(1)')

function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    slug: 'family-time', dir: reelDir, title: 'Family time', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
    version: 1, thumbnail: mediaUrl(join(reelDir, 'versions', 'v1', 'cover.jpg')), status: 'ready', waiting: 0, noVideo: false,
    take: mediaUrl(join(root, 'raw take.mov')), versionAt: null, series: null, pausedFor: null, failedWhy: null, failedCode: null,
    sourceVideo: mediaUrl(join(root, 'raw take.mov')), sourceVideos: { s1: mediaUrl(join(root, 'raw take.mov')) },
    project: { sources: [{ id: 's1', path: join(root, 'raw take.mov') }] } as unknown as ProjectDetail['project'],
    versions: [{ n: 1, parent: null, video: mediaUrl(video), videoPath: video, draft: false, cover: mediaUrl(join(reelDir, 'versions', 'v1', 'cover.jpg')), createdAt: '2026-11-02T00:00:00Z' }],
    words: [], keptIds: [], captionLines: [], checklist: [], versionsMade: [{ version: 1, by: 'note', summary: 'music quieter' }] as ProjectDetail['versionsMade'],
    chat: [{ id: 'm1', from: 'you', text: 'music quieter', at: '2026-11-02T00:00:00Z', version: 1 }],
    lastError: null, queue: [], queueHeld: false, job: null, brollThumbs: {}, brollCredits: {}, aiEdited: true, plan: null, proposal: null,
    ...over
  } as ProjectDetail
}

let current = detail()
const notes: { slug: string; text: string; at?: number; version?: number }[] = []
const deps: ServiceDeps = {
  list: async () => [current as ProjectSummary],
  get: async (slug) => {
    if (slug !== 'family-time') throw { code: 'NOT_FOUND', userMessage: 'That reel is gone.' }
    return current
  },
  projectDir: (slug) => join(projects, slug),
  note: async (slug, text, _a, moment, onVersion) => {
    notes.push({ slug, text, at: moment?.at, version: onVersion })
    return { jobId: `job-${notes.length}`, queued: false }
  },
  cancel: async () => {},
  timeline: async () => ({ duration: 30, words: [{ id: 'w4', w: 'hello', s: 6.8, e: 7.2 }] }),
  editorConnected: async () => true,
  installationId: async () => 'inst',
  appVersion: '0.1.4',
  computer: 'Test computer'
}

let clock = Date.now()
let devices: DeviceRegistry
let server: CompanionServer
beforeEach(async () => {
  current = detail()
  notes.length = 0
  clock = Date.now()
  devices = createDeviceRegistry({ dir: mkdtempSync(join(tmpdir(), 'rs-devices-')), secrets: null, log: () => {}, now: () => clock })
  server = await startCompanionServer({ host: '127.0.0.1', staticDir, devices, service: createCompanionService({ ...deps, installationId: () => devices.installationId() }), log: () => {} })
})
afterEach(async () => {
  await server.stop()
})

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(`${server.origin}${path}`, { method: o.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...o.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (o.body) req.write(o.body)
    req.end()
  })
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> =>
  http(path, { method: 'POST', body: JSON.stringify(body), headers: { origin: server.origin, 'content-type': 'application/json', ...headers } })

interface Paired { device: string; secret: Uint8Array }

async function pairDevice(notesAllowed = true): Promise<Paired> {
  const p = devices.startPairing('phone', notesAllowed ? ['view', 'note'] : ['view'])
  const secret = fromHex(p.secret, 32)!
  const r = await post('/api/pair', { pairing: p.pairing, name: 'iPhone', sig: sign(secret, pairMessage(p.pairing, 'iPhone')) })
  expect(r.status).toBe(200)
  return { device: JSON.parse(r.body).device, secret }
}

let n = 0
const nonce = (): string => (++n).toString(16).padStart(32, '0')

function signedCall(d: Paired, method: string, args: unknown[], o: { time?: number; nonce?: string; contract?: string } = {}): Promise<Res> {
  const body = JSON.stringify({ method, args })
  const time = o.time ?? Math.floor(clock / 1000)
  const nc = o.nonce ?? nonce()
  return http('/api/call', {
    method: 'POST',
    body,
    headers: {
      origin: server.origin, 'content-type': 'application/json', 'x-reel-contract': o.contract ?? String(CONTRACT_VERSION),
      'x-reel-device': d.device, 'x-reel-time': String(time), 'x-reel-nonce': nc, 'x-reel-sig': sign(d.secret, callMessage(d.device, time, nc, body))
    }
  })
}

function mediaPath(d: Paired, ref: string, o: { save?: boolean; expires?: number } = {}): string {
  const e = o.expires ?? Math.floor(clock / 1000) + 600
  return `/media/${encodeURIComponent(ref)}?d=${d.device}&e=${e}&s=${sign(d.secret, mediaMessage(d.device, ref, e, !!o.save))}${o.save ? '&save=1' : ''}`
}

describe('pairing', () => {
  it('works once: the same code cannot pair a second device', async () => {
    const p = devices.startPairing('phone', ['view'])
    const secret = fromHex(p.secret, 32)!
    const body = { pairing: p.pairing, name: 'iPhone', sig: sign(secret, pairMessage(p.pairing, 'iPhone')) }
    expect((await post('/api/pair', body)).status).toBe(200)
    expect((await post('/api/pair', body)).status).toBe(404)
  })

  it('refuses a wrong signature without using the code up', async () => {
    const p = devices.startPairing('phone', ['view'])
    const secret = fromHex(p.secret, 32)!
    expect((await post('/api/pair', { pairing: p.pairing, name: 'iPhone', sig: sign(new Uint8Array(32), pairMessage(p.pairing, 'iPhone')) })).status).toBe(401)
    expect((await post('/api/pair', { pairing: p.pairing, name: 'iPhone', sig: sign(secret, pairMessage(p.pairing, 'iPhone')) })).status).toBe(200)
  })

  it('refuses a code after its five minutes', async () => {
    const p = devices.startPairing('phone', ['view'])
    clock += PAIRING_TTL_MS + 1
    expect((await post('/api/pair', { pairing: p.pairing, name: 'iPhone', sig: sign(fromHex(p.secret, 32)!, pairMessage(p.pairing, 'iPhone')) })).status).toBe(404)
  })

  it('reads the secret back out of a pairing link fragment', () => {
    const f = parsePairingFragment(`#p=${'a'.repeat(32)}.${'b'.repeat(64)}`)
    expect(f).toEqual({ pairing: 'a'.repeat(32), secret: 'b'.repeat(64) })
    expect(parsePairingFragment(`#p=${'a'.repeat(32)}.${'b'.repeat(63)}`)).toBeNull()
  })
})

describe('calls', () => {
  it('answers a paired device, with no path on this computer anywhere in a reel or the list', async () => {
    const d = await pairDevice()
    const list = await signedCall(d, 'projects.list', [])
    const reel = await signedCall(d, 'projects.get', ['family-time'])
    expect(JSON.parse(reel.body)).toMatchObject({ ok: true, value: { id: 'family-time', versions: [{ n: 1, video: mediaRef('video', 'family-time', 1), change: '“music quieter”' }] } })
    for (const body of [list.body, reel.body]) {
      expect(body).not.toContain(root.replace(/\\/g, '\\\\'))
      expect(body).not.toContain(encodeURIComponent(root))
      expect(body).not.toContain('reel-media:')
    }
  })

  it('refuses an unpaired device, a replayed request, a wrong clock and another contract version', async () => {
    const d = await pairDevice()
    expect((await signedCall({ device: 'f'.repeat(32), secret: d.secret }, 'projects.list', [])).status).toBe(401)
    const nc = nonce()
    expect((await signedCall(d, 'projects.list', [], { nonce: nc })).status).toBe(200)
    const again = await signedCall(d, 'projects.list', [], { nonce: nc })
    expect([again.status, JSON.parse(again.body).error]).toEqual([401, 'REPLAYED'])
    const late = await signedCall(d, 'projects.list', [], { time: Math.floor(clock / 1000) - 3600 })
    expect([late.status, JSON.parse(late.body).error]).toEqual([401, 'CLOCK'])
    expect((await signedCall(d, 'projects.list', [], { contract: '0' })).status).toBe(426)
  })

  it('refuses another Host (DNS rebinding) and another Origin', async () => {
    const d = await pairDevice()
    expect((await http('/api/time', { headers: { host: `evil.example:${server.port}` } })).status).toBe(421)
    const r = await post('/api/call', { method: 'projects.list', args: [] }, { origin: 'http://evil.example', 'x-reel-device': d.device })
    expect(r.status).toBe(403)
  })

  it('refuses a call with arguments of the wrong shape, in words', async () => {
    const d = await pairDevice()
    const r = JSON.parse((await signedCall(d, 'projects.get', ['../etc'])).body)
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
  })

  it('lets a watch-only device watch but not send notes', async () => {
    const d = await pairDevice(false)
    expect(JSON.parse((await signedCall(d, 'projects.get', ['family-time'])).body).ok).toBe(true)
    const r = JSON.parse((await signedCall(d, 'projects.note', ['family-time', { requestId: 'req-00000001', text: 'louder' }])).body)
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(notes).toEqual([])
  })

  it('runs a retried note once, and places "Note here" on that version', async () => {
    const d = await pairDevice()
    const args = ['family-time', { requestId: 'req-00000002', text: 'cut this', version: 1, at: 7 }]
    const first = JSON.parse((await signedCall(d, 'projects.note', args)).body)
    const retry = JSON.parse((await signedCall(d, 'projects.note', args)).body)
    expect(first.value).toEqual({ jobId: 'job-1', queued: false, replayed: false })
    expect(retry.value).toEqual({ jobId: 'job-1', queued: false, replayed: true })
    expect(notes).toEqual([{ slug: 'family-time', text: 'cut this', at: 7, version: 1 }])
  })

  it('forgets a removed device and one unused for longer than the idle limit', async () => {
    const a = await pairDevice()
    const b = await pairDevice()
    await devices.remove(a.device)
    expect((await signedCall(a, 'projects.list', [])).status).toBe(401)
    clock += DEVICE_IDLE_MS + 1
    expect((await signedCall(b, 'projects.list', [])).status).toBe(401)
  })
})

describe('media', () => {
  it('serves byte ranges of a version with a signed link, and refuses an unsigned or expired one', async () => {
    const d = await pairDevice()
    const ref = mediaRef('video', 'family-time', 1)
    const part = await http(mediaPath(d, ref), { headers: { range: 'bytes=100-199' } })
    expect([part.status, part.headers['content-range'], part.body.length]).toEqual([206, 'bytes 100-199/50000', 100])
    expect((await http(mediaPath(d, ref), { headers: { range: 'bytes=60000-' } })).status).toBe(416)
    expect((await http(`/media/${encodeURIComponent(ref)}?d=${d.device}&e=${Math.floor(clock / 1000) + 600}&s=${'0'.repeat(64)}`)).status).toBe(403)
    expect((await http(mediaPath(d, ref, { expires: Math.floor(clock / 1000) - 1 }))).status).toBe(403)
  })

  it('saves under the reel and version name when asked', async () => {
    const d = await pairDevice()
    const r = await http(mediaPath(d, mediaRef('video', 'family-time', 1), { save: true }), { method: 'HEAD' })
    expect(r.headers['content-disposition']).toContain(`attachment; filename="Family time, version 1.mp4"`)
  })

  it('sends nothing outside the reel folder, even when the reel names it', async () => {
    const d = await pairDevice()
    for (const ref of ['v1~../secret', 'v1~family-time/../../secret', 't1~family-time', 'x~family-time']) expect((await http(mediaPath(d, ref))).status).toBe(404)
    current = detail({ versions: [{ ...detail().versions[0], videoPath: outside }] })
    expect((await http(mediaPath(d, mediaRef('video', 'family-time', 1)))).status).toBe(404)
  })

  it.skipIf(process.platform === 'win32')('sends nothing through a link that leads outside the reel folder', async () => {
    const d = await pairDevice()
    const link = join(reelDir, 'versions', 'v1', 'linked.mp4')
    symlinkSync(outside, link)
    current = detail({ versions: [{ ...detail().versions[0], videoPath: link }] })
    expect((await http(mediaPath(d, mediaRef('video', 'family-time', 1)))).status).toBe(404)
  })
})

describe('events', () => {
  function stream(path: string): Promise<{ events: ContractEvent[]; ended: Promise<void>; next: () => Promise<ContractEvent> }> {
    return new Promise((resolve, reject) => {
      const req = request(`${server.origin}${path}`, { headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`))
        const events: ContractEvent[] = []
        const waiting: ((e: ContractEvent) => void)[] = []
        let buf = ''
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8')
          let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (!block.startsWith('data: ')) continue
            const e = JSON.parse(block.slice(6)) as ContractEvent
            const w = waiting.shift()
            if (w) w(e)
            else events.push(e)
          }
        })
        const ended = new Promise<void>((r) => res.on('end', () => r()))
        resolve({ events, ended, next: () => (events.length ? Promise.resolve(events.shift()!) : new Promise((r) => waiting.push(r))) })
      })
      req.on('error', reject)
      req.end()
    })
  }

  const eventsPath = (d: Paired): string => {
    const t = Math.floor(clock / 1000)
    const nc = nonce()
    return `/api/events?d=${d.device}&t=${t}&n=${nc}&s=${sign(d.secret, eventsMessage(d.device, t, nc))}`
  }

  it('says ready, passes on job progress, and tells a removed device before closing', async () => {
    const d = await pairDevice()
    const s = await stream(eventsPath(d))
    expect(await s.next()).toEqual({ type: 'ready' })
    server.publish(contractEvent('job:event', { type: 'done', jobId: 'job-1', slug: 'family-time', summary: 'done' })!)
    expect(await s.next()).toEqual({ type: 'job', project: 'family-time', job: null, done: true })
    server.revoke(d.device)
    expect(await s.next()).toEqual({ type: 'revoked' })
    await s.ended
  })

  it('refuses an unsigned stream', async () => {
    const d = await pairDevice()
    const t = Math.floor(clock / 1000)
    expect((await http(`/api/events?d=${d.device}&t=${t}&n=${nonce()}&s=${'0'.repeat(64)}`)).status).toBe(401)
  })
})

describe('the page', () => {
  it('serves the phone page and its build assets to anyone, and nothing else from the build folder', async () => {
    const page = await http('/')
    expect([page.status, page.headers['content-security-policy']]).toEqual([200, expect.stringContaining("connect-src 'self'")])
    expect((await http('/assets/companion-abc123.js')).status).toBe(200)
    expect((await http('/assets/..%2Fcompanion.html')).status).toBe(404)
    expect((await http('/index.html.map')).status).toBe(404)
  })
})
