// Getting OpenAI's Codex app for "Sign in with ChatGPT" (main/codex-fetch.ts). No network: fetch answers from memory,
// and the unpack is a stand-in that writes the package's layout, so these run the same on every system.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, promises as fs, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexBinIn, CodexFetchError, ensureCodex, FETCH_MESSAGES, installedCodex, type CodexPackage } from '../src/main/codex-fetch'

// the package layout of the system running the test (bin\\codex.exe or bin/codex), so its paths are real ones
const PLATFORM: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'darwin'

const BYTES = Buffer.from('a stand-in for the codex package archive '.repeat(400))
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const PKG: CodexPackage = { asset: 'test.tar.gz', url: 'https://example.test/codex.tar.gz', sha256: sha(BYTES), bytes: BYTES.length }

function serve(body: Buffer, opts: { failAt?: number; onChunk?: (n: number) => void } = {}) {
  let calls = 0
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    calls++
    const signal = init?.signal
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (signal?.aborted) return c.error(new Error('aborted'))
        if (opts.failAt !== undefined && sent >= opts.failAt) return c.error(new Error('socket hang up'))
        const chunk = body.subarray(sent, sent + 1024)
        sent += chunk.length
        opts.onChunk?.(sent)
        if (chunk.length) c.enqueue(new Uint8Array(chunk))
        else c.close()
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } })
  }) as unknown as typeof globalThis.fetch
  return { fetch: fakeFetch, calls: () => calls }
}

/** The package's layout (install.ps1 / install.sh: bin/codex) written where tar would unpack it. */
const fakeExtract = (log: string[] = []) => async (archive: string, dest: string): Promise<void> => {
  log.push(archive)
  await fs.mkdir(join(dest, 'bin'), { recursive: true })
  await fs.writeFile(codexBinIn(dest, PLATFORM), 'MZ')
}

const place = () => ({ dir: join(mkdtempSync(join(tmpdir(), 'codex-')), 'codex'), platform: PLATFORM, arch: 'x64', pkg: PKG, freeBytes: async () => 10e9 })

describe('getting the Codex app', () => {
  it('fails if a download that is not byte for byte the pinned package is unpacked, or leaves files behind', async () => {
    const d = place()
    const unpacked: string[] = []
    const tampered = Buffer.from(BYTES)
    tampered[10] ^= 1
    const err = await ensureCodex({ ...d, fetch: serve(tampered).fetch, extract: fakeExtract(unpacked) }, new AbortController().signal).catch((e) => e)
    expect(err).toBeInstanceOf(CodexFetchError)
    expect(err.problem).toBe('bad_download')
    expect(err.message).toBe(FETCH_MESSAGES.bad_download)
    expect(unpacked).toEqual([])
    expect(readdirSync(d.dir)).toEqual([])
    expect(installedCodex(d)).toBeNull()
  })

  it('fails if a good download is not kept for the next sign-in, which must not download again', async () => {
    const d = place()
    const net = serve(BYTES)
    const pcts: number[] = []
    const bin = await ensureCodex({ ...d, fetch: net.fetch, extract: fakeExtract() }, new AbortController().signal, (p) => pcts.push(p))
    expect(existsSync(bin)).toBe(true)
    expect(bin.endsWith(join('bin', PLATFORM === 'win32' ? 'codex.exe' : 'codex'))).toBe(true)
    expect(pcts.at(-1)).toBe(100)
    // only the release folder stays: no archive, no staging folder
    expect(readdirSync(d.dir)).toHaveLength(1)
    expect(installedCodex(d)).toBe(bin)
    expect(await ensureCodex({ ...d, fetch: net.fetch, extract: fakeExtract() }, new AbortController().signal)).toBe(bin)
    expect(net.calls()).toBe(1)
  })

  it('fails if Cancel in the middle of the download leaves a partial file or reports anything but cancelled', async () => {
    const d = place()
    const stop = new AbortController()
    const net = serve(BYTES, { onChunk: (n) => n > 4096 && stop.abort() })
    const err = await ensureCodex({ ...d, fetch: net.fetch, extract: fakeExtract() }, stop.signal).catch((e) => e)
    expect(err.problem).toBe('cancelled')
    expect(readdirSync(d.dir)).toEqual([])
  })

  it('fails if a dropped connection or a nearly full disk does not say what to do in one sentence', async () => {
    const d = place()
    const dropped = await ensureCodex({ ...d, fetch: serve(BYTES, { failAt: 2048 }).fetch, extract: fakeExtract() }, new AbortController().signal).catch((e) => e)
    expect([dropped.problem, dropped.message]).toEqual(['offline', FETCH_MESSAGES.offline])
    expect(readdirSync(d.dir)).toEqual([])
    const net = serve(BYTES)
    const full = await ensureCodex({ ...d, freeBytes: async () => BYTES.length * 2, fetch: net.fetch, extract: fakeExtract() }, new AbortController().signal).catch((e) => e)
    expect([full.problem, full.message]).toEqual(['disk', FETCH_MESSAGES.disk])
    expect(net.calls()).toBe(0) // nothing downloads onto a disk that can't hold it
  })

  it('fails if a download file that cannot be written crashes the app instead of saying so', async () => {
    const d = place()
    // the folder turns into a file between the space check and the download, so opening the download fails
    const blocked = { ...d, freeBytes: async (dir: string) => (rmSync(dir, { recursive: true, force: true }), writeFileSync(dir, 'x'), 10e9) }
    const err = await ensureCodex({ ...blocked, fetch: serve(BYTES).fetch, extract: fakeExtract() }, new AbortController().signal).catch((e) => e)
    expect([err.problem, err.message]).toEqual(['failed', FETCH_MESSAGES.failed])
  })

  it('fails if a computer the pin has no package for downloads anything', async () => {
    const d = { ...place(), pkg: undefined, platform: 'linux' as NodeJS.Platform }
    const net = serve(BYTES)
    const err = await ensureCodex({ ...d, fetch: net.fetch }, new AbortController().signal).catch((e) => e)
    expect(err.problem).toBe('unsupported')
    expect(net.calls()).toBe(0)
  })
})
