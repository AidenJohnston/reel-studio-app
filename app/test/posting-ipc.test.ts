// Where posting keeps things on this computer (main/posting-ipc.ts): the sign-in encrypted by the OS where it
// can be, a private plain file where it can't (Linux without a keyring), the stopped posts, which files may be
// posted at all, and that every posting:* channel the page calls is registered.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPendingStore, createSessionStore, finishedVideo, readChunk, registerPostingIpc, sleep, type SecretStore } from '../src/main/posting-ipc'
import { createPostingService, type StoredSession } from '../src/main/posting'

const SESSION: StoredSession = { v: 1, server: 'https://post.test', session: 'ps1_secret_token', sessionId: 's_1', plan: 'monthly', createdAt: 1 }
const dir = () => mkdtempSync(join(tmpdir(), 'rs-posting-'))

/** Reversible "encryption" so a test can tell the file is not the plain JSON. */
function fakeSecrets(o: { available?: boolean; backend?: string } = {}): SecretStore {
  return {
    isEncryptionAvailable: () => o.available ?? true,
    encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
    ...(o.backend ? { getSelectedStorageBackend: () => o.backend! } : {})
  }
}

describe('the sign-in on disk', () => {
  it('is encrypted by the OS keychain (posting-session.bin), and comes back', async () => {
    const d = dir()
    const logs: string[] = []
    const s = createSessionStore(d, fakeSecrets(), (l) => logs.push(l))
    await s.save(SESSION)
    expect(existsSync(join(d, 'posting-session.json'))).toBe(false)
    expect(readFileSync(join(d, 'posting-session.bin')).toString('utf8')).not.toContain('ps1_secret_token')
    expect(await s.load()).toEqual(SESSION)
    await s.clear()
    expect(await s.load()).toBeNull()
    expect(readdirSync(d)).toEqual([])
    expect(logs).toEqual([])
  })

  for (const [why, secrets] of [
    ['no keyring at all', fakeSecrets({ available: false })],
    ["Linux's basic_text, which protects nothing", fakeSecrets({ backend: 'basic_text' })],
    ['no safeStorage', null]
  ] as const)
    it(`${why}: a plain file only this user can read, and one log line`, async () => {
      const d = dir()
      const logs: string[] = []
      const s = createSessionStore(d, secrets, (l) => logs.push(l))
      await s.save(SESSION)
      await s.save(SESSION)
      expect(existsSync(join(d, 'posting-session.bin'))).toBe(false)
      expect(JSON.parse(readFileSync(join(d, 'posting-session.json'), 'utf8'))).toEqual(SESSION)
      if (process.platform !== 'win32') expect(statSync(join(d, 'posting-session.json')).mode & 0o777).toBe(0o600)
      expect(await s.load()).toEqual(SESSION)
      expect(logs).toEqual(['[posting] no safe storage; session kept like the download key'])
      expect(logs.join(' ')).not.toContain('ps1_')
    })

  it('a damaged file counts as signed out', async () => {
    const d = dir()
    writeFileSync(join(d, 'posting-session.bin'), 'garbage')
    const s = createSessionStore(d, { ...fakeSecrets(), decryptString: () => { throw new Error('bad') } }, () => {})
    expect(await s.load()).toBeNull()
  })
})

describe('stopped posts (posting-uploads.json)', () => {
  it('are kept, and the file goes once there are none', async () => {
    const d = dir()
    const f = join(d, 'posting-uploads.json')
    const p = createPendingStore(f)
    expect(await p.load()).toEqual([])
    const e = { uploadId: 'u_1', server: 'https://post.test', slug: 's', version: 2, video: '/v.mp4', size: 10, mtimeMs: 1, startedAt: 1 }
    await p.save([e])
    expect(await p.load()).toEqual([e])
    await p.save([])
    expect(existsSync(f)).toBe(false)
  })
})

describe('which files may be posted', () => {
  it('only an .mp4 really inside Library › Finished videos', async () => {
    const root = dir()
    const exports = join(root, 'Library', 'Finished videos')
    mkdirSync(exports, { recursive: true })
    writeFileSync(join(exports, 'My video - Version 2.mp4'), 'x')
    writeFileSync(join(exports, 'notes.txt'), 'x')
    writeFileSync(join(root, 'elsewhere.mp4'), 'x')
    const ok = finishedVideo(() => exports)
    expect(await ok(join(exports, 'My video - Version 2.mp4'))).toMatch(/My video - Version 2\.mp4$/)
    expect(await ok(join(exports, 'notes.txt'))).toBeNull()
    expect(await ok(join(root, 'elsewhere.mp4'))).toBeNull()
    expect(await ok(join(exports, '..', '..', 'elsewhere.mp4'))).toBeNull()
    expect(await ok(join(exports, 'missing.mp4'))).toBeNull()
    expect(await ok(42 as never)).toBeNull()
    let linked = false
    try {
      symlinkSync(join(root, 'elsewhere.mp4'), join(exports, 'sneaky.mp4'))
      linked = true
    } catch {
      /* Windows without the symlink right */
    }
    if (linked) expect(await ok(join(exports, 'sneaky.mp4'))).toBeNull()
  })
})

describe('readChunk', () => {
  it('reads exactly the asked bytes, and fewer at the end of a file that shrank', async () => {
    const f = join(dir(), 'v.mp4')
    writeFileSync(f, Buffer.from([...Array(1000).keys()].map((i) => i % 256)))
    const c = await readChunk(f, 300, 200)
    expect(c.length).toBe(200)
    expect(c[0]).toBe(300 % 256)
    expect((await readChunk(f, 900, 200)).length).toBe(100)
  })
})

describe('sleep', () => {
  it('stops at once when cancelled', async () => {
    const c = new AbortController()
    const p = sleep(60_000, c.signal)
    c.abort()
    await expect(p).rejects.toThrow('aborted')
    await expect(sleep(10, AbortSignal.abort())).rejects.toThrow('aborted')
    await expect(sleep(1)).resolves.toBeUndefined()
  })
})

describe('IPC', () => {
  it('registers every posting channel the page calls (preload)', () => {
    const channels: string[] = []
    const svc = createPostingService({ enabled: false, baseUrl: 'https://post.test' } as never)
    registerPostingIpc((c) => void channels.push(c), svc)
    const preload = readFileSync(join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8')
    const called = [...preload.matchAll(/call\('(posting:[A-Za-z]+)'/g)].map((m) => m[1])
    expect(called.length).toBeGreaterThan(10)
    expect(channels.sort()).toEqual([...new Set(called)].sort())
  })

  it('index.ts wires posting with the download key and the OS keychain', () => {
    const index = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const call = /setupPosting\(\{[\s\S]*?\n {2}\}\)/.exec(index)?.[0] ?? ''
    expect(call).toContain('getKey: () => updateKey.get()')
    expect(call).toContain('secrets: safeStorage')
  })
})
