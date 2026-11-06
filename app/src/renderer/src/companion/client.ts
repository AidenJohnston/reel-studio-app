// The companion page's half of the contract (shared/contract.ts): pairing, signed calls, the event stream and signed
// media links, over the routes in COMPANION-API.md. The page is plain http on the home network, so there is no
// crypto.subtle; signatures come from shared/sha256.ts and nonces from crypto.getRandomValues, which works without a
// secure context.
//
// One pairing per origin, kept in localStorage under STORAGE_KEY. A 401 (after one clock re-check) or a `revoked`
// event forgets it, and every onPairing listener hears why.
import {
  CONTRACT_VERSION,
  DEVICE_ID,
  HEADERS,
  MEDIA_MAX_S,
  SECRET_BYTES,
  VERSION_HEADER,
  callMessage,
  eventsMessage,
  mediaMessage,
  pairMessage,
  parsePairingFragment,
  sign,
  type ContractEvent,
  type MediaRef,
  type Method,
  type NoteArgs,
  type ProjectId,
  type Reply,
  type Results
} from '../../../shared/contract'
import { fromHex, toHex } from '../../../shared/sha256'
import { deviceName, noun } from './device'

export const STORAGE_KEY = 'reel-companion'

export interface Pairing {
  device: string
  /** 64 hex characters: the 32-byte secret from the pairing link's fragment. */
  secret: string
  installationId: string
  /** "Jo's MacBook"; empty until the first app.info after pairing. */
  computer: string
  /** The computer's clock minus this one's, in seconds (from /api/time). Every signed time adds it. */
  offset: number
}

/** What each call takes. The contract checks these on the computer; this only types the page's side. */
export interface Args {
  'app.info': []
  'projects.list': []
  'projects.get': [ProjectId]
  'projects.note': [ProjectId, NoteArgs]
  'jobs.cancel': [ProjectId, string]
}

/**
 * offline: the computer didn't answer (asleep, Reel Studio closed, Phone and browser off).
 * unpaired: no pairing, or the computer no longer knows this device. refused: the computer said no (scope, a bad
 * code, too many tries). outdated: this page and the app speak different contract versions. app: the app's own error.
 */
export type ProblemKind = 'offline' | 'unpaired' | 'refused' | 'outdated' | 'app'

export class CompanionError extends Error {
  constructor(
    readonly kind: ProblemKind,
    readonly userMessage: string,
    readonly code: string | null = null
  ) {
    super(userMessage)
  }
}

export const OFFLINE_WORDS = "Can't reach your computer. It may be asleep, Reel Studio may be closed, or Phone and browser may be turned off in its Settings."
const unpairedWords = (): string => `This ${noun()} isn't paired with that computer anymore. Scan the code in Reel Studio again.`
const OUTDATED_WORDS = 'This page is out of date for Reel Studio on your computer. Reload the page.'

/** A link may be reused until this long before it expires, so a playing video's src never changes under it. */
const RESIGN_BEFORE_S = 300
/** Seconds between event-stream reconnects, growing; the last repeats. */
const BACKOFF_S = [1, 2, 4, 8, 15]

// ---- the stored pairing --------------------------------------------------------------------------

const SECRET_HEX = /^[0-9a-f]{64}$/

function valid(v: unknown): v is Pairing {
  if (v === null || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.device === 'string' &&
    DEVICE_ID.test(p.device) &&
    typeof p.secret === 'string' &&
    SECRET_HEX.test(p.secret) &&
    typeof p.installationId === 'string' &&
    typeof p.computer === 'string' &&
    typeof p.offset === 'number' &&
    Number.isFinite(p.offset)
  )
}

/** The stored pairing, or null. Anything malformed in storage is dropped: the page can only pair again. */
export function pairing(): Pairing | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const p: unknown = JSON.parse(raw)
    if (valid(p)) return p
  } catch {
    /* dropped below */
  }
  localStorage.removeItem(STORAGE_KEY)
  return null
}

function store(p: Pairing): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Safari's private browsing used to refuse every write; without storage the page can't stay paired.
    throw new CompanionError('app', "This browser won't keep the pairing. Turn off Private Browsing, then scan the code again.")
  }
}

type PairingListener = (p: Pairing | null, why: string | null) => void
const listeners = new Set<PairingListener>()

/** Hears every pairing change: a new pairing, a renamed computer, and forgetting (with the words to show, if any). */
export function onPairing(fn: PairingListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const tell = (p: Pairing | null, why: string | null): void => {
  for (const fn of [...listeners]) fn(p, why)
}

const streams = new Set<{ close(): void }>()
const media = new Map<string, { url: string; expires: number }>()

/** Drops the pairing, its open event streams and its signed links. `why` is what the page should say, if anything. */
export function forget(why: string | null = null): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing stored to remove */
  }
  media.clear()
  for (const s of [...streams]) s.close()
  tell(null, why)
}

// ---- signing helpers -----------------------------------------------------------------------------

/** The computer's clock, in whole seconds. */
const computerNow = (p: Pairing): number => Math.floor(Date.now() / 1000 + p.offset)

