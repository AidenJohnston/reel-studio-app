// The shared Library: <Reel Studio>/Library/{Raw takes,B-roll,Music,Images,Exports}.
import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { BIN_FOLDERS, binDir, libraryDir, reelStudioRoot, type BinKey } from './paths'
import { allowLinkedMedia } from './media-allow'
import { mediaUrl } from './media-url'
import type { DropResult, LibraryBin } from '../shared/api'
import type { RunEngine } from './engine'

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts'])
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'])
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic'])

const LABELS: Record<BinKey, string> = {
  raw: 'Raw takes',
  broll: 'B-roll',
  music: 'Music',
  images: 'Images',
  exports: 'Finished videos'
}

export const isVideo = (p: string): boolean => VIDEO_EXT.has(extname(p).toLowerCase())

export async function listLibrary(): Promise<LibraryBin[]> {
  const out: LibraryBin[] = []
  // Finished videos first: "where did my video go?" is the question people bring here (grandma test).
  const keys = Object.keys(BIN_FOLDERS) as BinKey[]
  const order = ['exports' as BinKey, ...keys.filter((k) => k !== 'exports')]
  for (const key of order) {
    const dir = binDir(key)
    const files = []
    let names: string[] = []
    try {
      names = await fs.readdir(dir)
    } catch {
      /* not created yet */
    }
    for (const name of names) {
      if (name.startsWith('.') || /\.(tmp|part)$/i.test(name)) continue
      const p = join(dir, name)
      const st = await fs.stat(p).catch(() => null)
      if (!st?.isFile()) continue
      files.push({ name, path: p, url: await libraryMediaUrl(p, st.mtimeMs), size: st.size, modifiedAt: st.mtime.toISOString() })
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    out.push({ key, label: LABELS[key], dir, files })
  }
  return out
}

/** A Library file's URL. A symlink the person put in a Library folder may point anywhere; its target is
 * theirs to show, so it is registered with the media protocol (which serves nothing else outside the
 * Reel Studio folder). */
export async function libraryMediaUrl(p: string, bust?: number): Promise<string> {
  if (binForFolder(p) !== null && (await fs.lstat(p).catch(() => null))?.isSymbolicLink()) {
    const target = await fs.realpath(p).catch(() => null)
    if (target) allowLinkedMedia(p, target)
  }
  return mediaUrl(p, bust)
}

export function binForFolder(dest: string): BinKey | null {
  const parent = resolve(dirname(dest))
  for (const key of Object.keys(BIN_FOLDERS) as BinKey[]) {
    if (resolve(binDir(key)) === parent) return key
  }
  return null
}

/** Next free name in a folder: "song.mp3", "song (2).mp3", ... */
export function uniqueDest(dir: string, name: string): string {
  let dest = join(dir, name)
  const ext = extname(name)
  const stem = basename(name, ext)
  for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stem} (${i})${ext}`)
  return dest
}

/** Extension-only sorting, used if the engine's classify is unavailable. */
export async function classifyByExtension(files: string[]): Promise<DropResult[]> {
  const out: DropResult[] = []
  for (const file of files) {
    const ext = extname(file).toLowerCase()
    const name = basename(file)
    const bin: BinKey | null = VIDEO_EXT.has(ext) ? 'broll' : AUDIO_EXT.has(ext) ? 'music' : IMAGE_EXT.has(ext) ? 'images' : null
    if (!bin) {
      out.push({ file, name, bin: null, dest: null, reason: 'This is not a video, song or picture, so I left it where it was.' })
      continue
    }
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile()) {
      out.push({ file, name, bin: null, dest: null, reason: 'I could not open this file.' })
      continue
    }
    await fs.mkdir(binDir(bin), { recursive: true })
    const dest = uniqueDest(binDir(bin), name)
    await fs.copyFile(file, dest)
    out.push({ file, name, bin, dest })
  }
  return out
}

/** Sorts dropped files into the Library with the engine's classifier; falls back to extensions. */
export async function addToLibrary(files: string[], runEngine: RunEngine, log: (s: string) => void): Promise<DropResult[]> {
  if (!files.length) return []
  // Folders and files that are already in the Library are not copied again.
  const lib = resolve(libraryDir())
  const todo: string[] = []
  const out: DropResult[] = []
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null)
    if (!st) out.push({ file: f, name: basename(f), bin: null, dest: null, reason: 'I could not find this file.' })
    else if (st.isDirectory()) out.push({ file: f, name: basename(f), bin: null, dest: null, reason: 'This is a folder. Open it and drop the files inside.' })
    else if (resolve(f).startsWith(lib)) out.push({ file: f, name: basename(f), bin: binForFolder(f), dest: f })
    else todo.push(f)
  }
  if (!todo.length) return out
  try {
    const res: any = await runEngine('classify', ['--root', reelStudioRoot(), ...todo])
    const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.files) ? res.files : []
    if (list.length !== todo.length) throw new Error(`classify returned ${list.length} results for ${todo.length} files`)
    for (const r of list) {
      const dest = typeof r.dest === 'string' ? r.dest : null
      out.push({
        file: String(r.file ?? ''),
        name: basename(String(r.file ?? '')),
        bin: dest ? binForFolder(dest) : null,
        dest,
        reason: dest ? undefined : String(r.reason ?? r.userMessage ?? 'I could not sort this file.')
      })
    }
    return out
  } catch (e) {
    log(`[library] engine classify failed, sorting by file type: ${JSON.stringify(e)}`)
    return [...out, ...(await classifyByExtension(todo))]
  }
}
