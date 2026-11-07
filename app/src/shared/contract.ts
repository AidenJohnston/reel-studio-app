// The contract between this computer and a paired phone or browser: the calls and events that exist, what each call
// accepts, what it returns, and how every request is signed. main/companion/ serves it; renderer/src/companion/ is
// its client. Main checks every call's arguments here before it runs, so nothing a device sends is trusted for its
// shape.
//
// What goes over the wire carries no path on this computer. Reels are named by their slug, and every video or picture
// by a MediaRef: what it is ("version 3's video of reel X"), never where it is. Main turns a ref into a file only
// inside that reel's folder (main/companion/service.ts).
//
// Keep free of Node and DOM imports: the desktop and the page both import it.
import { hmacSha256, sha256, toHex, utf8 } from './sha256'

/** Bumped when a call, event or signature changes shape. The server refuses other versions with 426. */
export const CONTRACT_VERSION = 1
/** Sent by the client on every call; answered with 426 when it isn't this. */
export const VERSION_HEADER = 'x-reel-contract'

export type Scope = 'view' | 'note'
export const SCOPES: readonly Scope[] = ['view', 'note']

/** A reel's slug, as main/store.ts projectDir accepts it. */
export type ProjectId = string
/** What a video or picture is, never where (mediaRef/parseMediaRef). Clients don't look inside. */
export type MediaRef = string

/** The longest note the editor takes. Far above anything typed; it bounds what one call can make main store. */
export const NOTE_MAX_CHARS = 10_000

// ---- what comes back ----------------------------------------------------------------------------

export interface AppInfoDto {
  version: string
  contract: number
  /** This computer's name, for "Connected to Jo's MacBook". */
  computer: string
  /** Random, made once per installation: which computer a device is paired with. */
  installationId: string
  /** What this device may do. */
  scopes: Scope[]
  /** True when a note would start an edit; false when no AI editor is connected on the computer. */
  editor: boolean
}

export type ReelStatus = 'planned' | 'new' | 'working' | 'ready' | 'interrupted' | 'failed'

export interface JobDto {
  id: string
  message: string
  /** 0-99, never backwards. */
  overall: number
  secondsLeft: number | null
  /** Waiting for another reel's render (one render at a time). */
  waiting: boolean
}

export interface ReelSummaryDto {
  id: ProjectId
  title: string
  status: ReelStatus
  /** The newest version's number; 0 before Version 1. */
  latest: number
  cover: MediaRef | null
  updatedAt: string
  /** Notes waiting their turn. */
  waiting: number
}

export interface VersionDto {
  n: number
  parent: number | null
  video: MediaRef
  cover: MediaRef | null
  createdAt: string
  /** A draft render (a quick look), not a finished version. */
  draft: boolean
  /** What this version changed, in the version menu's words (shared/versions.ts). */
  change: string
}

export interface ChatLineDto {
  id: string
  from: 'you' | 'editor'
  text: string
  at: string
  version: number | null
  /** Seconds into `version` a "Note here" pointed at. */
  moment: number | null
}

export interface ReelDto extends ReelSummaryDto {
  versions: VersionDto[]
  /** The newest lines of the chat, oldest first. */
  chat: ChatLineDto[]
  job: JobDto | null
  /** Why the last edit failed, in the app's words; null when it didn't. */
  error: string | null
}

export interface NoteArgs {
  /** The page's id for this submission: a retry after a lost reply returns the first answer. */
  requestId: string
  text: string
  /** The version on screen while it was written. */
  version?: number
  /** "Note here": seconds into `version`. Needs `version`. */
  at?: number
}

export interface NoteResult {
  jobId: string | null
  queued: boolean
  /** This request id was seen before; this is the first answer, nothing new ran. */
  replayed: boolean
}

// ---- calls -------------------------------------------------------------------------------------

export class BadRequest extends Error {
  readonly code = 'BAD_REQUEST'
  readonly userMessage = 'Reel Studio did not understand that request. Reload the page and try again.'
}

const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/

export function projectId(v: unknown): ProjectId {
  if (typeof v !== 'string' || v.length > 200 || !SLUG.test(v)) throw new BadRequest('bad reel id')
  return v
}

const version = (v: unknown): number => {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 99_999) throw new BadRequest('bad version')
  return v as number
}

function noteArgs(v: unknown): NoteArgs {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest('note must be an object')
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['requestId', 'text', 'version', 'at'].includes(k)) throw new BadRequest(`unknown note field ${k}`)
  if (typeof o.requestId !== 'string' || !REQUEST_ID.test(o.requestId)) throw new BadRequest('bad request id')
  if (typeof o.text !== 'string' || o.text.length > NOTE_MAX_CHARS || o.text.includes('\0')) throw new BadRequest('bad note text')
  const out: NoteArgs = { requestId: o.requestId, text: o.text }
  if (o.version !== undefined) out.version = version(o.version)
  if (o.at !== undefined) {
    if (out.version === undefined) throw new BadRequest('a moment needs its version')
    if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at < 0 || o.at > 24 * 3600) throw new BadRequest('bad moment')
    out.at = o.at
  }
  return out
}

function jobId(v: unknown): string {
  if (typeof v !== 'string' || !JOB_ID.test(v)) throw new BadRequest('bad job id')
  return v
}

type Check = (args: unknown[]) => unknown[]
const arity = (n: number, args: unknown[]): void => {
  if (args.length !== n) throw new BadRequest(`takes ${n} argument${n === 1 ? '' : 's'}`)
}