function nonce(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return toHex(b)
}

/** A note's id (NoteArgs.requestId): 32 random hex characters, kept by the page until a reply arrives. */
export const requestId = nonce

function secretOf(p: Pairing): Uint8Array {
  const s = fromHex(p.secret, SECRET_BYTES)
  // valid() already held it to 64 hex characters
  if (!s) throw new Error('stored secret is not 32 bytes of hex')
  return s
}

async function serverTime(): Promise<{ now: number; contract: number }> {
  let res: Response
  try {
    res = await fetch('/api/time', { cache: 'no-store' })
  } catch {
    throw new CompanionError('offline', OFFLINE_WORDS)
  }
  if (!res.ok) throw new CompanionError('offline', OFFLINE_WORDS)
  const body = (await res.json()) as { now?: unknown; contract?: unknown }
  if (typeof body.now !== 'number' || !Number.isFinite(body.now)) throw new CompanionError('app', 'Reel Studio sent a time this page could not read. Reload the page.')
  if (body.contract !== CONTRACT_VERSION) throw new CompanionError('outdated', OUTDATED_WORDS)
  return { now: body.now, contract: body.contract }
}

const offsetFrom = (now: number): number => now - Date.now() / 1000

// ---- pairing -------------------------------------------------------------------------------------

/** Takes the pairing fragment out of the address bar and history, so the secret isn't left in either. */
function dropFragment(): void {
  history.replaceState(history.state, '', location.pathname + location.search)
}

/**
 * Pairs with the computer from a link's fragment (`#p=<pairing>.<secret>`): reads its clock, proves the secret,
 * stores the pairing and removes the fragment. A code that can never work again (expired, used, or refused) is
 * removed too; one that might work on a retry (no answer, too many tries) stays for Try again.
 * A pairing code works once, so a second call for the same fragment while the first runs gets the first's answer.
 */
export function pair(fragment: string): Promise<Pairing> {
  if (inflight && inflight.fragment === fragment) return inflight.run
  const run: Promise<Pairing> = pairOnce(fragment).finally(() => {
    if (inflight?.run === run) inflight = null
  })
  inflight = { fragment, run }
  return run
}
let inflight: { fragment: string; run: Promise<Pairing> } | null = null

async function pairOnce(fragment: string): Promise<Pairing> {
  const link = parsePairingFragment(fragment)
  if (!link) throw new CompanionError('refused', "That link isn't a whole pairing code. Scan the code in Reel Studio again.")
  const secret = fromHex(link.secret, SECRET_BYTES)
  if (!secret) throw new CompanionError('refused', "That link isn't a whole pairing code. Scan the code in Reel Studio again.")
  await serverTime()
  const name = deviceName()
  let res: Response
  try {
    res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [VERSION_HEADER]: String(CONTRACT_VERSION) },
      body: JSON.stringify({ pairing: link.pairing, name, sig: sign(secret, pairMessage(link.pairing, name)) }),
      cache: 'no-store'
    })
  } catch {
    throw new CompanionError('offline', OFFLINE_WORDS)
  }
  if (res.status === 404) {
    dropFragment()
    throw new CompanionError('refused', 'That code has expired. Make a new one in Reel Studio.')
  }
  if (res.status === 401) {
    dropFragment()
    throw new CompanionError('refused', "That code didn't work. Make a new one in Reel Studio and scan it again.")
  }
  if (res.status === 429) throw new CompanionError('refused', 'Too many tries. Wait a minute, then make a new code in Reel Studio.')
  if (res.status === 426) throw new CompanionError('outdated', OUTDATED_WORDS)
  if (!res.ok) throw new CompanionError('app', "Reel Studio couldn't pair with this " + noun() + '. Make a new code and try again.')
  const body = (await res.json()) as { device?: unknown; installationId?: unknown; now?: unknown }
  if (typeof body.device !== 'string' || !DEVICE_ID.test(body.device) || typeof body.installationId !== 'string' || typeof body.now !== 'number') {
    throw new CompanionError('app', 'Reel Studio answered in a way this page could not read. Reload the page and scan the code again.')
  }
  // The pair answer's clock is the freshest one: it was read after the signature check.
  const p: Pairing = { device: body.device, secret: link.secret, installationId: body.installationId, computer: '', offset: offsetFrom(body.now) }
  store(p)
  dropFragment()
  media.clear()
  tell(p, null)
  return p
}

// ---- calls ---------------------------------------------------------------------------------------

async function post(p: Pairing, body: string): Promise<Response> {
  const time = computerNow(p)
  const n = nonce()
  try {
    return await fetch('/api/call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [VERSION_HEADER]: String(CONTRACT_VERSION),
        [HEADERS.device]: p.device,
        [HEADERS.time]: String(time),
        [HEADERS.nonce]: n,
        [HEADERS.sig]: sign(secretOf(p), callMessage(p.device, time, n, body))
      },
      body,
      cache: 'no-store'
    })
  } catch {
    throw new CompanionError('offline', OFFLINE_WORDS)
  }
}

