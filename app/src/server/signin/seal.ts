// Sealed values for the sign-in service (docs/signin.md, "Why nothing is stored"). The OAuth state sent to a
// platform and the handoff sent back to the app carry their own data, encrypted and authenticated with AES-256-GCM
// under a key derived from SIGNIN_SECRET, so the service keeps no table of sign-ins in progress.
//
// A sealed value is base64url(iv || ciphertext || tag). The purpose ("state" or "handoff") is bound as additional
// data, so a state can never be redeemed as a handoff or the other way round. Every value carries its own expiry.
// WebCrypto only: the same code runs on Workers, Vercel and Node.

export type Purpose = 'state' | 'handoff'
/** WebCrypto's key type, named without the DOM library (tsconfig.node.json has none). */
export type SealKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** SIGNIN_SECRET as raw bytes: base64url of at least 32 random bytes. Anything shorter is a setup error. */
export function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const raw = fromB64url(secret.trim())
  if (!raw || raw.length < 32) throw new Error('SIGNIN_SECRET must be base64url of at least 32 random bytes')
  return raw
}

export async function sealKey(secret: Uint8Array<ArrayBuffer>): Promise<SealKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('reelstudio-signin-v1'), info: enc.encode('seal') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Seals `value` until `expiresAt` (ms since epoch). */
export async function seal(key: SealKey, purpose: Purpose, value: Record<string, unknown>, expiresAt: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = enc.encode(JSON.stringify({ ...value, exp: expiresAt }))
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, key, body))
  const all = new Uint8Array(iv.length + out.length)
  all.set(iv)
  all.set(out, iv.length)
  return b64url(all)
}

/** The sealed value, or null when it was tampered with, sealed for another purpose or key, or has expired. */
export async function unseal(key: SealKey, purpose: Purpose, sealed: string, now: number): Promise<Record<string, unknown> | null> {
  if (sealed.length > 4096) return null
  const all = fromB64url(sealed)
  if (!all || all.length < 12 + 16) return null
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: enc.encode(purpose) }, key, all.subarray(12))
  } catch {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(dec.decode(plain))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.exp !== 'number' || v.exp <= now) return null
  return v
}

/** base64url(SHA-256(text)), the S256 PKCE challenge. */
export async function s256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))))
}

/** Compares two strings without an early exit on the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
