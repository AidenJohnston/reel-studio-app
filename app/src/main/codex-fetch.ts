// "Sign in with ChatGPT" on a computer with no Codex app (docs/architecture.md section 6, Providers): the app gets
// OpenAI's own `codex` CLI itself, the same package OpenAI's installer fetches (scripts/install/install.ps1 and
// install.sh in openai/codex), and keeps it in its own folder. Nothing else on the computer changes: no PATH entry,
// no shortcut, nothing outside userData.
//
// Fetched on first use, not bundled: the package is 166 MB on a Mac and 201 MB on Windows, most people who pick
// ChatGPT already have Codex, and a bundled copy would age with every installer. It is pinned to one release and
// each archive is checked against the SHA-256 that release publishes (codex-package_SHA256SUMS, the same values as
// GitHub's asset digests) before anything is unpacked. Codex is Apache-2.0 (openai/codex LICENSE), so fetching and
// running it alongside AGPL-3.0 Reel Studio is allowed; THIRD_PARTY.md lists it.
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { basename, dirname, join, posix, win32 } from 'node:path'

export const CODEX_VERSION = '0.167.2'

/** codex-package_SHA256SUMS of rust-v0.167.2 (2026-11-11), one per target this app ships on. */
export const CODEX_PACKAGES: Record<string, { asset: string; sha256: string; bytes: number }> = {
  'win32-x64': { asset: 'codex-package-x86_64-pc-windows-msvc.tar.gz', sha256: '20b0f94105f40b617bf209b1679b8674ab6d3d8f303e767ae43cf1860a8705da', bytes: 201_559_461 },
  'win32-arm64': { asset: 'codex-package-aarch64-pc-windows-msvc.tar.gz', sha256: '61d852fb27769c76344a977cdcc5701bb0172606674e45addf0c12962ad6e8ef', bytes: 186_789_602 },
  'darwin-arm64': { asset: 'codex-package-aarch64-apple-darwin.tar.gz', sha256: 'e791290651bce41938fb160b5de2bd9ff8bcf3401ca3e236c73f485fca4be1bb', bytes: 166_599_161 }
}

export const codexPackageUrl = (asset: string): string => `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}`

/** The archive, the unpacked package (about three times the archive) and room to spare. */
const SPACE_FACTOR = 5

export type FetchProblem = 'unsupported' | 'offline' | 'disk' | 'bad_download' | 'cancelled' | 'failed'

export class CodexFetchError extends Error {
  /** `detail`: for the log only (where it stopped and the system's error code), never shown to the person */
  constructor(readonly problem: FetchProblem, message: string, readonly detail?: string) {
    super(message)
  }
}

/** Where a step failed and the system's own code, for the log: no URL, no file contents. */
const why = (step: string, e?: unknown): string => {
  const x = e as (NodeJS.ErrnoException & { stderr?: string }) | undefined
  return [step, x?.code, x?.syscall, x?.stderr ?? (x instanceof Error ? x.message : undefined)].filter(Boolean).join(': ').slice(0, 400)
}

export const FETCH_MESSAGES: Record<Exclude<FetchProblem, 'cancelled'>, string> = {
  unsupported: 'ChatGPT can’t be set up on this kind of computer yet. Try Other ways below.',
  offline: 'The download stopped. Check you’re online, then try again.',
  disk: 'Your disk is too full. Free up 1 GB, then try again.',
  bad_download: 'The download came through damaged. Try again.',
  failed: 'Getting ChatGPT ready didn’t work. Try again.'
}

export interface CodexPackage {
  asset: string
  sha256: string
  bytes: number
  url: string
}

export interface CodexFetchDeps {
  /** where the package lives: <userData>/codex */
  dir: string
  platform: NodeJS.Platform
  arch: string
  fetch?: typeof fetch
  /** unpacks a .tar.gz into `dest` (default: the system's own tar) */
  extract?: (archive: string, dest: string, signal: AbortSignal) => Promise<void>
  /** free bytes on the disk holding `dir` (default: fs.statfs) */
  freeBytes?: (dir: string) => Promise<number>
  /** tests only: another package to fetch (a local server and its hash) */
  pkg?: CodexPackage
  systemRoot?: string
}

