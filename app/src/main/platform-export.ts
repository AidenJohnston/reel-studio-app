import { spawn } from 'node:child_process'
import { constants, createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { outputGroups, platformRule, type FinishedVideo, type Platform, type PlatformExportRequest } from '../shared/platforms'
import type { PlatformExportResult } from '../shared/api'
import type { RunEngine } from './engine'
import { uniqueStem } from './library'

const STAGE_PREFIX = '.platform-export-'
// A clone on APFS and other copy-on-write disks, or an error. Never replaces a file.
const CLONE = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE
// What a disk or system that cannot clone answers (Windows: ENOSYS; macOS off APFS: ENOTSUP).
const NO_CLONE = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOTTY', 'EINVAL'])

/** A new hidden folder in `folder` where files are written before they are placed. */
export async function makeStagingFolder(folder: string): Promise<string> {
  const stage = await fs.mkdtemp(join(folder, STAGE_PREFIX))
  // Windows does not hide dot-folders, so Explorer would show this one in Finished videos while the export runs.
  // Hiding it is cosmetic: if attrib fails, the export still works, so the failure is ignored.
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      const attrib = spawn('attrib', ['+h', stage], { stdio: 'ignore', windowsHide: true })
      attrib.on('error', () => done())
      attrib.on('exit', () => done())
    })
  }
  return stage
}

/** What the export needs to know about the finished render. Refuses only a render it cannot read. */
export async function readFinishedVideo(source: string, runEngine: RunEngine, signal?: AbortSignal): Promise<FinishedVideo> {
  const video = await runEngine('export-probe', [source], undefined, signal) as Partial<FinishedVideo & { hasVideo: boolean }> | null
  if (video?.hasVideo !== true || typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0 || typeof video.sizeBytes !== 'number' ||
      (video.audioBitrate !== null && typeof video.audioBitrate !== 'number') || typeof video.editList !== 'boolean') {
    throw { code: 'EXPORT_FAILED', userMessage: 'I could not read the finished video. Render this version again before exporting.' }
  }
  return video as FinishedVideo
}

/**
 * One video, cover and caption file per platform. The render is copied as it is unless a platform needs its audio
 * redone or the file is over its size limit. Platform limits only warn in the dialog, so nothing here refuses a caption
 * or a length. Nothing is left behind if this fails or stops.
 */
export async function exportPlatforms({ source, chosenCover, folder, name, request, runEngine, signal, onProgress }: {
  source: string
  /** The project's cover picture, used when the request picks no frame. */
  chosenCover: string | null
  folder: string
  name: string
  request: PlatformExportRequest
  runEngine: RunEngine
  signal?: AbortSignal
  onProgress?: (message: string, pct: number) => void
}): Promise<PlatformExportResult> {
  // Read under the export's signal: on a slow drive this takes a while, and Stop must end it too.
  const video = await readFinishedVideo(source, runEngine, signal)
  await fs.mkdir(folder, { recursive: true })
  const stage = await makeStagingFolder(folder)
  const placed: string[] = []
  try {
    const cover = join(stage, 'cover.jpg')
    // The scrub bar's end is the duration itself; the engine picks the last frame it can decode.
    const coverArgs = request.coverSeconds !== null ? [source, '--at', String(Math.min(request.coverSeconds, video.duration))]
      : chosenCover ? [chosenCover]
      // the same frame the renderer falls back to (render.py fallback_cover)
      : [source, '--at', String(Math.min(video.duration * 0.25, 3))]
    await runEngine('export-cover', [...coverArgs, '--dest', cover], undefined, signal)

    const outputFor = new Map<Platform, string>()
    for (const [index, group] of outputGroups(request.platforms, video).entries()) {
      const output = join(stage, `video-${index}.mp4`)
      const message = `Making the ${group.platforms.map((p) => platformRule(p).label).join(' and ')} video`
      onProgress?.(message, 0)
      await runEngine('export-media', [source, '--dest', output, ...(group.bitrate === null ? [] : ['--bitrate', String(group.bitrate)])], (p) => onProgress?.(message, p.pct), signal)
      const size = (await fs.stat(output)).size
      for (const platform of group.platforms) {
        const rule = platformRule(platform)
        if (size > rule.maxBytes) throw { code: 'EXPORT_SIZE', userMessage: `${rule.label}: the video is too large. Shorten it and try again.` }
        outputFor.set(platform, output)
      }
    }
    const caption = join(stage, 'caption.txt')
    await fs.writeFile(caption, `${request.caption}\n`, 'utf8')

    const files: PlatformExportResult['files'] = []
    for (const platform of request.platforms) {
      signal?.throwIfAborted()
      const stem = uniqueStem(folder, `${name} - ${platformRule(platform).label}`, ['.mp4', ' cover.jpg', ' caption.txt'])
      const file = { platform, video: join(folder, `${stem}.mp4`), cover: join(folder, `${stem} cover.jpg`), captionFile: join(folder, `${stem} caption.txt`), caption: request.caption }
      for (const [from, to] of [[outputFor.get(platform) ?? source, file.video], [cover, file.cover], [caption, file.captionFile]]) {
        await place(from, to, stage, placed, signal)
      }
      files.push(file)
    }
    signal?.throwIfAborted()
    return { folder, files }
  } catch (error) {
    // Windows can hold a just-written file for a moment; a removal that still fails must not hide why we stopped.
    // Node documents maxRetries as ignored unless recursive is true, so it is set even for a single file.
    await Promise.allSettled(placed.map((file) => fs.rm(file, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })))
    throw signal?.aborted ? { code: 'CANCELLED', userMessage: 'Stopped.' } : error
  } finally {
    // Windows keeps a stopped ffmpeg's output locked for a moment; the startup sweep removes what is left.
    await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}

/**
 * Puts a copy of `from` at `dest` whole or not at all, and never over an existing file: the copy is made in the
 * staging folder and hard-linked into place. `dest` is recorded first, so a rollback also removes a copy that stopped
 * halfway on a drive without hard links. Stop ends it between steps and in the middle of a copy.
 */
async function place(from: string, dest: string, stage: string, placed: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const part = join(stage, basename(dest))
  await copy(from, part, signal)
  signal?.throwIfAborted()
  placed.push(dest)
  try {
    await fs.link(part, dest).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw error
      // exFAT and FAT drives have no hard links.
      return copy(part, dest, signal)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') placed.pop() // someone else's file: leave it alone
    throw error
  }
  // A linked copy shares its data with `dest`; an unlinked one is a second full video, so it goes now, not when the
  // export ends. One Windows still holds is left to the staging folder's cleanup.
  await fs.rm(part, { force: true }).catch(() => undefined)
}

/** A clone where the disk can make one; otherwise a streamed copy that Stop ends midway. Never replaces a file. */
async function copy(from: string, to: string, signal?: AbortSignal): Promise<void> {
  try {
    return await fs.copyFile(from, to, CLONE)
  } catch (error) {
    if (!NO_CLONE.has((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  await pipeline(createReadStream(from, { highWaterMark: 1 << 20 }), createWriteStream(to, { flags: 'wx' }), { signal })
}

/** Staging folders left by a crash or a force quit during an export. */
export async function sweepExportStaging(folder: string): Promise<void> {
  const names = await fs.readdir(folder).catch(() => [])
  // Same retries as the export's own cleanup: on Windows a just-exited ffmpeg can hold a file for a moment (EBUSY).
  await Promise.all(names.filter((n) => n.startsWith(STAGE_PREFIX)).map((n) => fs.rm(join(folder, n), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })))
}
