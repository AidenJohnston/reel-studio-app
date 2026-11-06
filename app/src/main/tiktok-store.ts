// TikTok OAuth v2: https://developers.tiktok.com/doc/oauth-user-access-token-management/
// Upload/status v2: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status/
// safeStorage, Electron 44: https://www.electronjs.org/docs/latest/api/safe-storage
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { keptTag, type InstagramSecretStore } from './instagram-store'
import type { TikTokOutcome, TikTokPublishResult } from '../shared/tiktok'
import { atomicSocialFile, withSocialFile } from './social-store'
import { count, fail, httpsUrl, invalid, object, positive, text } from './tiktok-http'

export interface TikTokCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshExpiresAt: number
  accountId: string
  displayName: string
  scopes: string[]
  clientKey: string
  brokerUrl: string
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid()
  return value.map(text)
}
export function localError(): never { return fail('TT_LOCAL_DATA', 'Saved TikTok data could not be read. Restore the file before trying again.') }
export async function readObject(file: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
    return localError()
  }
  try { return object(JSON.parse(raw)) } catch { return localError() }
}
export class TikTokTokenStore {
  constructor(private readonly dir: string, private readonly secrets: InstagramSecretStore) {}
  private file(): string { return join(this.dir, 'tiktok-credentials.bin') }
  assertSecure(): void {
    if (!this.secrets.isEncryptionAvailable() || this.secrets.getSelectedStorageBackend?.() === 'basic_text')
      fail('TT_SECURE_STORAGE', 'This computer cannot store TikTok securely. Enable its system keychain and try again.')
  }
  async load(): Promise<TikTokCredentials | null> {
    let bytes: Buffer
    try { bytes = await fs.readFile(this.file()) } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
      return localError()
    }
    this.assertSecure()
    try {
      const c = object(JSON.parse(this.secrets.decryptString(bytes)))
      return { accessToken: text(c.accessToken), refreshToken: text(c.refreshToken), expiresAt: positive(c.expiresAt),
        refreshExpiresAt: positive(c.refreshExpiresAt), accountId: text(c.accountId), displayName: text(c.displayName),
        scopes: strings(c.scopes), clientKey: text(c.clientKey), brokerUrl: text(c.brokerUrl) }
    } catch { return localError() }
  }
  async save(c: TikTokCredentials): Promise<void> {
    this.assertSecure()
    const encrypted = this.secrets.encryptString(JSON.stringify(c))
    await fs.mkdir(this.dir, { recursive: true })
    await atomicSocialFile(this.file(), encrypted)
  }
  async clear(): Promise<void> { await fs.rm(this.file(), { force: true }) }
}
interface ReceiptBase { accountId: string; inputHash: string }
export type TikTokReceipt = ReceiptBase & (
  | { state: 'initializing' }
  | { state: 'upload'; publishId: string; uploadUrl: string; size: number; chunkSize: number; chunkCount: number;
      offset: number; expiresAt: number; mode: 'direct' | 'inbox'; privateOnly: boolean }
  | { state: 'complete'; result: TikTokPublishResult; publishedAt: string | null }
)
export function uploadUrl(value: unknown): string {
  const url = httpsUrl(value)
  if (url.port || !(url.hostname === 'open-upload.tiktokapis.com' || /^upload(?:\.[a-z]{2})?\.tiktokapis\.com$/.test(url.hostname)))
    return fail('TT_UPLOAD_HOST', 'TikTok returned an unapproved upload address. No video was sent.')
  return url.toString()
}
export async function receipt(dir: string, version: number): Promise<TikTokReceipt | null> {
  const saved = await readObject(join(dir, 'tiktok-publish.json'))
  if (!saved) return null
  try {
    if (saved.schemaVersion !== 1) return localError()
    const value = object(saved.versions)[`v${version}`]
    if (value === undefined) return null
    const r = object(value)
    const base = { accountId: text(r.accountId), inputHash: text(r.inputHash) }
    if (!/^[a-f0-9]{64}$/.test(base.inputHash)) return localError()
    if (r.state === 'initializing') return { ...base, state: r.state }
    if (r.state === 'upload' && (r.mode === 'direct' || r.mode === 'inbox') && typeof r.privateOnly === 'boolean') {
      const size = positive(r.size), chunkSize = positive(r.chunkSize), chunkCount = positive(r.chunkCount), offset = count(r.offset)
      if (offset > size || chunkCount !== Math.max(1, Math.floor(size / chunkSize)) || chunkSize > size) return localError()
      return { ...base, state: 'upload', mode: r.mode, privateOnly: r.privateOnly, size, chunkSize, chunkCount, offset,
        publishId: text(r.publishId), uploadUrl: uploadUrl(r.uploadUrl), expiresAt: positive(r.expiresAt) }
    }
    if (r.state === 'complete') {
      const v = object(r.result)
      if ((v.state !== 'published' && v.state !== 'inbox') || (v.mode !== 'direct' && v.mode !== 'inbox') || typeof v.privateOnly !== 'boolean') return localError()
      if (r.publishedAt !== null && (typeof r.publishedAt !== 'string' || !Number.isFinite(Date.parse(r.publishedAt)))) return localError()
      return { ...base, state: 'complete', publishedAt: r.publishedAt, result: { state: v.state, mode: v.mode, privateOnly: v.privateOnly,
        publishId: text(v.publishId), postIds: strings(v.postIds), message: text(v.message) } }
    }
  } catch { return localError() }
  return localError()
}
export async function saveReceipt(dir: string, version: number, value: TikTokReceipt): Promise<void> {
  const file = join(dir, 'tiktok-publish.json')
  const saved = await readObject(file)
  if (saved && saved.schemaVersion !== 1) return localError()
  const versions = saved ? object(saved.versions) : {}
  await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions: { ...versions, [`v${version}`]: value } }, null, 2) + '\n')
}
export async function saveOutcome(dir: string, value: TikTokOutcome, preserve = false): Promise<void> {
  const file = join(dir, 'outcomes.json')
  return withSocialFile(file, async () => {
    const saved = await readObject(file)
    if (saved && saved.schemaVersion !== 1) return localError()
    const versions = saved ? object(saved.versions) : {}
    const key = `v${value.version}`
    const posts = versions[key] === undefined ? {} : object(versions[key])
    // IDs are platform-local. A TikTok ID must never overwrite an Instagram post with the same ID.
    const postKey = `tiktok:${value.postId}`
    if (preserve && posts[postKey] !== undefined) return
    const before = posts[postKey] === undefined ? {} : object(posts[postKey])
    await atomicSocialFile(file, JSON.stringify({ ...saved, schemaVersion: 1,
      versions: { ...versions, [key]: { ...posts, [postKey]: { ...keptTag(before), ...value } } } }, null, 2) + '\n')
  })
}

export async function clearReceipt(dir: string, version: number): Promise<void> {
  const file = join(dir, 'tiktok-publish.json'), saved = await readObject(file)
  if (!saved || saved.schemaVersion !== 1) return localError()
  const versions = object(saved.versions)
  delete versions[`v${version}`]
  await atomicSocialFile(file, JSON.stringify({ schemaVersion: 1, versions }, null, 2) + '\n')
}
