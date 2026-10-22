import { constants, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { checkPlatform, platformRule, renderGroups, type PlatformExportRequest } from '../shared/platforms'
import type { PlatformExportResult } from '../shared/api'
import type { RunEngine } from './engine'

export async function exportPlatforms({ source, folder, name, request, runEngine, signal }: {
  source: string
  folder: string
  name: string
  request: PlatformExportRequest
  runEngine: RunEngine
  signal?: AbortSignal
}): Promise<PlatformExportResult> {
  const raw: unknown = await runEngine('probe', [source], undefined, signal)
  if (!raw || typeof raw !== 'object' || !('duration' in raw) || typeof raw.duration !== 'number' ||
      !Number.isFinite(raw.duration) || raw.duration <= 0 ||
      !('displayWidth' in raw) || typeof raw.displayWidth !== 'number' ||
      !('displayHeight' in raw) || typeof raw.displayHeight !== 'number') {
    throw { code: 'EXPORT_FAILED', userMessage: 'I could not read the finished video. Render this version again before exporting.' }
  }
  const seconds = raw.duration
  for (const platform of request.platforms) {
    const problem = checkPlatform(platform, request.caption, seconds, raw.displayWidth, raw.displayHeight).find((issue) => issue.blocking)
    if (problem) throw { code: 'EXPORT_RULE', userMessage: `${platformRule(platform).label}: ${problem.message}` }
  }
  if (request.coverSeconds >= seconds) throw { code: 'EXPORT_RULE', userMessage: 'Choose a cover time inside the finished video.' }
  await fs.mkdir(folder, { recursive: true })
  const stage = await fs.mkdtemp(join(folder, '.platform-export-'))
  const files: PlatformExportResult['files'] = []
  const committed: string[] = []
  try {
    const groups = renderGroups(request.platforms, seconds)
    for (const [index, group] of groups.entries()) {
      const video = join(stage, `render-${index}.mp4`)
      await runEngine('export-media', [source, '--dest', video, '--width', String(group.spec.width), '--height', String(group.spec.height),
        '--bitrate', String(group.spec.videoBitrate), '--cover-at', String(request.coverSeconds)], undefined, signal)
      const size = (await fs.stat(video)).size
      for (const platform of group.platforms) {
        const rule = platformRule(platform)
        if (size > rule.maxBytes) throw { code: 'EXPORT_SIZE', userMessage: `${rule.label}: the encoded file is too large. Shorten the video and try again.` }
        const stem = `${name} - ${rule.label} - ${basename(stage).slice(-6)}`
        const dest = join(folder, `${stem}.mp4`)
        const cover = join(folder, `${stem} cover.jpg`)
        const captionFile = join(folder, `${stem} caption.txt`)
        files.push({ platform, video: dest, cover, captionFile, caption: request.caption })
        await fs.copyFile(video, join(stage, `${stem}.mp4`))
        await fs.copyFile(join(stage, `render-${index}.jpg`), join(stage, `${stem} cover.jpg`))
        await fs.writeFile(join(stage, `${stem} caption.txt`), `${request.caption}\n`, 'utf8')
      }
    }
    for (const file of files) {
      signal?.throwIfAborted()
      for (const dest of [file.video, file.cover, file.captionFile]) {
        await fs.copyFile(join(stage, basename(dest)), dest, constants.COPYFILE_EXCL)
        committed.push(dest)
        signal?.throwIfAborted()
      }
    }
    signal?.throwIfAborted()
    return { folder, files }
  } catch (error) {
    await Promise.all(committed.map((dest) => fs.rm(dest, { force: true })))
    throw error
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}
