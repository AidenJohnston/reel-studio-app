// The shared Library: <Reel Studio>/Library/{Raw takes,B-roll,Music,Images,Exports}, plus the bundled sound effects.
import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { BIN_FOLDERS, binDir, fontsDir, libraryDir, reelStudioRoot, sfxPackDir, type BinKey } from './paths'
import { fontNames } from './fonts'
import { mediaUrl } from './media-url'
import type { DropResult, LibraryBin, LibraryFile } from '../shared/api'
import type { RunEngine } from './engine'
import { logDuration } from './diagnostics'
import { isInside } from './path-inside'

// .3gp too: the engine reads it (probe.py VIDEO_EXT), and a footage folder's .3gp clip must be importable
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.3gp'])
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'])
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic'])
export const FONT_EXT = new Set(['.ttf', '.otf'])

const LABELS: Record<Exclude<BinKey, 'exports'>, string> = {
  raw: 'Videos of you',
  broll: 'Extra clips',
  music: 'Music',
  images: 'Pictures',
  fonts: 'Your fonts'
}

export const isVideo = (p: string): boolean => VIDEO_EXT.has(extname(p).toLowerCase())

/** The licence line of one entry in a folder's credits.json (engine assets.py writes it for pictures it fetched). */
function creditLine(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const { license, creator } = entry as { license?: unknown; creator?: unknown }
  if (typeof license !== 'string' || !license.trim()) return undefined
  return typeof creator === 'string' && creator.trim() ? `${license.trim()} · ${creator.trim()}` : license.trim()
}

/** A folder's credits.json; null when it is there but can't be read, so no picture is called yours by mistake. */
async function readCredits(dir: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await fs.readFile(join(dir, 'credits.json'), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return null
  }
  try {
    const book = JSON.parse(text)
    return book && typeof book === 'object' && !Array.isArray(book) ? book : null
  } catch {
    return null
  }
}