export function codexPackage(platform: NodeJS.Platform, arch: string): CodexPackage | null {
  const p = CODEX_PACKAGES[`${platform}-${arch}`]
  return p ? { ...p, url: codexPackageUrl(p.asset) } : null
}

/** The binary inside an unpacked package (install.ps1 / install.sh: bin/codex.exe, bin/codex). */
export function codexBinIn(release: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? win32 : posix).join(release, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
}

/** The release folder: one per pinned hash, so a new pin never reuses an old unpack. */
const releaseDir = (dir: string, pkg: CodexPackage): string => join(dir, `${CODEX_VERSION}-${pkg.sha256.slice(0, 12)}`)

/** The binary when this pin is already unpacked here (its marker is written last), else null. Never downloads. */
export function installedCodex(d: Pick<CodexFetchDeps, 'dir' | 'platform' | 'arch' | 'pkg'>): string | null {
  const pkg = d.pkg ?? codexPackage(d.platform, d.arch)
  if (!pkg) return null
  const release = releaseDir(d.dir, pkg)
  const bin = codexBinIn(release, d.platform)
  return existsSync(join(release, '.complete')) && existsSync(bin) ? bin : null
}

function systemTar(platform: NodeJS.Platform, systemRoot: string): string {
  // Windows 10 1803 and later ship bsdtar as System32\tar.exe, which reads .tar.gz; install.ps1 uses the same one.
  return platform === 'win32' ? win32.join(systemRoot, 'System32', 'tar.exe') : '/usr/bin/tar'
}

/**
 * Windows' tar.exe reads its arguments in the system's legacy code page (936 on a Chinese Windows, 1252 on an English
 * one), so a folder with letters outside it ("Zoë" on code page 936) reached tar as "Zo?" and the unpack failed
 * (Windows 11, request l2-ai-setup-6). tar starts in the folder holding both the archive and the staging folder and
 * gets only their names, which this file chose and are plain ASCII; the folder itself goes to Windows as the working
 * directory, which takes any letters.
 */
function tarExtract(platform: NodeJS.Platform, systemRoot: string) {
  return (archive: string, dest: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const here = dirname(archive)
      if (dirname(dest) !== here) return reject(new Error('the archive and the staging folder must sit side by side'))
      const child = spawn(systemTar(platform, systemRoot), ['-xzf', basename(archive), '-C', basename(dest)], { cwd: here, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
      let said = ''
      child.stderr?.on('data', (b: Buffer) => void (said = (said + String(b)).slice(-300)))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`tar exited ${code}`), { stderr: said.trim() || `tar exited ${code}` }))))
    })
}