/** Every call, the scope it needs, and its argument check. */
export const METHODS = {
  'app.info': { scope: 'view', check: ((a) => (arity(0, a), [])) as Check },
  'projects.list': { scope: 'view', check: ((a) => (arity(0, a), [])) as Check },
  'projects.get': { scope: 'view', check: ((a) => (arity(1, a), [projectId(a[0])])) as Check },
  'projects.note': { scope: 'note', check: ((a) => (arity(2, a), [projectId(a[0]), noteArgs(a[1])])) as Check },
  'jobs.cancel': { scope: 'note', check: ((a) => (arity(2, a), [projectId(a[0]), jobId(a[1])])) as Check }
} as const satisfies Record<string, { scope: Scope; check: Check }>

export type Method = keyof typeof METHODS

export interface Results {
  'app.info': AppInfoDto
  'projects.list': ReelSummaryDto[]
  'projects.get': ReelDto
  'projects.note': NoteResult
  'jobs.cancel': null
}

export const isMethod = (m: unknown): m is Method => typeof m === 'string' && Object.prototype.hasOwnProperty.call(METHODS, m)

/** Checks one call's body ({method, args}); throws BadRequest for anything else. */
export function checkCall(body: unknown): { method: Method; args: unknown[] } {
  if (body === null || typeof body !== 'object') throw new BadRequest('not a call')
  const { method, args } = body as { method?: unknown; args?: unknown }
  if (!isMethod(method)) throw new BadRequest('unknown method')
  if (!Array.isArray(args)) throw new BadRequest('arguments must be a list')
  return { method, args: METHODS[method].check(args) }
}

/** A call's answer. Errors carry the app's own words. */
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: string; userMessage: string } }

// ---- events ------------------------------------------------------------------------------------

/**
 * Pushed over /api/events (Server-Sent Events). There are no sequence numbers: a client opens the stream, waits for
 * `ready`, then reads what it shows, and reads it again after `changed`, after `job` with `done`, and after any
 * reconnect. Reading again is cheap and can't miss a change.
 */
export type ContractEvent =
  | { type: 'ready' }
  | { type: 'job'; project: ProjectId; job: JobDto | null; done: boolean }
  | { type: 'changed'; project: ProjectId | null }
  /** This device was removed on the computer; the page forgets its pairing. */
  | { type: 'revoked' }

// ---- media refs --------------------------------------------------------------------------------

export type MediaKind = 'video' | 'cover' | 'thumb'
const KIND_LETTER: Record<MediaKind, string> = { video: 'v', cover: 'c', thumb: 't' }

/** `v3~my-reel` is version 3's video, `c3~my-reel` its cover, `t~my-reel` the reel's card picture. */
export function mediaRef(kind: MediaKind, project: ProjectId, n?: number): MediaRef {
  if (kind === 'thumb') return `t~${project}`
  if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`${kind} ref needs a version`)
  return `${KIND_LETTER[kind]}${n}~${project}`
}

export function parseMediaRef(ref: string): { kind: MediaKind; project: ProjectId; n: number | null } | null {
  const m = /^([vct])(\d{1,5})?~(.+)$/u.exec(ref)
  if (!m) return null
  const kind: MediaKind = m[1] === 'v' ? 'video' : m[1] === 'c' ? 'cover' : 'thumb'
  if ((kind === 'thumb') !== (m[2] === undefined)) return null
  try {
    return { kind, project: projectId(m[3]), n: m[2] === undefined ? null : Number(m[2]) }
  } catch {
    return null
  }
}

// ---- signing -----------------------------------------------------------------------------------
//
// Pairing puts a 32-byte secret in the QR code's fragment (#p=<pairing id>.<secret>). Browsers never send a
// fragment, so the secret never crosses the network. The page keeps it and signs every request with it; the computer
// keeps the same secret and checks. Each string below starts with its purpose, so a signature made for one kind of
// request can't be replayed as another.

export const SECRET_BYTES = 32
export const PAIRING_ID = /^[0-9a-f]{32}$/
export const DEVICE_ID = /^[0-9a-f]{32}$/
export const NONCE = /^[0-9a-f]{32}$/
/** How far a signed call's time may be from the computer's clock (the page corrects by `now` from /api/time). */
export const CLOCK_SKEW_S = 300
/** The longest a media link may be signed for. Long enough to watch and scrub a reel; the stream outlives it. */
export const MEDIA_MAX_S = 3600

export const pairMessage = (pairing: string, name: string): string => `reel-pair\n${pairing}\n${name}`
export const callMessage = (device: string, time: number, nonce: string, body: string): string =>
  `reel-call\n${device}\n${time}\n${nonce}\n${toHex(sha256(utf8(body)))}`
export const eventsMessage = (device: string, time: number, nonce: string): string => `reel-events\n${device}\n${time}\n${nonce}`
export const mediaMessage = (device: string, ref: MediaRef, expires: number, save: boolean): string =>
  `reel-media\n${device}\n${ref}\n${expires}\n${save ? 1 : 0}`

/** The page's half: hex HMAC-SHA256 of `message` under the device secret. main/companion uses node:crypto. */
export const sign = (secret: Uint8Array, message: string): string => toHex(hmacSha256(secret, utf8(message)))

/** The fragment a pairing link carries. */
export const pairingFragment = (pairing: string, secretHex: string): string => `p=${pairing}.${secretHex}`

export function parsePairingFragment(hash: string): { pairing: string; secret: string } | null {
  const m = /^#?p=([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(hash)
  return m ? { pairing: m[1], secret: m[2] } : null
}

/** Headers a signed call carries. */
export const HEADERS = { device: 'x-reel-device', time: 'x-reel-time', nonce: 'x-reel-nonce', sig: 'x-reel-sig' } as const
