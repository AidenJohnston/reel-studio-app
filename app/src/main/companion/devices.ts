// The phones and browsers paired with this computer, and the checks every signed request passes (shared/contract.ts
// says what is signed). No Electron imports: index.ts hands in safeStorage, tests a fake.
//
// Kept in devices.bin, encrypted by the OS keychain, or where there is none (Linux without a keyring) in
// devices.json readable only by this user, like posting's sign-in (posting-ipc.ts createSessionStore).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  CLOCK_SKEW_S, DEVICE_ID, MEDIA_MAX_S, NONCE, PAIRING_ID, SCOPES, callMessage, eventsMessage, mediaMessage, pairMessage, type Scope
} from '../../shared/contract'
import type { SecretStore } from '../posting-ipc'
import { renameWithRetry } from '../store'

export type DeviceKind = 'phone' | 'browser'

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  scopes: Scope[]
  pairedAt: number
  lastSeenAt: number
}

interface Stored extends Device {
  secret: string
}

interface StoreFile {
  v: 1
  installationId: string
  devices: Stored[]
}

/** How long a pairing code works. Long enough to find the phone and open the camera. */
export const PAIRING_TTL_MS = 5 * 60_000
/**
 * A device unused this long is forgotten, so a pairing on a lost or sold phone doesn't last forever. There is no
 * evidence behind 30 days; it is a guess at "longer than a holiday", easy to change.
 */
export const DEVICE_IDLE_MS = 30 * 24 * 3600_000
/** Failed pairing tries allowed per minute, across all callers, before the rest of the minute is refused. */
export const PAIR_TRIES_PER_MIN = 20
/** lastSeenAt is written at most this often, so a playing video doesn't rewrite the file on every range request. */
const TOUCH_WRITE_MS = 10 * 60_000
const NONCE_KEEP_MS = 2 * CLOCK_SKEW_S * 1000
const NONCE_MAX = 10_000
export const NAME_MAX = 60

export type Refusal = 'unknown' | 'bad-signature' | 'stale' | 'replayed' | 'expired' | 'rate'

export interface Pairing {
  pairing: string
  secret: string
  expiresAt: number
  kind: DeviceKind
}

const hmac = (secretHex: string, message: string): Buffer => createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message, 'utf8').digest()

/** Constant-time compare of a hex signature from the wire with the expected one. */
function sigOk(given: unknown, expected: Buffer): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false
  return timingSafeEqual(Buffer.from(given, 'hex'), expected)
}

export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX)
  return s || null
}

export interface DeviceRegistryOptions {
  dir: string
  secrets: SecretStore | null
  log: (line: string) => void
  now?: () => number
  random?: (n: number) => Buffer
}

