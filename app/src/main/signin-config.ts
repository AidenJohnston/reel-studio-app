// Which platforms the app can connect, from Reel Studio's sign-in service (docs/signin.md): its GET /v1/platforms
// names each platform's public app id and where its approval stands. The app holds no platform ids of its own, so a
// new app or an approval changes nothing here. A developer can still point a platform at their own app
// (REELSTUDIO_DEV=1 and the saved instagram*/tiktok* settings, docs/instagram.md and docs/tiktok.md).
//
// This file never imports electron: index.ts wires it, tests drive it with a fake fetch.
import type { InstagramSettings } from '../shared/instagram'
import type { TikTokSettings } from '../shared/tiktok'
import type { FacebookSettings } from './facebook'
import type { PlatformAvailability, SigninPlatformId } from '../shared/social'

export interface SigninPlatforms {
  instagram?: { clientId: string; review: 'testers' | 'approved'; mediaOrigins: string[] }
  facebook?: { clientId: string; review: 'testers' | 'approved' }
  tiktok?: { clientKey: string; audited: boolean; directPost: boolean }
}

export type Directory = { reached: true; platforms: SigninPlatforms } | { reached: false }

/** REELSTUDIO_SIGNIN_URL moves the app to another sign-in service: https, or http on this computer. */
export function signinUrl(env: Record<string, string | undefined>, fallback: string, log: (line: string) => void): string {
  const raw = env.REELSTUDIO_SIGNIN_URL?.trim()
  if (!raw) return fallback
  try {
    const u = new URL(raw)
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if ((u.protocol === 'https:' || (u.protocol === 'http:' && local)) && u.pathname === '/' && !u.search && !u.hash && !u.username) return u.origin
  } catch {
    /* logged below */
  }
  log('[signin] REELSTUDIO_SIGNIN_URL is not a usable address; using the built-in one')
  return fallback
}

const OK_MS = 10 * 60_000
const FAIL_MS = 30_000

const isId = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v)

/** The service's answer, read strictly: a platform with anything unexpected counts as not offered. */
export function readPlatforms(value: unknown): SigninPlatforms {
  const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const p = root.v === 1 && root.platforms && typeof root.platforms === 'object' ? (root.platforms as Record<string, Record<string, unknown> | undefined>) : {}
  const out: SigninPlatforms = {}
  const review = (v: unknown) => (v === 'approved' ? 'approved' : v === 'testers' ? 'testers' : null)
  const ig = p.instagram
  if (ig && isId(ig.clientId, /^\d{1,32}$/) && review(ig.review) && Array.isArray(ig.mediaOrigins) &&
      ig.mediaOrigins.length > 0 && ig.mediaOrigins.every((o) => typeof o === 'string' && /^https:\/\/[^/?#]+$/.test(o)))
    out.instagram = { clientId: ig.clientId, review: review(ig.review)!, mediaOrigins: ig.mediaOrigins as string[] }
  const fb = p.facebook
  if (fb && isId(fb.clientId, /^\d{1,32}$/) && review(fb.review)) out.facebook = { clientId: fb.clientId, review: review(fb.review)! }
  const tt = p.tiktok
  if (tt && isId(tt.clientKey, /^[A-Za-z0-9_-]{1,128}$/) && typeof tt.audited === 'boolean' && typeof tt.directPost === 'boolean')
    out.tiktok = { clientKey: tt.clientKey, audited: tt.audited, directPost: tt.directPost }
  return out
}

export class SigninDirectory {
  private cached: { at: number; value: Directory } | null = null
  private inflight: Promise<Directory> | null = null

  constructor(
    private readonly o: {
      baseUrl: string
      fetch: (url: string, init: RequestInit) => Promise<Response>
      now(): number
      log(line: string): void
    }
  ) {}

  get baseUrl(): string {
    return this.o.baseUrl
  }

  /** The service's list, asked again after 10 minutes (30 s after it couldn't be reached), or now with `fresh`. */
  async get(fresh = false): Promise<Directory> {
    const c = this.cached
    if (!fresh && c && this.o.now() - c.at < (c.value.reached ? OK_MS : FAIL_MS)) return c.value
    this.inflight ??= this.ask().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async ask(): Promise<Directory> {
    let value: Directory
    try {
      const res = await this.o.fetch(`${this.o.baseUrl}/v1/platforms`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`status ${res.status}`)
      value = { reached: true, platforms: readPlatforms(await res.json()) }
    } catch (e) {
      this.o.log(`[signin] the sign-in service could not be reached (${e instanceof Error ? e.message : 'unknown'})`)
      value = { reached: false }
    }
    this.cached = { at: this.o.now(), value }
    return value
  }
}

/** What Instagram's service sees: the platform as the service offers it, or off. */
export function instagramFrom(d: Directory, baseUrl: string): InstagramSettings {
  const ig = d.reached ? d.platforms.instagram : undefined
  return { instagramEnabled: !!ig, instagramAppId: ig?.clientId ?? null, instagramBrokerUrl: ig ? baseUrl : null, instagramUploadOrigins: ig?.mediaOrigins ?? [] }
}

export function facebookFrom(d: Directory, baseUrl: string): FacebookSettings {
  const fb = d.reached ? d.platforms.facebook : undefined
  return { appId: fb?.clientId ?? null, brokerUrl: fb ? baseUrl : null }
}

export function tiktokFrom(d: Directory, baseUrl: string): TikTokSettings {
  const tt = d.reached ? d.platforms.tiktok : undefined
  return { tiktokEnabled: !!tt, tiktokClientKey: tt?.clientKey ?? null, tiktokBrokerUrl: tt ? baseUrl : null, tiktokAudited: tt?.audited ?? false, tiktokDirectPost: tt?.directPost ?? false }
}

/** For Settings › Posting and Share: can this platform be connected, and if not, why, in a word the screen turns into a line. */
export function availability(d: Directory, id: SigninPlatformId, own: boolean): PlatformAvailability {
  if (own) return { open: true, review: 'own' }
  if (!d.reached) return { open: false, why: 'unreachable' }
  const p = d.platforms[id]
  if (!p) return { open: false, why: 'not_set_up' }
  if (id === 'tiktok') return { open: true, review: (p as NonNullable<SigninPlatforms['tiktok']>).audited ? 'approved' : 'private_only' }
  return { open: true, review: (p as { review: 'testers' | 'approved' }).review }
}
