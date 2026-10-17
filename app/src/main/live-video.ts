// A playable URL for every render a job reports (the job contract's `render.video`, shared/api.ts).
// Drafts live in versions/preview/draft.mp4, which the engine overwrites on the next draft render,
// while the Working screen may still be streaming it by HTTP ranges (a fresh file read per range),
// so a draft is played from a COPY in work/live/: the first look keeps its own file, the AI's drafts
// alternate between two, so the copy being written is never the one on screen. A final version
// (versions/vN/export.mp4) is never overwritten and plays in place.
import { existsSync, promises as fs } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { JobUpdate } from '../shared/api'
import { mediaUrl } from './media-url'

type Render = Extract<JobUpdate, { type: 'render' }>

export const LIVE_DIR = join('work', 'live')

function inside(dir: string, file: string): boolean {
  const r = relative(dir, file)
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

export function createLiveVideos(): (projectDir: string, e: Render) => Promise<string | null> {
  const flip = new Map<string, number>()
  return async (projectDir, e) => {
    // trust the engine's path only inside this project
    const reported = e.file && inside(projectDir, e.file) && existsSync(e.file) ? e.file : null
    const src = reported ?? (e.draft ? join(projectDir, 'versions', 'preview', 'draft.mp4') : join(projectDir, 'versions', `v${e.version}`, 'export.mp4'))
    if (!existsSync(src)) return null
    if (!e.draft) return mediaUrl(src, (await fs.stat(src)).mtimeMs)
    const n = (flip.get(projectDir) ?? 0) + (e.firstLook ? 0 : 1)
    if (!e.firstLook) flip.set(projectDir, n)
    const name = e.firstLook ? 'first-look.mp4' : `look-${n % 2 ? 'a' : 'b'}.mp4`
    const dest = join(projectDir, LIVE_DIR, name)
    try {
      await fs.mkdir(join(projectDir, LIVE_DIR), { recursive: true })
      await fs.copyFile(src, dest)
      return mediaUrl(dest, Date.now())
    } catch {
      // a locked copy target (Windows): the engine's own file still plays
      return mediaUrl(src, (await fs.stat(src)).mtimeMs)
    }
  }
}
