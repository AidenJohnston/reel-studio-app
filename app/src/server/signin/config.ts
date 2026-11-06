// The sign-in service's settings, read once from its environment (docs/signin.md, "Settings"). A platform is on when
// both its id and secret are set; one without the other is a setup mistake and stops the service from starting,
// rather than quietly leaving the platform off.
import { secretBytes } from './seal.ts'

export type Review = 'testers' | 'approved'

export interface MetaApp {
  appId: string
  appSecret: string
  /** "testers" until Meta approves the app: only people added to the app in Meta's dashboard can connect. */
  review: Review
}

export interface SigninConfig {
  /** This service's own origin, where each platform sends people back (https, or http on this computer for local runs). */
  publicUrl: string
  secret: Uint8Array<ArrayBuffer>
  instagram?: MetaApp
  facebook?: MetaApp
  threads?: MetaApp
  tiktok?: { clientKey: string; clientSecret: string; audited: boolean; directPost: boolean }
  /** S3-compatible storage for the temporary copy Instagram fetches by URL. Without it Instagram stays off. */
  media?: { bucketUrl: string; region: string; accessKeyId: string; secretAccessKey: string }
  fetch: (url: string, init: RequestInit) => Promise<Response>
  now(): number
}

type Env = Record<string, string | undefined>

const get = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim()
  return v ? v : undefined
}

function pair(env: Env, idName: string, secretName: string): [string, string] | undefined {
  const id = get(env, idName)
  const secret = get(env, secretName)
  if (!id && !secret) return undefined
  if (!id || !secret) throw new Error(`Set both ${idName} and ${secretName}, or neither`)
  return [id, secret]
}

function review(env: Env, name: string): Review {
  const v = get(env, name) ?? 'testers'
  if (v !== 'testers' && v !== 'approved') throw new Error(`${name} must be "testers" or "approved"`)
  return v
}

function flag(env: Env, name: string): boolean {
  const v = get(env, name) ?? '0'
  if (v !== '0' && v !== '1') throw new Error(`${name} must be 0 or 1`)
  return v === '1'
}

export function publicOrigin(raw: string): string {
  const u = new URL(raw)
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.pathname !== '/' || u.search || u.hash || u.username)
    throw new Error('SIGNIN_PUBLIC_URL must be an https origin with no path (http only on this computer)')
  return u.origin
}

export function configFromEnv(env: Env, fetcher: SigninConfig['fetch'], now: () => number = Date.now): SigninConfig {
  const url = get(env, 'SIGNIN_PUBLIC_URL')
  if (!url) throw new Error('Set SIGNIN_PUBLIC_URL')
  const secret = get(env, 'SIGNIN_SECRET')
  if (!secret) throw new Error('Set SIGNIN_SECRET')
  const ig = pair(env, 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET')
  const fb = pair(env, 'FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET')
  const th = pair(env, 'THREADS_APP_ID', 'THREADS_APP_SECRET')
  const tt = pair(env, 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET')
  const bucket = get(env, 'MEDIA_BUCKET_URL')
  const keys = pair(env, 'MEDIA_ACCESS_KEY_ID', 'MEDIA_SECRET_ACCESS_KEY')
  if (!!bucket !== !!keys) throw new Error('Set MEDIA_BUCKET_URL with MEDIA_ACCESS_KEY_ID and MEDIA_SECRET_ACCESS_KEY, or none of them')
  if (ig && !bucket) throw new Error('Instagram needs MEDIA_BUCKET_URL: Instagram fetches the video from a link')
  if (th && !bucket) throw new Error('Threads needs MEDIA_BUCKET_URL: Threads fetches the video from a link')
  if (bucket && !/^https:\/\/[^/?#]+\/[^/?#]+$/.test(bucket)) throw new Error('MEDIA_BUCKET_URL must be https://<host>/<bucket>')
  for (const [name, id] of [['INSTAGRAM_APP_ID', ig?.[0]], ['FACEBOOK_APP_ID', fb?.[0]], ['THREADS_APP_ID', th?.[0]]] as const)
    if (id && !/^\d{1,32}$/.test(id)) throw new Error(`${name} must be the numeric app ID`)
  if (tt && !/^[A-Za-z0-9_-]{1,128}$/.test(tt[0])) throw new Error('TIKTOK_CLIENT_KEY has unexpected characters')
  return {
    publicUrl: publicOrigin(url),
    secret: secretBytes(secret),
    ...(ig ? { instagram: { appId: ig[0], appSecret: ig[1], review: review(env, 'INSTAGRAM_REVIEW') } } : {}),
    ...(fb ? { facebook: { appId: fb[0], appSecret: fb[1], review: review(env, 'FACEBOOK_REVIEW') } } : {}),
    ...(th ? { threads: { appId: th[0], appSecret: th[1], review: review(env, 'THREADS_REVIEW') } } : {}),
    ...(tt ? { tiktok: { clientKey: tt[0], clientSecret: tt[1], audited: flag(env, 'TIKTOK_AUDITED'), directPost: flag(env, 'TIKTOK_DIRECT_POST') } } : {}),
    ...(bucket && keys ? { media: { bucketUrl: bucket, region: get(env, 'MEDIA_REGION') ?? 'auto', accessKeyId: keys[0], secretAccessKey: keys[1] } } : {}),
    fetch: fetcher,
    now
  }
}
