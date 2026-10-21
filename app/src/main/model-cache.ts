// A listening model already on this computer: another app (or a developer tool) that uses faster-whisper may have
// downloaded the exact files Reel Studio needs into the Hugging Face cache. Reel Studio copies them only after every
// file matches the pinned size and SHA-256 (engine/reelengine/models/speech-models.json).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'

export interface PinnedFile {
  name: string
  size: number
  sha256: string
}

export interface PinnedModel {
  repo: string
  revision: string
  files: PinnedFile[]
}

/** A leading `~` is the home folder, as huggingface_hub reads its path settings (os.path.expanduser). */
function expandHome(p: string, home: string, path: typeof posix): string {
  return p === '~' || /^~[\\/]/.test(p) ? path.join(home, p.slice(1)) : p
}

/**
 * The Hugging Face hub cache folder, where huggingface_hub itself saves (its constants.py): HF_HUB_CACHE, else
 * HUGGINGFACE_HUB_CACHE, else HF_HOME/hub, else XDG_CACHE_HOME/huggingface/hub, else ~/.cache/huggingface/hub,
 * which is %USERPROFILE%\.cache\huggingface\hub on Windows.
 */
export function hfHubCache(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix
  const x = (v: string): string => expandHome(v, home, path)
  const hub = env.HF_HUB_CACHE || env.HUGGINGFACE_HUB_CACHE
  if (hub) return x(hub)
  const hfHome = env.HF_HOME ? x(env.HF_HOME) : path.join(env.XDG_CACHE_HOME ? x(env.XDG_CACHE_HOME) : path.join(home, '.cache'), 'huggingface')
  return path.join(hfHome, 'hub')
}

/**
 * Snapshot folders of the model in the cache whose files all have the pinned sizes, the pinned revision first.
 * Sizes only: the contents are checked after copying (verifyFiles), so what is kept is what was checked.
 */
export async function findCachedCopies(cache: string, pin: PinnedModel): Promise<string[]> {
  const found: string[] = []
  const snapshots = join(cache, `models--${pin.repo.replace(/\//g, '--')}`, 'snapshots')
  const revisions = await fs.readdir(snapshots).catch(() => [] as string[])
  revisions.sort((a, b) => Number(b === pin.revision) - Number(a === pin.revision))
  for (const rev of revisions) {
    const dir = join(snapshots, rev)
    const sizes = await Promise.all(pin.files.map((f) => fs.stat(join(dir, f.name)).then((s) => s.size).catch(() => -1)))
    if (sizes.every((s, i) => s === pin.files[i].size)) found.push(dir)
  }
  return found
}

export type VerifyResult = { ok: true } | { ok: false; file: string; reason: 'missing' | 'size' | 'sha256' }

/** Every pinned file in `dir` has its size and SHA-256. `onBytes` gets the bytes read so far across all files. */
export async function verifyFiles(dir: string, files: PinnedFile[], onBytes?: (done: number) => void, signal?: AbortSignal): Promise<VerifyResult> {
  let done = 0
  for (const f of files) {
    const path = join(dir, f.name)
    const st = await fs.stat(path).catch(() => null)
    if (!st) return { ok: false, file: f.name, reason: 'missing' }
    if (st.size !== f.size) return { ok: false, file: f.name, reason: 'size' }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20, signal })) {
      hash.update(chunk as Buffer)
      done += (chunk as Buffer).length
      onBytes?.(done)
    }
    if (hash.digest('hex') !== f.sha256) return { ok: false, file: f.name, reason: 'sha256' }
  }
  return { ok: true }
}

/**
 * A copy that shares the original's blocks where the file system can (APFS on macOS; btrfs or XFS on Linux), else an
 * ordinary copy. macOS goes through `cp -c` (clonefile): Node's copyFile with COPYFILE_FICLONE does not clone there.
 * Measured 2026-10-20 on APFS with the 483 MB model: copyFile used 465 MB of free space, `cp -c` used none.
 */
async function cloneOrCopy(src: string, dst: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await promisify(execFile)('/bin/cp', ['-c', src, dst])
      return
    } catch {
      // another volume, or a file system that cannot clone: copy it instead
    }
  }
  await fs.copyFile(src, dst, constants.COPYFILE_FICLONE)
}

/**
 * Copy the pinned files from `src` into `dest` and keep them only if the copies verify. On APFS (macOS) and other
 * file systems that can clone, the copy shares the original's blocks and uses no extra disk (cloneOrCopy); elsewhere
 * it is an ordinary copy. Either way Reel Studio stops depending on a cache the person might clean out.
 */
export async function adoptCopy(src: string, dest: string, files: PinnedFile[], onBytes?: (done: number) => void, signal?: AbortSignal): Promise<VerifyResult> {
  const staging = `${dest}.found-${process.pid}`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    for (const f of files) {
      await cloneOrCopy(join(src, f.name), join(staging, f.name))
      // The cache keeps its files read-only; a read-only file on Windows could not be replaced or deleted later.
      await fs.chmod(join(staging, f.name), 0o644)
    }
    const check = await verifyFiles(staging, files, onBytes, signal)
    if (!check.ok) return check
    await fs.mkdir(dest, { recursive: true })
    for (const f of files) {
      await fs.rename(join(staging, f.name), join(dest, f.name))
      await fs.rm(join(dest, `${f.name}.part`), { force: true }) // an unfinished download of the same file
    }
    return check
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