async function statfsFree(dir: string): Promise<number> {
  const s = await fs.statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/**
 * Windows: renaming a folder whose new .exe an antivirus is still scanning fails with EPERM, EBUSY or EACCES for a
 * moment. Tries for about 5 s before giving up.
 */
async function moveIntoPlace(from: string, to: string, signal: AbortSignal): Promise<void> {
  for (let i = 0; ; i++) {
    // Cancel during a wait below stops here: nothing is moved into place after it
    if (signal.aborted) throw new CodexFetchError('cancelled', 'Stopped.')
    try {
      return await fs.rename(from, to)
    } catch (e) {
      const code = String((e as NodeJS.ErrnoException)?.code)
      if (signal.aborted || i >= 25 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

const isDiskFull = (e: unknown): boolean => ['ENOSPC', 'EDQUOT'].includes(String((e as NodeJS.ErrnoException)?.code))

/**
 * The Codex binary, fetched and unpacked if this pin isn't here yet. Progress is 0-100 over the download. Throws
 * CodexFetchError with plain words; a cancel (signal) leaves nothing behind but the folder it started from.
 */
export async function ensureCodex(d: CodexFetchDeps, signal: AbortSignal, onProgress?: (pct: number) => void): Promise<string> {
  const pkg = d.pkg ?? codexPackage(d.platform, d.arch)
  if (!pkg) throw new CodexFetchError('unsupported', FETCH_MESSAGES.unsupported)
  const done = installedCodex({ ...d, pkg })
  if (done) return done

  const release = releaseDir(d.dir, pkg)
  const stage = join(d.dir, `.staging-${randomUUID().slice(0, 8)}`)
  const archive = join(d.dir, `.download-${randomUUID().slice(0, 8)}.tar.gz`)
  const cancelled = (): CodexFetchError => new CodexFetchError('cancelled', 'Stopped.')
  try {
    await fs.mkdir(d.dir, { recursive: true })
    const free = await (d.freeBytes ?? statfsFree)(d.dir).catch(() => Infinity)
    if (free < pkg.bytes * SPACE_FACTOR) throw new CodexFetchError('disk', FETCH_MESSAGES.disk)

    let res: Response
    try {
      res = await (d.fetch ?? fetch)(pkg.url, { signal, redirect: 'follow' })
    } catch {
      throw signal.aborted ? cancelled() : new CodexFetchError('offline', FETCH_MESSAGES.offline)
    }
    if (!res.ok || !res.body) throw new CodexFetchError('offline', FETCH_MESSAGES.offline)
    const total = Number(res.headers.get('content-length')) || pkg.bytes
    const hash = createHash('sha256')
    let got = 0
    let shown = -1
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk)
        got += chunk.length
        const pct = Math.min(99, Math.floor((got / total) * 100))
        if (pct !== shown) onProgress?.((shown = pct))
        done(null, chunk)
      }
    })
    // pipeline: a write error (a disk that fills up mid-download, a file it can't open) rejects here and closes both
    // ends, instead of escaping as an unhandled stream error in the main process
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), meter, createWriteStream(archive), { signal })
    } catch (e) {
      if (signal.aborted) throw cancelled()
      if (isDiskFull(e)) throw new CodexFetchError('disk', FETCH_MESSAGES.disk)
      // a file error (it has a syscall: open, write) is this computer's; anything else is the connection
      throw (e as NodeJS.ErrnoException)?.syscall ? new CodexFetchError('failed', FETCH_MESSAGES.failed, why('save download', e)) : new CodexFetchError('offline', FETCH_MESSAGES.offline, why('download', e))
    }
    if (signal.aborted) throw cancelled()
    // Nothing from the download is unpacked or run unless it is byte for byte the pinned package.
    if (hash.digest('hex') !== pkg.sha256) throw new CodexFetchError('bad_download', FETCH_MESSAGES.bad_download, why(`hash mismatch after ${got} bytes`))

    await fs.mkdir(stage, { recursive: true })
    try {
      await (d.extract ?? tarExtract(d.platform, d.systemRoot ?? 'C:\\Windows'))(archive, stage, signal)
    } catch (e) {
      throw signal.aborted ? cancelled() : isDiskFull(e) ? new CodexFetchError('disk', FETCH_MESSAGES.disk) : new CodexFetchError('failed', FETCH_MESSAGES.failed, why('unpack', e))
    }
    if (!existsSync(codexBinIn(stage, d.platform))) throw new CodexFetchError('failed', FETCH_MESSAGES.failed, why('unpacked package has no bin/codex'))
    if (d.platform !== 'win32') await fs.chmod(codexBinIn(stage, d.platform), 0o755)
    await fs.writeFile(join(stage, '.complete'), `${pkg.sha256}\n`)
    await fs.rm(release, { recursive: true, force: true })
    await moveIntoPlace(stage, release, signal)
    onProgress?.(100)
    return codexBinIn(release, d.platform)
  } catch (e) {
    if (e instanceof CodexFetchError) throw e
    throw isDiskFull(e) ? new CodexFetchError('disk', FETCH_MESSAGES.disk) : new CodexFetchError('failed', FETCH_MESSAGES.failed, why('install', e))
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {})
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}
