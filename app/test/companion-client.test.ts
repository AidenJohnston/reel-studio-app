/// <reference lib="dom" />
// The companion page's transport (renderer/src/companion/client.ts) against the contract the computer checks
// (shared/contract.ts, COMPANION-API.md): what a call, a media link and a pairing sign, and when the page forgets.
// The DOM lib above is for client.ts, a browser module this Node project compiles through this file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADERS, VERSION_HEADER, callMessage, mediaMessage, pairMessage, pairingFragment, sign } from '../src/shared/contract'
import { fromHex } from '../src/shared/sha256'
import { STORAGE_KEY, call, forget, mediaUrl, onPairing, pair, pairing, type Pairing } from '../src/renderer/src/companion/client'

const SECRET = '3c'.repeat(32)
const KEY = fromHex(SECRET, 32)!
const DEVICE = '0123456789abcdef0123456789abcdef'
const PAIRING_ID = 'fedcba9876543210fedcba9876543210'
const NOW_MS = 1_800_000_000_000

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    }
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers each path with its route (a fresh Response per request); anything else is a test failure. */
function serve(routes: Record<string, (init: RequestInit | undefined, n: number) => Response>) {
  const seen: Record<string, number> = {}
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const route = routes[path]
    if (!route) throw new Error(`unexpected request to ${path}`)
    seen[path] = (seen[path] ?? 0) + 1
    return route(init, seen[path])
  })
  vi.stubGlobal('fetch', f)
  return f
}

const paired = (offset: number): Pairing => {
  const p: Pairing = { device: DEVICE, secret: SECRET, installationId: 'inst-1', computer: "Sam's MacBook", offset }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  return p
}

let stopListening: (() => void) | null = null
const heard: [Pairing | null, string | null][] = []

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  heard.length = 0
  stopListening = onPairing((p, why) => heard.push([p, why]))
})

afterEach(() => {
  stopListening?.()
  forget()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('companion calls', () => {
  // fails if a call is signed over anything but the bytes it sends, or with this device's clock instead of the
  // computer's, or its headers carry a different nonce than the one signed
  it('signs the exact body with the corrected time and the nonce it sends', async () => {
    paired(12.4)
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => a.fill(0x5a)) as typeof crypto.getRandomValues)
    const f = serve({ '/api/call': () => json({ ok: true, value: { id: 'my-reel' } }) })

    await expect(call('projects.get', ['my-reel'])).resolves.toEqual({ id: 'my-reel' })

    const init = f.mock.calls[0][1]!
    const headers = init.headers as Record<string, string>
    const body = init.body as string
    expect(init.method).toBe('POST')
    expect(JSON.parse(body)).toEqual({ method: 'projects.get', args: ['my-reel'] })
    expect(headers[VERSION_HEADER]).toBe('1')
    expect(headers[HEADERS.device]).toBe(DEVICE)
    expect(headers[HEADERS.time]).toBe('1800000012')
    expect(headers[HEADERS.nonce]).toBe('5a'.repeat(16))
    expect(headers[HEADERS.sig]).toBe(sign(KEY, callMessage(DEVICE, 1800000012, '5a'.repeat(16), body)))
  })

  // fails if a 401 leaves the old pairing stored, so the page keeps signing with a device the computer removed
  it('forgets the pairing when the computer no longer knows this device', async () => {
    paired(0)
    serve({ '/api/call': () => json({}, 401), '/api/time': () => json({ now: 1_800_000_000, contract: 1 }) })

    await expect(call('projects.list', [])).rejects.toMatchObject({ kind: 'unpaired' })

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(pairing()).toBeNull()
    expect(heard.at(-1)?.[0]).toBeNull()
    expect(heard.at(-1)?.[1]).toMatch(/isn't paired with that computer anymore/)
  })

  // fails if a computer whose clock moved (a refusal that a fresh /api/time cures) unpairs the phone
  it('keeps the pairing when a fresh clock reading fixes the refusal', async () => {
    paired(0)
    serve({
      '/api/call': (_, n) => (n === 1 ? json({}, 401) : json({ ok: true, value: [] })),
      '/api/time': () => json({ now: 1_800_000_400, contract: 1 })
    })

    await expect(call('projects.list', [])).resolves.toEqual([])

    expect(pairing()).toMatchObject({ device: DEVICE, offset: 400 })
  })
})

describe('companion media links', () => {
  // fails if the save flag isn't part of what is signed, or the expiry isn't the computer's now + MEDIA_MAX_S
  it('signs the ref, the expiry and the save flag', () => {
    paired(0)
    const ref = 'v3~my-reel'
    const saved = new URL(mediaUrl(ref, { save: true }), 'http://phone.test')
    const watched = new URL(mediaUrl(ref), 'http://phone.test')

    expect(saved.pathname).toBe('/media/v3~my-reel')
    expect(saved.searchParams.get('d')).toBe(DEVICE)
    expect(saved.searchParams.get('e')).toBe('1800003600')
    expect(saved.searchParams.get('save')).toBe('1')
    expect(saved.searchParams.get('s')).toBe(sign(KEY, mediaMessage(DEVICE, ref, 1800003600, true)))
    expect(watched.searchParams.get('save')).toBeNull()
    expect(watched.searchParams.get('s')).toBe(sign(KEY, mediaMessage(DEVICE, ref, 1800003600, false)))
  })

  // fails if a link changes while it has more than 5 minutes left (a playing video would reload), or is still
  // handed out inside its last 5 minutes (it could expire mid-watch)
  it('reuses a link until 5 minutes before it expires, then signs a new one', () => {
    paired(0)
    const first = mediaUrl('c2~my-reel')

    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 3299_000)
    expect(mediaUrl('c2~my-reel')).toBe(first)

    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 3300_000)
    const next = new URL(mediaUrl('c2~my-reel'), 'http://phone.test')
    expect(next.searchParams.get('e')).toBe(String(1_800_000_000 + 3300 + 3600))
    expect(next.searchParams.get('s')).toBe(sign(KEY, mediaMessage(DEVICE, 'c2~my-reel', 1_800_000_000 + 3300 + 3600, false)))
  })
})

