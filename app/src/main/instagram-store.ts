// TikTok API v2: https://developers.tiktok.com/doc/tiktok-api-v2-video-query/
// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// safeStorage (Electron 44): https://www.electronjs.org/docs/latest/api/safe-storage
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicSocialFile, withSocialFile } from './social-store'
import { id, InstagramError, object, positive, text } from './instagram-http'
import type { InstagramOutcome, InstagramPost, InstagramTrial } from '../shared/instagram'

export interface InstagramSecretStore {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface InstagramCredentials {
  accessToken: string
  expiresAt: number
  issuedAt: number
  accountId: string
  username: string
  /** The profile picture as a data URL (instagram.ts picture). Connections made before it was saved have none. */
  picture?: string
  appId: string
  brokerUrl: string
  /** The sign-in service's pass for storage links (docs/signin.md), sealed to this account at sign-in. */
  uploadPass?: string
}

const PICTURE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
/** A saved profile picture: a data URL of a few hundred kilobytes at most (instagram.ts PICTURE_MAX_BYTES). */
function picture(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_000_000 || !PICTURE.test(value)) return localDataError()
  return value
}

export type PublishReceipt =
  | { state: 'processing'; accountId: string; containerId: string; inputHash: string }
  | { state: 'publishing'; accountId: string; containerId: string; inputHash: string }
  | { state: 'published'; accountId: string; containerId: string; inputHash: string; post: InstagramPost }

export function localDataError(): never {
  throw new InstagramError('IG_LOCAL_DATA', 'The saved Instagram data could not be read. Restore the file before trying again.')
}

export async function readObject(file: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
    return localDataError()
  }
  try { return object(JSON.parse(raw)) } catch { return localDataError() }
}

export class InstagramTokenStore {
  constructor(private readonly dir: string, private readonly secrets: InstagramSecretStore) {}
  private file(): string { return join(this.dir, 'instagram-credentials.bin') }
  private secure(): void {
    if (!this.secrets.isEncryptionAvailable() || this.secrets.getSelectedStorageBackend?.() === 'basic_text')
      throw new InstagramError('IG_SECURE_STORAGE', 'This computer cannot store the Instagram connection securely. Enable its system keychain and try again.')
  }
  async load(): Promise<InstagramCredentials | null> {
    let bytes: Buffer
    try { bytes = await fs.readFile(this.file()) } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
      return localDataError()
    }
    this.secure()
    try {
      const c = object(JSON.parse(this.secrets.decryptString(bytes)))
      return {
        accessToken: text(c.accessToken), expiresAt: positive(c.expiresAt), issuedAt: positive(c.issuedAt),
        accountId: id(c.accountId), username: text(c.username), ...(c.picture === undefined ? {} : { picture: picture(c.picture) }),
        appId: id(c.appId), brokerUrl: text(c.brokerUrl), ...(c.uploadPass === undefined ? {} : { uploadPass: text(c.uploadPass) })
      }
    } catch { return localDataError() }
  }
  async save(c: InstagramCredentials): Promise<void> {
    this.secure()
    const encrypted = this.secrets.encryptString(JSON.stringify(c))
    await fs.mkdir(this.dir, { recursive: true })
    await atomicSocialFile(this.file(), encrypted)
  }
  async clear(): Promise<void> { await fs.rm(this.file(), { force: true }) }
  assertSecure(): void { this.secure() }
}

function post(value: unknown): InstagramPost {
  const p = object(value)
  if (typeof p.version !== 'number' || !Number.isSafeInteger(p.version) || p.version < 1) return localDataError()
  const publishedAt = text(p.publishedAt)
  if (!Number.isFinite(Date.parse(publishedAt))) return localDataError()
  if (p.trial === undefined) return { version: p.version, accountId: id(p.accountId), postId: id(p.postId), publishedAt }
  const t = object(p.trial)
  const g = t.graduation
  if (g !== 'MANUAL' && g !== 'SS_PERFORMANCE') return localDataError()
  if ((t.try !== undefined && t.try !== 1 && t.try !== 2) || (t.group !== undefined && typeof t.group !== 'string')) return localDataError()
  const trial: InstagramTrial = { graduation: g as InstagramTrial['graduation'], ...(t.try ? { try: t.try as 1 | 2 } : {}), ...(typeof t.group === 'string' ? { group: t.group } : {}) }
  return { version: p.version, accountId: id(p.accountId), postId: id(p.postId), publishedAt, trial }
}

/** Where a version's post is kept: `v3`, or `v3-try2` for a Try 2 file posted as a trial reel. */
export const receiptSlot = (version: number, tryN?: 1 | 2): string => (tryN ? `v${version}-try${tryN}` : `v${version}`)

export async function receipt(dir: string, version: number, tryN?: 1 | 2): Promise<PublishReceipt | null> {
  const saved = await readObject(join(dir, 'instagram-publish.json'))
  if (!saved) return null
  if (saved.schemaVersion !== 1) return localDataError()
  const versions = object(saved.versions)
  const value = versions[receiptSlot(version, tryN)]
  if (value === undefined) return null
  const r = object(value)
  const inputHash = text(r.inputHash)
  if (!/^[a-f0-9]{64}$/.test(inputHash)) return localDataError()
  const base = { accountId: id(r.accountId), containerId: id(r.containerId), inputHash }
  if (r.state === 'processing' || r.state === 'publishing') return { ...base, state: r.state }
  if (r.state === 'published') {
    const p = post(r.post)
    if (p.version !== version || p.accountId !== base.accountId) return localDataError()
    return { ...base, state: r.state, post: p }
  }
  return localDataError()
}

export async function saveReceipt(dir: string, version: number, value: PublishReceipt, tryN?: 1 | 2): Promise<void> {
  const file = join(dir, 'instagram-publish.json')
  const saved = await readObject(file)
  if (saved && saved.schemaVersion !== 1) return localDataError()
  const versions = saved ? object(saved.versions) : {}
  await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: { ...versions, [receiptSlot(version, tryN)]: value } }, null, 2) + '\n')
}

export async function saveOutcome(dir: string, value: InstagramOutcome): Promise<void> {
  const file = join(dir, 'outcomes.json')
  return withSocialFile(file, async () => {
    const saved = await readObject(file)
    if (saved && saved.schemaVersion !== 1) return localDataError()
    const versions = saved ? object(saved.versions) : {}
    const key = `v${value.version}`
    const posts = versions[key] === undefined ? {} : object(versions[key])
    await atomicSocialFile(file, JSON.stringify({ ...saved, schemaVersion: 1, versions: { ...versions, [key]: { ...posts, [value.postId]: value } } }, null, 2) + '\n')
  })
}
