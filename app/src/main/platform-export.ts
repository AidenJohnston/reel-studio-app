import { constants, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { checkPlatform, encodeGroups, platformRule, type FinishedVideo, type Platform } from '../shared/platforms'
import type { PlatformExportResult } from '../shared/api'
import type { RunEngine } from './engine'
import { uniqueStem } from './library'

const STAGE_PREFIX = '.platform-export-'
// A clone on APFS and other copy-on-write disks; a plain copy elsewhere. Never replaces a file.
const COMMIT = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE

/** One version of the post and the platforms that receive it. */
export interface ExportTry {
  /** The finished render. */
  source: string
  /** The version's cover picture, used when `coverSeconds` is null. */
  chosenCover: string | null
  /** "<title> - Version N" */
  name: string
  platforms: Platform[]
  caption: string
  coverSeconds: number | null
}

type CheckedTry = ExportTry & { video: FinishedVideo }
type Tries<T> = [T] | [T, T]

/** Reads each try's render and refuses an export any platform would reject for its try. Runs before the export job. */
export async function checkPlatformExport(tries: Tries<ExportTry>, runEngine: RunEngine): Promise<Tries<CheckedTry>> {
  const check = async (item: ExportTry, n: number, probed?: CheckedTry): Promise<CheckedTry> => {
    const label = tries.length > 1 ? `Try ${n}: ` : ''
    const video = probed?.source === item.source ? probed.video : await probe(item.source, runEngine, label)
    for (const platform of item.platforms) {
      const problem = checkPlatform(platform, item.caption, video.duration).find((issue) => issue.blocking)
      if (problem) throw { code: 'EXPORT_RULE', userMessage: `${tries.length > 1 ? `Try ${n} on ` : ''}${platformRule(platform).label}: ${problem.message}` }
    }
    return { ...item, video }
  }
  const first = await check(tries[0], 1)
  return tries[1] ? [first, await check(tries[1], 2, first)] : [first]
}

async function probe(source: string, runEngine: RunEngine, label: string): Promise<FinishedVideo> {
  const video = await runEngine('probe', [source]) as Partial<FinishedVideo> | null
  if (typeof video?.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0 ||
      typeof video.width !== 'number' || typeof video.height !== 'number' || typeof video.fps !== 'number' || typeof video.sizeBytes !== 'number') {
    throw { code: 'EXPORT_FAILED', userMessage: `${label}I could not read the finished video. Render this version again before exporting.` }
  }
  return video as FinishedVideo
}

/**
 * One video, cover and caption file per platform and try. The render is copied as it is wherever it already
 * meets the platform's rule; only the rest is encoded. A Try 2 on Try 1's video gets a cover and caption only.
 * Nothing is left behind if this fails or stops.
 */
export async function exportPlatforms({ tries, folder, runEngine, signal, onProgress }: {
  tries: Tries<CheckedTry>
  folder: string
  runEngine: RunEngine
  signal?: AbortSignal
  onProgress?: (message: string, pct: number) => void
}): Promise<PlatformExportResult> {
  await fs.mkdir(folder, { recursive: true })
  const stage = await fs.mkdtemp(join(folder, STAGE_PREFIX))
  const committed: string[] = []
  const two = tries.length > 1
  try {
    const staged: { cover: string; encodedFor: Map<Platform, string>; sharedVideo: boolean }[] = []
    for (const [t, item] of tries.entries()) {
      const sharedVideo = t > 0 && item.source === tries[0].source
      const cover = join(stage, `cover-${t + 1}.jpg`)
      // The scrub bar's end is the duration itself; the engine picks the last frame it can decode.
      const coverArgs = item.coverSeconds !== null ? [item.source, '--at', String(Math.min(item.coverSeconds, item.video.duration))]
        : item.chosenCover ? [item.chosenCover]
        // the same frame the renderer falls back to (render.py fallback_cover)
        : [item.source, '--at', String(Math.min(item.video.duration * 0.25, 3))]
      await runEngine('export-cover', [...coverArgs, '--dest', cover], undefined, signal)

      const encodedFor = new Map<Platform, string>()
      const groups = sharedVideo ? [] : encodeGroups(item.platforms, item.video)
      for (const [index, group] of groups.entries()) {
        const encoded = join(stage, `video-${t + 1}-${index}.mp4`)
        const message = `Making the ${group.platforms.map((p) => platformRule(p).label).join(' and ')} video${two ? ` for Try ${t + 1}` : ''}`
        onProgress?.(message, 0)
        await runEngine('export-media', [item.source, '--dest', encoded, '--width', String(group.spec.width), '--height', String(group.spec.height),
          '--bitrate', String(group.spec.videoBitrate)], (p) => onProgress?.(message, p.pct), signal)
        const size = (await fs.stat(encoded)).size
        for (const platform of group.platforms) {
          const rule = platformRule(platform)
          if (size > rule.maxBytes) throw { code: 'EXPORT_SIZE', userMessage: `${two ? `Try ${t + 1} on ` : ''}${rule.label}: the video is too large. Shorten it and try again.` }
          encodedFor.set(platform, encoded)
        }
      }
      staged.push({ cover, encodedFor, sharedVideo })
    }

    const files: PlatformExportResult['files'] = []
    for (const [t, item] of tries.entries()) {
      const { cover, encodedFor, sharedVideo } = staged[t]
      const n: 1 | 2 = t === 0 ? 1 : 2
      for (const platform of item.platforms) {
        signal?.throwIfAborted()
        const base = `${item.name} - ${platformRule(platform).label}${two ? ` - Try ${n}` : ''}`
        const stem = uniqueStem(folder, base, sharedVideo ? [' cover.jpg', ' caption.txt'] : ['.mp4', ' cover.jpg', ' caption.txt'])
        const video = sharedVideo ? files.find((f) => f.platform === platform)?.video : join(folder, `${stem}.mp4`)
        if (!video) throw new Error(`Try 2 for ${platform} has no Try 1 video to share`)
        const file = {
          platform, ...(two && { try: n }),
          video,
          cover: join(folder, `${stem} cover.jpg`), captionFile: join(folder, `${stem} caption.txt`), caption: item.caption
        }
        const copies = sharedVideo ? [[cover, file.cover]] : [[encodedFor.get(platform) ?? item.source, file.video], [cover, file.cover]]
        for (const [from, to] of copies) {
          await fs.copyFile(from, to, COMMIT)
          committed.push(to)
        }
        await fs.writeFile(file.captionFile, `${item.caption}\n`, { encoding: 'utf8', flag: 'wx' })
        committed.push(file.captionFile)
        files.push(file)
      }
    }
    signal?.throwIfAborted()
    return { folder, files }
  } catch (error) {
    await Promise.all(committed.map((file) => fs.rm(file, { force: true })))
    throw signal?.aborted ? { code: 'CANCELLED', userMessage: 'Stopped.' } : error
  } finally {
    // Windows keeps a stopped ffmpeg's output locked for a moment; the startup sweep removes what is left.
    await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}

/** Staging folders left by a crash or a force quit during an export. */
export async function sweepExportStaging(folder: string): Promise<void> {
  const names = await fs.readdir(folder).catch(() => [])
  await Promise.all(names.filter((n) => n.startsWith(STAGE_PREFIX)).map((n) => fs.rm(join(folder, n), { recursive: true, force: true })))
}
