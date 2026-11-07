// TikTok API v2: https://developers.tiktok.com/doc/tiktok-api-v2-video-query/
// Instagram API v26.0: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights/
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { renameWithRetry } from './store'

export async function atomicSocialFile(file: string, contents: string | Buffer): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, contents, { mode: 0o600, flag: 'wx' })
    await renameWithRetry(temp, file)
  } finally {
    await fs.rm(temp, { force: true })
  }
}

// Both platform services write outcomes.json. Serialize their read-modify-write operations.
const queues = new Map<string, Promise<unknown>>()
export function withSocialFile<T>(file: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(file) ?? Promise.resolve()).then(work, work)
  queues.set(file, result)
  void result.finally(() => { if (queues.get(file) === result) queues.delete(file) }).catch(() => undefined)
  return result
}

/**
 * A connection file's bytes as they are now (null when there is none), for a cancelled sign-in to put back. Taken as
 * bytes, not decrypted, so a connection that can't be read right now is restored as it was rather than lost. A file
 * that exists but can't be read throws, so nothing replaces a connection that couldn't be kept.
 */
export async function snapshotSocialFile(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
    throw e
  }
}

/** Puts back what snapshotSocialFile took: the same bytes, or no file. */
export async function restoreSocialFile(file: string, bytes: Buffer | null): Promise<void> {
  if (bytes) await atomicSocialFile(file, bytes)
  else await fs.rm(file, { force: true })
}