export function createDeviceRegistry(o: DeviceRegistryOptions) {
  const now = o.now ?? Date.now
  const random = o.random ?? randomBytes
  const enc = join(o.dir, 'devices.bin')
  const plain = join(o.dir, 'devices.json')
  const safe = (): boolean => !!o.secrets && o.secrets.isEncryptionAvailable() && o.secrets.getSelectedStorageBackend?.() !== 'basic_text'

  let data: StoreFile | null = null
  let pairing: (Pairing & { scopes: Scope[] }) | null = null
  const nonces = new Map<string, number>()
  const written = new Map<string, number>()
  let failures: { minute: number; count: number } = { minute: 0, count: 0 }
  const listeners = new Set<() => void>()
  let saving: Promise<void> = Promise.resolve()

  const changed = (): void => {
    for (const l of listeners) {
      try {
        l()
      } catch {
        /* a listener's mistake never breaks a request */
      }
    }
  }

  async function read(): Promise<StoreFile | null> {
    try {
      if (o.secrets && safe()) {
        const b = await fs.readFile(enc).catch(() => null)
        if (b) return JSON.parse(o.secrets.decryptString(b))
      }
      return JSON.parse(await fs.readFile(plain, 'utf8'))
    } catch {
      return null
    }
  }

  function valid(f: StoreFile | null): f is StoreFile {
    return !!f && f.v === 1 && typeof f.installationId === 'string' && Array.isArray(f.devices)
  }

  // One read, however many requests arrive before it finishes (two reads could each make an installation id).
  let loading: Promise<StoreFile> | null = null
  const load = (): Promise<StoreFile> => (loading ??= first())

  async function first(): Promise<StoreFile> {
    const f = await read()
    data = valid(f)
      ? {
          v: 1,
          installationId: f.installationId,
          devices: f.devices.filter(
            (d) => DEVICE_ID.test(d.id) && /^[0-9a-f]{64}$/.test(d.secret) && Array.isArray(d.scopes) && d.scopes.every((s) => SCOPES.includes(s))
          )
        }
      : { v: 1, installationId: random(16).toString('hex'), devices: [] }
    if (!valid(f)) await save()
    return data!
  }

  function save(): Promise<void> {
    const snapshot = JSON.stringify(data)
    saving = saving.then(async () => {
      await fs.mkdir(o.dir, { recursive: true })
      const write = async (file: string, body: string | Buffer): Promise<void> => {
        const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await fs.writeFile(tmp, body, { mode: 0o600 })
        await renameWithRetry(tmp, file)
      }
      if (o.secrets && safe()) {
        await write(enc, o.secrets.encryptString(snapshot))
        await fs.rm(plain, { force: true })
      } else {
        await write(plain, snapshot)
        await fs.rm(enc, { force: true })
      }
    })
    return saving.catch((e) => o.log(`[devices] save failed: ${String(e)}`))
  }

  /** Drops devices idle past DEVICE_IDLE_MS. */
  async function sweep(): Promise<void> {
    const f = await load()
    const keep = f.devices.filter((d) => now() - d.lastSeenAt < DEVICE_IDLE_MS)
    if (keep.length !== f.devices.length) {
      f.devices = keep
      await save()
      changed()
    }
  }

  async function find(id: unknown): Promise<Stored | null> {
    if (typeof id !== 'string' || !DEVICE_ID.test(id)) return null
    await sweep()
    return (await load()).devices.find((d) => d.id === id) ?? null
  }

  function touch(d: Stored): void {
    d.lastSeenAt = now()
    if (now() - (written.get(d.id) ?? 0) >= TOUCH_WRITE_MS) {
      written.set(d.id, now())
      void save()
    }
  }

  function freshNonce(nonce: unknown): boolean {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return false
    const t = now()
    for (const [n, at] of nonces) {
      if (t - at < NONCE_KEEP_MS && nonces.size <= NONCE_MAX) break
      nonces.delete(n) // a Map keeps insertion order: the oldest go first
    }
    if (nonces.has(nonce)) return false
    nonces.set(nonce, t)
    return true
  }

  const timeOk = (time: unknown): time is number =>
    typeof time === 'number' && Number.isInteger(time) && Math.abs(time - now() / 1000) <= CLOCK_SKEW_S

  const view = ({ secret: _s, ...d }: Stored): Device => ({ ...d, scopes: [...d.scopes] })

  return {
    async installationId(): Promise<string> {
      return (await load()).installationId
    },

    async list(): Promise<Device[]> {
      await sweep()
      return (await load()).devices.map(view)
    },

    /** A new pairing code; the one before stops working. */
    startPairing(kind: DeviceKind, scopes: Scope[]): Pairing {
      pairing = { pairing: random(16).toString('hex'), secret: random(32).toString('hex'), expiresAt: now() + PAIRING_TTL_MS, kind, scopes: [...new Set(scopes)] }
      return { pairing: pairing.pairing, secret: pairing.secret, expiresAt: pairing.expiresAt, kind }
    },

    cancelPairing(): void {
      pairing = null
    },

    pairingOpen(): boolean {
      return !!pairing && pairing.expiresAt > now()
    },

    /** POST /api/pair. The code works once; a wrong signature doesn't use it up. */
    async completePairing(body: { pairing?: unknown; name?: unknown; sig?: unknown }): Promise<Device | Refusal> {
      const minute = Math.floor(now() / 60_000)
      if (failures.minute !== minute) failures = { minute, count: 0 }
      if (failures.count >= PAIR_TRIES_PER_MIN) return 'rate'
      const fail = (r: Refusal): Refusal => {
        failures.count++
        return r
      }
      const p = pairing
      if (!p || typeof body.pairing !== 'string' || !PAIRING_ID.test(body.pairing)) return fail('unknown')
      if (!timingSafeEqual(Buffer.from(body.pairing), Buffer.from(p.pairing))) return fail('unknown')
      if (p.expiresAt <= now()) {
        pairing = null
        return fail('expired')
      }
      const name = cleanName(body.name)
      if (!name || !sigOk(body.sig, hmac(p.secret, pairMessage(p.pairing, String(body.name))))) return fail('bad-signature')
      pairing = null
      const f = await load()
      const d: Stored = { id: random(16).toString('hex'), name, kind: p.kind, scopes: p.scopes, pairedAt: now(), lastSeenAt: now(), secret: p.secret }
      f.devices.push(d)
      written.set(d.id, now())
      await save()
      changed()
      return view(d)
    },

    /** POST /api/call: headers checked against the raw body. */
    async checkCall(h: { device?: unknown; time?: unknown; nonce?: unknown; sig?: unknown }, body: string): Promise<Device | Refusal> {
      const d = await find(h.device)
      if (!d) return 'unknown'
      const time = Number(h.time)
      if (!timeOk(time)) return 'stale'
      if (!sigOk(h.sig, hmac(d.secret, callMessage(d.id, time, String(h.nonce), body)))) return 'bad-signature'
      if (!freshNonce(h.nonce)) return 'replayed'
      touch(d)
      return view(d)
    },

    /** GET /api/events?d=&t=&n=&s= */
    async checkEvents(q: { d?: unknown; t?: unknown; n?: unknown; s?: unknown }): Promise<Device | Refusal> {
      const d = await find(q.d)
      if (!d) return 'unknown'
      const time = Number(q.t)
      if (!timeOk(time)) return 'stale'
      if (!sigOk(q.s, hmac(d.secret, eventsMessage(d.id, time, String(q.n))))) return 'bad-signature'
      if (!freshNonce(q.n)) return 'replayed'
      touch(d)
      return view(d)
    },

    /**
     * GET /media/<ref>?d=&e=&s=. No nonce: a video element asks for many ranges of one URL. The expiry bounds how
     * long a copied link works; MEDIA_MAX_S bounds how far ahead a page may sign one.
     */
    async checkMedia(ref: string, q: { d?: unknown; e?: unknown; s?: unknown; save?: unknown }): Promise<Device | Refusal> {
      const d = await find(q.d)
      if (!d) return 'unknown'
      const e = Number(q.e)
      const t = now() / 1000
      if (!Number.isInteger(e) || e < t || e > t + MEDIA_MAX_S + CLOCK_SKEW_S) return 'expired'
      if (!sigOk(q.s, hmac(d.secret, mediaMessage(d.id, ref, e, q.save === '1')))) return 'bad-signature'
      touch(d)
      return view(d)
    },

    async remove(id: string): Promise<boolean> {
      const f = await load()
      const before = f.devices.length
      f.devices = f.devices.filter((d) => d.id !== id)
      if (f.devices.length === before) return false
      await save()
      changed()
      return true
    },

    onChange(cb: () => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    /** Waits for writes in flight (tests, quit). */
    flushed: (): Promise<void> => saving
  }
}

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>
