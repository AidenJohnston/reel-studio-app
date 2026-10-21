// A playable URL for every render a job reports (the job contract's `render.video`, shared/api.ts).
// Drafts live in versions/preview/draft.mp4, which the engine overwrites on the next draft render,
// while the Working screen may still be streaming it by HTTP ranges (a fresh file read per range),
// so a draft is played from a COPY in work/live/: the first look keeps its own file, the AI's drafts
// alternate between two, so the copy being written is never the one on screen. A final version
// (versions/vN/export.mp4) plays in place. Note drafts already have unique staging paths and
// need only a temporary playback grant.
import { existsSync, realpathSync, promises as fs } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import type { JobUpdate } from '../shared/api'
import { mediaUrl } from './media-url'

type Render = Extract<JobUpdate, { type: 'render' }>

export const LIVE_DIR = join('work', 'live')

function inside(dir: string, file: string): boolean {
  const r = relative(dir, file)
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

/** Note drafts have unique staged filenames and are playable only for their owning job. */
export function createNoteVideos() {
  const roots = new Map<string, string>()
  return {
    set(jobId: string, projectDir: string, stage: string | null): void {
      if (stage === null) { roots.delete(jobId); return }
      const root = realpathSync(stage)
      if (dirname(root) !== realpathSync(resolve(projectDir, '.staging'))) throw new Error('Note preview must be inside its transaction')
      roots.set(jobId, root)
    },
    roots: (): string[] => [...roots.values()],
    async video(jobId: string, e: Render): Promise<string | null> {
      const root = roots.get(jobId)
      if (!root || !e.draft || !e.file) return null
      const file = await fs.realpath(e.file)
      if (!inside(root, file)) return null
      const stat = await fs.stat(file)
      // Cleanup may revoke the grant while stat is in flight.
      return roots.get(jobId) === root ? mediaUrl(file, stat.mtimeMs) : null
    }
  }
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