/** Library/<bin> as the Library screen shows it. Finished reels are not listed: they live on Reels (ux-foundation-b.md section 6). */
export async function listLibrary(): Promise<LibraryBin[]> {
  const out: LibraryBin[] = []
  for (const key of ['images', 'broll', 'raw', 'music', 'fonts'] as const) {
    const dir = binDir(key)
    const files: LibraryFile[] = []
    let names: string[] = []
    try {
      names = await fs.readdir(dir)
    } catch {
      /* not created yet */
    }
    const credits = await readCredits(dir)
    for (const name of names) {
      if (name.startsWith('.') || name === 'credits.json' || /\.(tmp|part)$/i.test(name)) continue
      const p = join(dir, name)
      const st = await fs.stat(p).catch(() => null)
      if (!st?.isFile()) continue
      if (key === 'fonts' && !FONT_EXT.has(extname(name).toLowerCase())) continue
      const licence = credits ? creditLine(credits[name]) : 'Licence unknown'
      const font = key === 'fonts' ? await readFontNames(p) : undefined
      if (key === 'fonts' && !font) continue
      files.push({ name, path: p, url: mediaUrl(p, st.mtimeMs), size: st.size, modifiedAt: st.mtime.toISOString(), ...(licence ? { licence } : {}), ...(font ? { font } : {}) })
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    out.push({ key, label: LABELS[key], dir, files })
  }
  out.push(await soundEffects())
  out.push(await fontPack())
  return out
}

async function readFontNames(p: string): Promise<{ family: string; full: string } | undefined> {
  return fontNames(await fs.readFile(p).catch(() => Buffer.alloc(0))) ?? undefined
}

/** The caption fonts that come with Reel Studio (packaging/fonts, all SIL Open Font License; SOURCES.md there). */
async function fontPack(): Promise<LibraryBin> {
  const dir = fontsDir()
  const files: LibraryFile[] = []
  for (const name of dir ? (await fs.readdir(dir).catch(() => [])).sort() : []) {
    if (!FONT_EXT.has(extname(name).toLowerCase())) continue
    const p = join(dir!, name)
    const st = await fs.stat(p)
    const font = await readFontNames(p)
    if (!font) continue
    files.push({ name, path: p, url: mediaUrl(p, st.mtimeMs), size: st.size, modifiedAt: st.mtime.toISOString(), licence: 'SIL Open Font License', font })
  }
  return { key: 'fontpack', label: 'Come with Reel Studio', dir: dir ?? '', files }
}

interface PackSound {
  job: string
  file: string
  seconds: number
  source: string
}

/** "qubodup on Freesound", "Kenney": who made a pack sound, from its source page. */
function packAuthor(source: string): string {
  const u = new URL(source)
  if (u.hostname.endsWith('freesound.org')) return `${u.pathname.split('/')[2]} on Freesound`
  if (u.hostname.endsWith('kenney.nl')) return 'Kenney'
  return u.hostname
}

/** The sound effects that come with Reel Studio (engine/reelengine/sfx, all CC0). They are not a folder of yours. */
async function soundEffects(): Promise<LibraryBin> {
  const dir = sfxPackDir()
  const pack = JSON.parse(await fs.readFile(join(dir, 'pack.json'), 'utf8')) as { sounds: PackSound[] }
  const files: LibraryFile[] = []
  for (const s of pack.sounds) {
    const p = join(dir, s.file)
    const st = await fs.stat(p)
    files.push({
      name: s.file,
      path: p,
      url: mediaUrl(p),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      licence: `CC0 · ${packAuthor(s.source)}`,
      durationSec: s.seconds,
      group: s.job
    })
  }
  return { key: 'sfx', label: 'Sound effects', dir, files }
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
      out.push({ file, name, bin: null, dest: null, reason: 'This is not a video, song or picture, so it was left where it was.' })
      continue
    }
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile()) {
      out.push({ file, name, bin: null, dest: null, reason: 'This file could not be opened.' })
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
export async function addToLibrary(files: string[], runEngine: RunEngine, log: (s: string) => void, onAdded?: () => void): Promise<DropResult[]> {
  const finish = (results: DropResult[]): DropResult[] => {
    if (results.some((r) => r.dest && r.dest !== r.file &&
      (VIDEO_EXT.has(extname(r.dest).toLowerCase()) || AUDIO_EXT.has(extname(r.dest).toLowerCase())))) onAdded?.()
    return results
  }
  if (!files.length) return []
  // Folders and files that are already in the Library are not copied again.
  const lib = resolve(libraryDir())
  const todo: string[] = []
  const out: DropResult[] = []
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null)
    if (!st) out.push({ file: f, name: basename(f), bin: null, dest: null, reason: 'This file could not be found.' })
    else if (st.isDirectory()) out.push({ file: f, name: basename(f), bin: null, dest: null, reason: 'This is a folder. Open it and drop the files inside.' })
    else if (isInside(resolve(f), lib)) out.push({ file: f, name: basename(f), bin: binForFolder(f), dest: f })
    else todo.push(f)
  }
  for (const f of todo.filter((t) => FONT_EXT.has(extname(t).toLowerCase()))) {
    const ok = !!fontNames(await fs.readFile(f).catch(() => Buffer.alloc(0)))
    if (!ok) {
      out.push({ file: f, name: basename(f), bin: null, dest: null, reason: 'This font file could not be read.' })
      continue
    }
    await fs.mkdir(binDir('fonts'), { recursive: true })
    const dest = uniqueDest(binDir('fonts'), basename(f))
    await fs.copyFile(f, dest)
    out.push({ file: f, name: basename(f), bin: 'fonts', dest })
  }
  todo.splice(0, todo.length, ...todo.filter((t) => !FONT_EXT.has(extname(t).toLowerCase())))
  if (!todo.length) return finish(out)
  try {
    const res: any = await logDuration(`[library] classify fileCount=${todo.length}`, log, () =>
      runEngine('classify', ['--root', reelStudioRoot(), ...todo])
    )
    const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.files) ? res.files : []
    if (list.length !== todo.length) throw new Error(`classify returned ${list.length} results for ${todo.length} files`)
    for (const r of list) {
      const dest = typeof r.dest === 'string' ? r.dest : null
      out.push({
        file: String(r.file ?? ''),
        name: basename(String(r.file ?? '')),
        bin: dest ? binForFolder(dest) : null,
        dest,
        reason: dest ? undefined : String(r.reason ?? r.userMessage ?? 'This file could not be sorted.')
      })
    }
    return finish(out)
  } catch (e) {
    log(`[library] engine classify failed, sorting by file type: ${JSON.stringify(e)}`)
    return finish([...out, ...(await classifyByExtension(todo))])
  }
}
