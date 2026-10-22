import { constants, existsSync, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { checkPlatform, outputGroups, platformRule, secondTryProblem, type FinishedVideo, type Platform, type PlatformTry } from '../shared/platforms'
import type { PlatformExportResult } from '../shared/api'
import type { RunEngine } from './engine'

const STAGE_PREFIX = '.platform-export-'
// A clone on APFS and other copy-on-write disks; a plain copy elsewhere. Never replaces a file.
const COMMIT = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
const SET = ['.mp4', ' cover.jpg', ' caption.txt']

/** One version of the post and the platforms that receive it. */
export interface ExportTry extends PlatformTry {
  /** The finished render. */
  source: string
  /** The version's cover picture, used when `coverSeconds` is null. */
  chosenCover: string | null
  /** "<title> - Version N" */
  name: string
  platforms: Platform[]
}

type CheckedTry = ExportTry & { video: FinishedVideo }
type Tries<T> = [T] | [T, T]

/**
 * Reads each try's render and refuses an export any platform would reject for its try, or a Try 2 that changes
 * nothing. Runs before the export job.
 */
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
  if (!tries[1]) return [first]
  // The cover frame needs the render's frame rate, so this runs after the probe.
  const problem = secondTryProblem(first.platforms, first, tries[1], first.video.fps)
  if (problem) throw { code: 'BAD_EXPORT', userMessage: problem }
  return [first, await check(tries[1], 2, first)]
}

async function probe(source: string, runEngine: RunEngine, label: string): Promise<FinishedVideo> {
  const video = await runEngine('export-probe', [source]) as Partial<FinishedVideo> | null
  if (typeof video?.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0 ||
      typeof video.width !== 'number' || typeof video.height !== 'number' || typeof video.fps !== 'number' || typeof video.sizeBytes !== 'number' ||
      typeof video.editList !== 'boolean' || typeof video.maxKeyframeGap !== 'number') {
    throw { code: 'EXPORT_FAILED', userMessage: `${label}I could not read the finished video. Render this version again before exporting.` }
  }
  return video as FinishedVideo
}

/** " (n)" free for every file name this export could write, or "" when none is taken, so all its sets share one number. */
function freeNumber(folder: string, bases: string[]): string {
  for (let i = 1; ; i++) {
    const tag = i === 1 ? '' : ` (${i})`
    if (!bases.some((base) => SET.some((suffix) => existsSync(join(folder, `${base}${tag}${suffix}`))))) return tag
  }
}

/**
 * One video, cover and caption file per platform and try. The render is copied as it is wherever it already
 * meets the platform's rule; the rest is remuxed or encoded. A Try 2 on Try 1's video gets a cover and caption only.
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
  const placed: string[] = []
  const two = tries.length > 1
  try {
    const staged: { cover: string; caption: string; outputFor: Map<Platform, string>; sharedVideo: boolean }[] = []
    for (const [t, item] of tries.entries()) {
      const sharedVideo = t > 0 && item.source === tries[0].source
      const cover = join(stage, `cover-${t + 1}.jpg`)
      // The scrub bar's end is the duration itself; the engine picks the last frame it can decode.
      const coverArgs = item.coverSeconds !== null ? [item.source, '--at', String(Math.min(item.coverSeconds, item.video.duration))]
        : item.chosenCover ? [item.chosenCover]
        // the same frame the renderer falls back to (render.py fallback_cover)
        : [item.source, '--at', String(Math.min(item.video.duration * 0.25, 3))]
      await runEngine('export-cover', [...coverArgs, '--dest', cover], undefined, signal)

      const outputFor = new Map<Platform, string>()
      for (const [index, group] of (sharedVideo ? [] : outputGroups(item.platforms, item.video)).entries()) {
        const output = join(stage, `video-${t + 1}-${index}.mp4`)
        const message = `Making the ${group.platforms.map((p) => platformRule(p).label).join(' and ')} video${two ? ` for Try ${t + 1}` : ''}`
        const encode = group.spec ? ['--width', String(group.spec.width), '--height', String(group.spec.height), '--bitrate', String(group.spec.videoBitrate)] : []
        onProgress?.(message, 0)
        await runEngine('export-media', [item.source, '--dest', output, ...encode], (p) => onProgress?.(message, p.pct), signal)
        const size = (await fs.stat(output)).size
        for (const platform of group.platforms) {
          const rule = platformRule(platform)
          if (size > rule.maxBytes) throw { code: 'EXPORT_SIZE', userMessage: `${two ? `Try ${t + 1} on ` : ''}${rule.label}: the video is too large. Shorten it and try again.` }
          outputFor.set(platform, output)
        }
      }
      const caption = join(stage, `caption-${t + 1}.txt`)
      await fs.writeFile(caption, `${item.caption}\n`, 'utf8')
      staged.push({ cover, caption, outputFor, sharedVideo })
    }

    const base = (item: CheckedTry, platform: Platform, n: number) => `${item.name} - ${platformRule(platform).label}${two ? ` - Try ${n}` : ''}`
    const tag = freeNumber(folder, tries.flatMap((item, t) => item.platforms.map((platform) => base(item, platform, t + 1))))
    const files: PlatformExportResult['files'] = []
    for (const [t, item] of tries.entries()) {
      const { cover, caption, outputFor, sharedVideo } = staged[t]
      const n: 1 | 2 = t === 0 ? 1 : 2
      for (const platform of item.platforms) {
        signal?.throwIfAborted()
        const stem = `${base(item, platform, n)}${tag}`
        const video = sharedVideo ? files.find((f) => f.platform === platform)?.video : join(folder, `${stem}.mp4`)
        if (!video) throw new Error(`Try 2 for ${platform} has no Try 1 video to share`)
        const file = {
          platform, ...(two && { try: n }),
          video,
          cover: join(folder, `${stem} cover.jpg`), captionFile: join(folder, `${stem} caption.txt`), caption: item.caption
        }
        const copies = [...(sharedVideo ? [] : [[outputFor.get(platform) ?? item.source, file.video]]), [cover, file.cover], [caption, file.captionFile]]
        for (const [from, to] of copies) await place(from, to, stage, placed)
        files.push(file)
      }
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
