// A first video that didn't work: Version 1 failed before any version was made. Its card shows the video's first
// frame while there is no copy to show, and another video replaces the copy and starts Version 1 again.
import { execFile } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isVideo } from './library'

/** The first frame of the video the person brought in, kept beside app.json for its card (store.ts summary). */
export const POSTER = 'poster.jpg'

// A dropped file is untrusted input: local files and the video demuxers only, as library-preview.ts reads the Library.
const INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi']

/** Writes the video's first frame to `dir`/poster.jpg, 320 px wide (a card is 145 px at 2x). */
export function posterFrame(ffmpeg: string, video: string, dir: string): Promise<void> {
  const args = ['-nostdin', '-v', 'error', '-y', ...INPUT, '-i', video, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', join(dir, POSTER)]
  return new Promise((ok, fail) => execFile(ffmpeg, args, { timeout: 20_000, windowsHide: true }, (err) => (err ? fail(err) : ok())))
}

/**
 * Removes what a first edit that made no version left behind (the copy, its caches, the poster), so the engine can
 * copy in another video. app.json, with the title, the plan and the chat, stays. A reel with a version is refused:
 * its versions were made from that copy.
 */
export async function clearFailedCopy(dir: string): Promise<void> {
  const versions = await fs.readdir(join(dir, 'versions')).catch(() => [] as string[])
  if (versions.some((v) => /^v\d+$/.test(v))) {
    throw { code: 'HAS_VIDEO', userMessage: 'This reel already has a version. Drop the other video on Reels to make a new reel.' }
  }
  for (const name of ['project.json', 'media', 'work', 'versions', POSTER]) await fs.rm(join(dir, name), { recursive: true, force: true })
}

/** Version 1 was stopped during its copy and the file it copied from can't be opened any more: its card and its stage
 * say so (store.ts summary), and another video on the same reel starts it again. */
export const COPY_GONE = { code: 'COPY_GONE', userMessage: 'Your video was only partly copied and the file you dropped can’t be found any more, so drop it again from where it is now.' }

/**
 * Whether a copy stopped partway can be made again from `files`: each still a video file that opens, as a fresh drop
 * is checked (main/index.ts takeVideos), and that this account can read.
 */
export async function canCopyAgain(files: string[] | undefined): Promise<boolean> {
  if (!files?.length) return false
  for (const f of files) {
    if (!isVideo(f) || !(await fs.stat(f).catch(() => null))?.isFile()) return false
    if (!(await fs.access(f, constants.R_OK).then(() => true, () => false))) return false
  }
  return true
}

/**
 * The title a reel takes with another video after Version 1 failed: the new file's while it still goes by the old
 * file's title, so a name the person or a plan gave it stays. Without a record of the old file's title, it stays too.
 */
export const titleWithAnotherVideo = (current: string, fileTitle: string | undefined, newFileTitle: string): string =>
  fileTitle !== undefined && current === fileTitle ? newFileTitle : current
