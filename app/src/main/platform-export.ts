import { constants, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { checkPlatform, outputGroups, platformRule, type FinishedVideo, type Platform, type PlatformExportRequest } from '../shared/platforms'
import type { PlatformExportResult } from '../shared/api'
import type { RunEngine } from './engine'
import { uniqueStem } from './library'

const STAGE_PREFIX = '.platform-export-'
// A clone on APFS and other copy-on-write disks; a plain copy elsewhere. Never replaces a file.
const COMMIT = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE

/** Reads the finished render and refuses an export any selected platform would reject. Runs before the export job. */
export async function checkPlatformExport(source: string, request: PlatformExportRequest, runEngine: RunEngine): Promise<FinishedVideo> {
  const video = await runEngine('export-probe', [source]) as Partial<FinishedVideo> | null
  if (typeof video?.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0 ||
      typeof video.width !== 'number' || typeof video.height !== 'number' || typeof video.fps !== 'number' || typeof video.sizeBytes !== 'number' ||
      typeof video.editList !== 'boolean' || typeof video.maxKeyframeGap !== 'number') {
    throw { code: 'EXPORT_FAILED', userMessage: 'I could not read the finished video. Render this version again before exporting.' }
  }
  for (const platform of request.platforms) {
    const problem = checkPlatform(platform, request.caption, video.duration).find((issue) => issue.blocking)
    if (problem) throw { code: 'EXPORT_RULE', userMessage: `${platformRule(platform).label}: ${problem.message}` }
  }
  return video as FinishedVideo
}

/**
 * One video, cover and caption file per platform. The render is copied as it is wherever it already
 * meets the platform's rule; the rest is remuxed or encoded. Nothing is left behind if this fails or stops.
 */
export async function exportPlatforms({ source, video, chosenCover, folder, name, request, runEngine, signal, onProgress }: {
  source: string
  video: FinishedVideo
  /** The project's cover picture, used when the request picks no frame. */
  chosenCover: string | null
  folder: string
  name: string
  request: PlatformExportRequest
  runEngine: RunEngine
  signal?: AbortSignal
  onProgress?: (message: string, pct: number) => void
}): Promise<PlatformExportResult> {
  await fs.mkdir(folder, { recursive: true })
  const stage = await fs.mkdtemp(join(folder, STAGE_PREFIX))
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
      const encode = group.spec ? ['--width', String(group.spec.width), '--height', String(group.spec.height), '--bitrate', String(group.spec.videoBitrate)] : []
      onProgress?.(message, 0)
      await runEngine('export-media', [source, '--dest', output, ...encode], (p) => onProgress?.(message, p.pct), signal)
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
        await place(from, to, stage, placed)
      }
      files.push(file)
    }
    signal?.throwIfAborted()
    return { folder, files }
  } catch (error) {
    // Windows can hold a just-written file for a moment; a removal that still fails must not hide why we stopped.
    await Promise.allSettled(placed.map((file) => fs.rm(file, { force: true, maxRetries: 5, retryDelay: 200 })))
    throw signal?.aborted ? { code: 'CANCELLED', userMessage: 'Stopped.' } : error
  } finally {
    // Windows keeps a stopped ffmpeg's output locked for a moment; the startup sweep removes what is left.
    await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}

/**
 * Puts a copy of `from` at `dest` whole or not at all, and never over an existing file: the copy is made in the
 * staging folder and hard-linked into place. `dest` is recorded first, so a rollback also removes a copy that stopped
 * halfway on a drive without hard links.
 */
async function place(from: string, dest: string, stage: string, placed: string[]): Promise<void> {
  const part = join(stage, basename(dest))
  await fs.copyFile(from, part, COMMIT)
  placed.push(dest)
  try {
    await fs.link(part, dest).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw error
      // exFAT and FAT drives have no hard links.
      return fs.copyFile(part, dest, constants.COPYFILE_EXCL)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') placed.pop() // someone else's file: leave it alone
    throw error
  }
}

/** Staging folders left by a crash or a force quit during an export. */
export async function sweepExportStaging(folder: string): Promise<void> {
  const names = await fs.readdir(folder).catch(() => [])
  await Promise.all(names.filter((n) => n.startsWith(STAGE_PREFIX)).map((n) => fs.rm(join(folder, n), { recursive: true, force: true })))
}
