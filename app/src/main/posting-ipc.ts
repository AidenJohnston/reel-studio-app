// The main-process side of posting (main/posting.ts): where this computer's sign-in and the stopped posts are kept,
// which files may be posted, and the posting:* IPC channels. Electron's pieces (safeStorage, shell) come in from
// index.ts, so this file is tested without Electron (test/posting-ipc.test.ts).
import { promises as fs, realpathSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { POSTING_URL } from '../shared/config'
import { createPostingService, postingConfig, type PendingEntry, type PostingService, type StoredSession } from './posting'
import { renameWithRetry } from './store'

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void

/** Electron's safeStorage, or a fake in tests. */
export interface SecretStore {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
  getSelectedStorageBackend?(): string
}

async function writePrivate(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  await renameWithRetry(tmp, file)
}

/**
 * This computer's posting sign-in: posting-session.bin, encrypted by the OS keychain. Where there is none (Linux
 * without a keyring, where Electron's 'basic_text' protects nothing) it is kept as posting-session.json, readable
 * only by this user: no weaker than the download key it was traded for, which sits in settings.json.
 */
export function createSessionStore(dir: string, secrets: SecretStore | null, log: (line: string) => void) {
  const enc = join(dir, 'posting-session.bin')
  const plain = join(dir, 'posting-session.json')
  let warned = false
  const safe = (): boolean => !!secrets && secrets.isEncryptionAvailable() && secrets.getSelectedStorageBackend?.() !== 'basic_text'
  return {
    async load(): Promise<StoredSession | null> {
      try {
        if (secrets && safe()) {
          const b = await fs.readFile(enc).catch(() => null)
          if (b) return JSON.parse(secrets.decryptString(b))
        }
        return JSON.parse(await fs.readFile(plain, 'utf8'))
      } catch {
        return null
      }
    },
    async save(s: StoredSession): Promise<void> {
      await fs.mkdir(dir, { recursive: true })
      if (secrets && safe()) {
        await writePrivate(enc, secrets.encryptString(JSON.stringify(s)))
        await fs.rm(plain, { force: true })
        return
      }
      if (!warned) log('[posting] no safe storage; session kept like the download key')
      warned = true
      await writePrivate(plain, JSON.stringify(s))
      await fs.rm(enc, { force: true })
    },
    async clear(): Promise<void> {
      await fs.rm(enc, { force: true })
      await fs.rm(plain, { force: true })
    }
  }
}

/** Posts that stopped part way (posting-uploads.json): which file, which upload, nothing about the video's words. */
export function createPendingStore(file: string) {
  return {
    async load(): Promise<PendingEntry[]> {
      try {
        const l = JSON.parse(await fs.readFile(file, 'utf8'))
        return Array.isArray(l) ? l : []
      } catch {
        return []
      }
    },
    async save(list: PendingEntry[]): Promise<void> {
      if (!list.length) {
        await fs.rm(file, { force: true })
        return
      }
      await writePrivate(file, JSON.stringify(list, null, 2) + '\n')
    }
  }
}

/** Only an .mp4 that really sits in Library › Finished videos (symlinks resolved): the real path, or null. */
export function finishedVideo(exportsDir: () => string) {
  return async (p: string): Promise<string | null> => {
    if (typeof p !== 'string' || extname(p).toLowerCase() !== '.mp4') return null
    try {
      const real = realpathSync.native(resolve(p))
      const root = realpathSync.native(resolve(exportsDir()))
      return real.startsWith(root.endsWith(sep) ? root : root + sep) ? real : null
    } catch {
      return null
    }
  }
}

export async function readChunk(file: string, start: number, length: number): Promise<Uint8Array> {
  const fh = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, start + got)
      if (!bytesRead) break
      got += bytesRead
    }
    return got === length ? buf : buf.subarray(0, got)
  } finally {
    await fh.close()
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, stop) => {
    if (signal?.aborted) return stop(new Error('aborted'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      done()
    }, ms)
    const abort = (): void => {
      clearTimeout(t)
      stop(new Error('aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function registerPostingIpc(handle: Handle, svc: PostingService): void {
  handle('posting:status', () => svc.status())
  handle('posting:signIn', () => svc.signIn())
  handle('posting:signOut', () => svc.signOut())
  handle('posting:signOutEverywhere', () => svc.signOutEverywhere())
  handle('posting:connect', (_e, platform: unknown) => svc.connect(platform))
  handle('posting:reopenConnect', () => svc.reopenConnect())
  handle('posting:cancelConnect', () => svc.cancelConnect())
  handle('posting:disconnect', (_e, platform: unknown) => svc.disconnect(platform))
  handle('posting:post', (_e, req: unknown) => svc.post(req as never))
  handle('posting:cancel', () => svc.cancel())
  handle('posting:current', () => svc.current())
  handle('posting:pending', (_e, slug: unknown, version: unknown) => svc.pending(slug, version))
  handle('posting:resume', (_e, uploadId: unknown) => svc.resume(uploadId))
  handle('posting:discard', (_e, uploadId: unknown) => svc.discard(uploadId))
  handle('posting:openLink', (_e, url: unknown) => svc.openLink(url))
}

/** Everything index.ts needs: the service, wired to this computer, with its IPC registered. */
export function setupPosting(o: {
  handle: Handle
  env: Record<string, string | undefined>
  settingsDir: string
  exportsDir: () => string
  secrets: SecretStore | null
  appVersion: string
  getKey(): Promise<string | null>
  openExternal(url: string): Promise<void>
  send(channel: string, v: unknown): void
  log(line: string): void
}): PostingService {
  const cfg = postingConfig(o.env, POSTING_URL, o.log)
  if (cfg.enabled) o.log(`[posting] on, server ${cfg.baseUrl}`)
  const store = createSessionStore(o.settingsDir, o.secrets, o.log)
  const pending = createPendingStore(join(o.settingsDir, 'posting-uploads.json'))
  const svc = createPostingService({
    ...cfg,
    appVersion: o.appVersion,
    platform: process.platform,
    fetch: (url, init) => fetch(url, init), // Node's fetch: no Electron session, so no cookies
    now: () => Date.now(),
    sleep,
    getKey: o.getKey,
    loadSession: () => store.load(),
    saveSession: (s) => store.save(s),
    clearSession: () => store.clear(),
    loadPending: () => pending.load(),
    savePending: (l) => pending.save(l),
    readChunk,
    statFile: async (f) => {
      const st = await fs.stat(f).catch(() => null)
      return st?.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    },
    isFinishedVideo: finishedVideo(o.exportsDir),
    openExternal: o.openExternal,
    log: o.log,
    send: o.send
  })
  registerPostingIpc(o.handle, svc)
  return svc
}