describe('companion pairing', () => {
  const replaceState = vi.fn()
  const link = (hash: string) => {
    replaceState.mockReset()
    vi.stubGlobal('location', { hash, pathname: '/', search: '' })
    vi.stubGlobal('history', { state: null, replaceState })
  }

  // fails if the pairing proof is signed over another string, the stored pairing loses a field or the computer's
  // clock, or the secret stays in the address bar
  it('proves the secret, stores the pairing and takes the fragment out of the address bar', async () => {
    link(`#${pairingFragment(PAIRING_ID, SECRET)}`)
    const f = serve({
      '/api/time': () => json({ now: 1_800_000_100, contract: 1 }),
      '/api/pair': () => json({ device: DEVICE, installationId: 'inst-9', scopes: ['view', 'note'], now: 1_800_000_100 })
    })

    await pair(location.hash)

    const sent = JSON.parse(f.mock.calls.find((c) => c[0] === '/api/pair')![1]!.body as string) as { pairing: string; name: string; sig: string }
    expect(sent.pairing).toBe(PAIRING_ID)
    expect(sent.name.length).toBeGreaterThan(0)
    expect(sent.name.length).toBeLessThanOrEqual(60)
    expect(sent.sig).toBe(sign(KEY, pairMessage(PAIRING_ID, sent.name)))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ device: DEVICE, secret: SECRET, installationId: 'inst-9', computer: '', offset: 100 })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(heard.at(-1)?.[0]).toMatchObject({ device: DEVICE })
  })

  // fails if a used or expired code is stored, left in the address bar, or reported in other words
  it('says an expired code has expired, stores nothing, and drops the fragment', async () => {
    link(`#${pairingFragment(PAIRING_ID, SECRET)}`)
    serve({ '/api/time': () => json({ now: 1_800_000_000, contract: 1 }), '/api/pair': () => json({}, 404) })

    await expect(pair(location.hash)).rejects.toMatchObject({ kind: 'refused', userMessage: 'That code has expired. Make a new one in Reel Studio.' })

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
  })
})
