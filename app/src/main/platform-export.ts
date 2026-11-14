import { spawn } from 'node:child_process'
import { constants, createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fallbackCoverSeconds, outputGroups, platformRule, sameVideo, secondTryProblem, type FinishedVideo, type Platform, type PlatformTry } from '../shared/platforms'
import type { PlatformExportResult } from '../shared/api'
import type { RunEngine } from './engine'

const STAGE_PREFIX = '.platform-export-'
// A clone on APFS and other copy-on-write disks, or an error. Never replaces a file.
const CLONE = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE
// What a disk or system that cannot clone answers (Windows: ENOSYS; macOS off APFS: ENOTSUP).
const NO_CLONE = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOTTY', 'EINVAL'])
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
 * Reads each try's render and refuses a Try 2 that changes nothing or that no selected platform can test. Platform
 * limits only warn in the dialog, so nothing here refuses a caption or a length.
 */
async function readTries(tries: Tries<ExportTry>, runEngine: RunEngine, signal?: AbortSignal): Promise<Tries<CheckedTry>> {
  const label = (n: number) => tries.length > 1 ? `Try ${n}: ` : ''
  const first = { ...tries[0], video: await readFinishedVideo(tries[0].source, runEngine, label(1), signal) }
  if (!tries[1]) return [first]
  // The cover frame needs the render's frame rate and end, so this runs after the probe. The end is the one cover() uses.
  const problem = secondTryProblem(first.platforms, first, tries[1], { fps: first.video.fps, end: first.video.vduration || first.video.duration,
    fallback: first.chosenCover ? null : fallbackCoverSeconds(first.video.duration) })
  if (problem) throw { code: 'BAD_EXPORT', userMessage: problem }
  const second = tries[1].source === first.source ? first.video : await readFinishedVideo(tries[1].source, runEngine, label(2), signal)
  return [first, { ...tries[1], video: second }]
}

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

/** What the export needs to know about a finished render. Refuses only a render it cannot read. */
async function readFinishedVideo(source: string, runEngine: RunEngine, label: string, signal?: AbortSignal): Promise<FinishedVideo> {
  const video = await runEngine('export-probe', [source], undefined, signal) as Partial<FinishedVideo & { hasVideo: boolean }> | null
  if (video?.hasVideo !== true || typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0 || typeof video.fps !== 'number' ||
      typeof video.vduration !== 'number' || typeof video.sizeBytes !== 'number' || (video.audioBitrate !== null && typeof video.audioBitrate !== 'number') || typeof video.editList !== 'boolean') {
    throw { code: 'EXPORT_FAILED', userMessage: `${label}The finished version couldn’t be read. Make this version again, then share it.` }
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
 * One video, cover and caption file per platform and try. The render is copied as it is unless a platform needs its
 * audio redone or the file is over its size limit. A Try 2 on Try 1's video gets a cover and caption only.
 * Nothing is left behind if this fails or stops, except the staging folder of an engine that would not stop
 * (ENGINE_STUCK), which the next start removes.
 */
export async function exportPlatforms({ tries: requested, folder, runEngine, signal, onProgress }: {
  tries: Tries<ExportTry>
  folder: string
  runEngine: RunEngine
  signal?: AbortSignal
  onProgress?: (message: string, pct: number) => void
}): Promise<PlatformExportResult> {
  // Read under the export's signal: on a slow drive this takes a while, and Stop must end it too.
  const tries = await readTries(requested, runEngine, signal)
  await fs.mkdir(folder, { recursive: true })
  const stage = await makeStagingFolder(folder)
  const placed: string[] = []
  const two = tries.length > 1
  // An engine that would not stop (ENGINE_STUCK, engine.ts) may still be writing into the staging folder.
  let stuck = false
  try {
    const staged: { cover: string; caption: string; outputFor: Map<Platform, string>; sharedVideo: boolean }[] = []
    for (const [t, item] of tries.entries()) {
      const sharedVideo = t > 0 && item.source === tries[0].source && sameVideo(tries[0], item)
      const cover = join(stage, `cover-${t + 1}.jpg`)
      const look = item.brightness ? ['--brightness', String(item.brightness)] : []
      // The scrub bar's end is the duration itself; the engine picks the last frame it can decode.
      const coverArgs = item.coverSeconds !== null ? [item.source, '--at', String(Math.min(item.coverSeconds, item.video.duration))]
        : item.chosenCover ? [item.chosenCover]
        : [item.source, '--at', String(fallbackCoverSeconds(item.video.duration))]
      await runEngine('export-cover', [...coverArgs, ...look, '--dest', cover], undefined, signal)

      const outputFor = new Map<Platform, string>()
      for (const [index, group] of (sharedVideo ? [] : outputGroups(item.platforms, item.video, { encode: look.length > 0 })).entries()) {
        const output = join(stage, `video-${t + 1}-${index}.mp4`)
        const message = `Making the ${group.platforms.map((p) => platformRule(p).label).join(' and ')} version${two ? ` for Try ${t + 1}` : ''}`
        onProgress?.(message, 0)
        const encode = group.bitrate === null ? [] : ['--bitrate', String(group.bitrate), ...look]
        await runEngine('export-media', [item.source, '--dest', output, ...encode], (p) => onProgress?.(message, p.pct), signal)
        const size = (await fs.stat(output)).size
        for (const platform of group.platforms) {
          const rule = platformRule(platform)
          if (size > rule.maxBytes) throw { code: 'EXPORT_SIZE', userMessage: `${two ? `Try ${t + 1} on ` : ''}${rule.label}: the reel is too large. Shorten it and try again.` }
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
          platform, ...(two && { try: n }), version: item.version,
          video,
          cover: join(folder, `${stem} cover.jpg`), captionFile: join(folder, `${stem} caption.txt`), caption: item.caption
        }
        const copies = [...(sharedVideo ? [] : [[outputFor.get(platform) ?? item.source, file.video]]), [cover, file.cover], [caption, file.captionFile]]
        for (const [from, to] of copies) await place(from, to, stage, placed, signal)
        files.push(file)
      }
    }
    signal?.throwIfAborted()
    return { folder, files }
  } catch (error) {
    // Windows can hold a just-written file for a moment; a removal that still fails must not hide why we stopped.
    // Node documents maxRetries as ignored unless recursive is true, so it is set even for a single file.
    await Promise.allSettled(placed.map((file) => fs.rm(file, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })))
    // Stop aborts the signal before the runner finds the engine would not end: that is still ENGINE_STUCK, so the job
    // keeps the project closed (jobs.ts) and the dialog says to restart, instead of a normal "Stopped." (#175's fix
    // for #147 after #137)
    stuck = (error as { code?: string })?.code === 'ENGINE_STUCK'
    throw signal?.aborted && !stuck ? { code: 'CANCELLED', userMessage: 'Stopped.' } : error
  } finally {
    // Windows keeps a stopped ffmpeg's output locked for a moment; the startup sweep removes what is left. A stuck
    // engine's folder is left to that sweep, which runs after leftover engines are stopped (index.ts settleLastRun).
    if (!stuck) await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
}

/**
 * Puts a copy of `from` at `dest` whole or not at all, and never over an existing file: the copy is made in the
 * staging folder and hard-linked into place. `dest` is recorded first, so a rollback also removes a copy that stopped
 * halfway on a drive without hard links. Stop ends it between steps and in the middle of a copy (#147, b52a6dc8).
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