/**
 * One signed call. A 401 is checked once against a fresh clock reading before the pairing is forgotten: a computer
 * whose clock moved (sleep, a time-zone or NTP change) refuses the old offset, and that alone must not unpair.
 */
export async function call<M extends Method>(method: M, args: Args[M]): Promise<Results[M]> {
  let p = pairing()
  if (!p) throw new CompanionError('unpaired', unpairedWords())
  const body = JSON.stringify({ method, args })
  let res = await post(p, body)
  if (res.status === 401) {
    const { now } = await serverTime()
    p = { ...p, offset: offsetFrom(now) }
    store(p)
    res = await post(p, body)
  }
  if (res.status === 401) {
    const why = unpairedWords()
    forget(why)
    throw new CompanionError('unpaired', why)
  }
  if (res.status === 403) throw new CompanionError('refused', `This ${noun()} can watch only. It can't send notes or stop an edit.`)
  if (res.status === 426) throw new CompanionError('outdated', OUTDATED_WORDS)
  if (res.status === 413) throw new CompanionError('refused', 'That note is too long to send.')
  if (!res.ok) throw new CompanionError('app', "Reel Studio on your computer couldn't do that. Try again.")
  let reply: Reply<Results[M]>
  try {
    reply = (await res.json()) as Reply<Results[M]>
  } catch {
    throw new CompanionError('app', 'Reel Studio answered in a way this page could not read. Reload the page.')
  }
  if (!reply.ok) throw new CompanionError('app', reply.error.userMessage, reply.error.code)
  if (method === 'app.info') known(p, reply.value as Results['app.info'])
  return reply.value
}

/** After app.info: a different installation at this address means another computer took it; otherwise keep its name. */
function known(p: Pairing, info: Results['app.info']): void {
  if (info.installationId !== p.installationId) {
    const why = unpairedWords()
    forget(why)
    throw new CompanionError('unpaired', why)
  }
  if (info.computer !== p.computer) {
    const next = { ...p, computer: info.computer }
    store(next)
    tell(next, null)
  }
}

// ---- events --------------------------------------------------------------------------------------

export interface EventStream {
  close(): void
  /** Reconnects now, instead of waiting out the backoff (Try again, or the page coming back to the front). */
  retryNow(): void
}

/**
 * The computer's events. Reconnects itself after 1, 2, 4, 8, then every 15 s, signing each attempt afresh (the
 * browser's own EventSource retry would resend a used nonce). `onLive` hears true on each `ready` and false on each
 * drop; read everything again after a true.
 */
export function events(onEvent: (e: ContractEvent) => void, onLive: (live: boolean) => void): EventStream {
  let source: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let closed = false

  const open = (): void => {
    const p = pairing()
    if (closed || !p) return
    const t = computerNow(p)
    const n = nonce()
    const q = new URLSearchParams({ d: p.device, t: String(t), n, s: sign(secretOf(p), eventsMessage(p.device, t, n)) })
    const es = new EventSource(`/api/events?${q}`)
    source = es
    es.onmessage = (m) => {
      let e: ContractEvent
      try {
        e = JSON.parse(String(m.data)) as ContractEvent
      } catch {
        return
      }
      if (e.type === 'ready') {
        attempt = 0
        onLive(true)
      }
      if (e.type === 'revoked') {
        onEvent(e)
        forget(unpairedWords())
        return
      }
      onEvent(e)
    }
    es.onerror = () => {
      es.close()
      if (source === es) source = null
      if (closed) return
      onLive(false)
      const wait = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]
      attempt++
      clearTimeout(timer)
      timer = setTimeout(open, wait * 1000)
    }
  }

  const stream: EventStream = {
    close() {
      closed = true
      clearTimeout(timer)
      source?.close()
      source = null
      streams.delete(stream)
    },
    retryNow() {
      if (closed) return
      // A phone that slept can hold a stream that looks open but is dead, so an open one is replaced too.
      clearTimeout(timer)
      source?.close()
      source = null
      attempt = 0
      open()
    }
  }
  streams.add(stream)
  open()
  return stream
}

// ---- media ---------------------------------------------------------------------------------------

/**
 * A signed link to a video or picture, good for MEDIA_MAX_S. The same link comes back until 5 minutes before it
 * expires, so rendering again doesn't change a playing video's src. `save` asks the computer to send it as a download.
 */
export function mediaUrl(ref: MediaRef, opts: { save?: boolean } = {}): string {
  const p = pairing()
  if (!p) throw new CompanionError('unpaired', unpairedWords())
  const save = opts.save === true
  const key = `${save ? 1 : 0}:${ref}`
  const now = computerNow(p)
  const hit = media.get(key)
  if (hit && now < hit.expires - RESIGN_BEFORE_S) return hit.url
  const expires = now + MEDIA_MAX_S
  const q = new URLSearchParams({ d: p.device, e: String(expires), s: sign(secretOf(p), mediaMessage(p.device, ref, expires, save)) })
  if (save) q.set('save', '1')
  const url = `/media/${encodeURIComponent(ref)}?${q}`
  media.set(key, { url, expires })
  return url
}
