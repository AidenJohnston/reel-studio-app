// "Learn from my past edits" lists the Final Cut Pro and Premiere Pro edits and CapCut projects already on this
// computer, so the person ticks them instead of hunting through a file dialog (Sam opened that dialog twice and
// cancelled both). DaVinci Resolve keeps projects in its own database, so only its FCPXML exports are found (as
// Final Cut Pro's; the engine tells them apart when it reads one) and an EDL is chosen by hand.
// On a Mac Spotlight finds them anywhere it indexes, external drives included; a walk of the usual folders runs
// on every system, so a Mac with Spotlight off, and Windows, still find what sits where the editors save.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import type { PastEdit, PastEditKind } from '../shared/api'

/** How much one look may do, so a home folder full of files can't hold the sheet up. Each bound is checked, and
 * reaching one marks the result `cut`, which the sheet says in one line rather than losing edits silently. There is
 * no evidence behind the numbers beyond keeping a look to a few seconds on a large home folder; they are not tuned. */
export interface Limits {
  /** Directory entries the folder walk reads. */
  walk: number
  /** Paths taken from each Spotlight query. */
  spotlight: number
  /** .xml files opened, newest first, to see whether Premiere Pro wrote them. */
  sniff: number
  /** File reads in flight at once. */
  concurrency: number
}
export const LIMITS: Limits = { walk: 20_000, spotlight: 5_000, sniff: 400, concurrency: 16 }

interface Stat {
  mtimeMs: number
  size: number
  isDirectory(): boolean
}

export interface FindDeps {
  platform: NodeJS.Platform
  home: string
  /** At most `max` paths Spotlight matches for a query, `cut` when it had more or ran out of time; null when
   * Spotlight can't be asked (not a Mac, or it failed). */
  spotlight: ((query: string, max: number) => Promise<{ paths: string[]; cut: boolean } | null>) | null
  limits?: Partial<Limits>
  /** The file reads, for tests; the real file system otherwise. */
  fs?: { stat(path: string): Promise<Stat | null>; head(path: string, bytes: number): Promise<string | null> }
}

/** What one look found, newest first, and whether a limit stopped it before it had looked everywhere. */
export interface Look {
  edits: Found[]
  cut: boolean
}

/** A found edit with the path main keeps; the page gets the PastEdit part, never the path. */
export interface Found extends PastEdit {
  path: string
}

const KIND: Record<string, { kind: PastEditKind; app: PastEdit['app']; folder: boolean }> = {
  '.fcpxml': { kind: 'fcpxml', app: 'Final Cut Pro', folder: false },
  '.fcpxmld': { kind: 'fcpxmld', app: 'Final Cut Pro', folder: true },
  '.fcpbundle': { kind: 'fcpbundle', app: 'Final Cut Pro', folder: true },
  '.prproj': { kind: 'prproj', app: 'Premiere Pro', folder: false },
  '.xml': { kind: 'premiere-xml', app: 'Premiere Pro', folder: false }
}
/** A CapCut project is a folder named for it; its edit is draft_content.json, or draft_info.json on a Mac. */
const DRAFT = /^draft_(content|info)\.json$/i
const CAPCUT = { kind: 'capcut', app: 'CapCut', folder: false } as const
const kindOf = (path: string) => (DRAFT.test(basename(path)) ? CAPCUT : KIND[extname(path).toLowerCase()])
/** Where CapCut keeps projects, below the home folder (macOS Movies, Windows AppData\Local). The folder under it
 * is not skipped for being in AppData or Library. */
const CAPCUT_DIR = join('CapCut', 'User Data', 'Projects', 'com.lveditor.draft')
const IN_CAPCUT = /[\\/]CapCut[\\/]User Data[\\/]Projects[\\/]com\.lveditor\.draft[\\/]/i

/** What the engine's import-reference reads; a library or a Premiere project needs an XML export first. */
const READABLE = new Set<PastEditKind>(['fcpxml', 'fcpxmld', 'premiere-xml', 'capcut'])

// Folders the walk starts from, under the home folder. Final Cut Pro keeps libraries in Movies; Premiere Pro keeps
// projects in Documents\Adobe\Premiere Pro\<version>; exports land wherever the person saved them, usually below.
const START: Record<'darwin' | 'other', string[]> = {
  darwin: ['Movies', 'Documents', 'Desktop', 'Downloads'],
  other: ['Videos', 'Documents', 'Desktop', 'Downloads', join('OneDrive', 'Documents'), join('OneDrive', 'Desktop'), join('AppData', 'Local', CAPCUT_DIR)]
}
const DEPTH = 5
const XML_MAX_BYTES = 64 * 1024 * 1024
// Folders that never hold an edit the person made: app data, packages of other apps, caches and the editors'
// own backups and auto-saves (copies of a project already listed).
const SKIP_DIR = /^(\.|node_modules$|Library$|AppData$|Applications$|\$RECYCLE\.BIN$|Adobe Premiere Pro (Auto-Save|Video Previews|Audio Previews)$|Media Cache( Files)?$|Final Cut Backups)/i
const PACKAGE = /\.(app|photoslibrary|imovielibrary|tvlibrary|musiclibrary|bundle|framework|lrdata|lrcat-data)$/i
const SYSTEM = /^\/(System|Library|Applications|private|usr|opt|bin|sbin|cores|dev)\//
// a path inside another package or bundle (an Info.fcpxml in a .fcpxmld, a project inside a library)
const INSIDE = /\.(fcpxmld|fcpbundle|prproj|app|photoslibrary|bundle)[\\/]/i

const SPOTLIGHT_QUERIES = [
  ['fcpxml', 'fcpxmld', 'fcpbundle', 'prproj'].map((x) => `kMDItemFSName == "*.${x}"c`).join(' || '),
  `kMDItemFSName == "*.xml"c && kMDItemFSSize < ${XML_MAX_BYTES}`,
  'kMDItemFSName == "draft_content.json" || kMDItemFSName == "draft_info.json"'
]

export const idOf = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 16)

function excluded(path: string, home: string): boolean {
  if (INSIDE.test(path) || /[\\/]\.Trash(es)?[\\/]/.test(path)) return true
  // CapCut's own folder sits in AppData or Library; below it, its recycle bin and backups are still left out
  if (IN_CAPCUT.test(path)) return path.split(IN_CAPCUT)[1].split(/[\\/]/).some((part) => SKIP_DIR.test(part))
  const rel = relative(home, path)
  return rel.startsWith('..') ? SYSTEM.test(path) : rel.split(sep).some((part) => SKIP_DIR.test(part))
}

/** Where it is, in words: the folder below the home folder ("Movies › Exports"), or the drive and folder. */
function whereOf(path: string, home: string): string {
  const parent = dirname(path)
  const rel = relative(home, parent)
  if (!rel) return 'Home folder'
  const parts = rel.startsWith('..') ? parent.replace(/^\/Volumes\//, '').split(/[\\/]+/).filter(Boolean) : rel.split(sep)
  return parts.join(' › ')
}

async function walk(home: string, platform: NodeJS.Platform, budget: number): Promise<{ hits: string[]; cut: boolean }> {
  const hits: string[] = []
  const queue: { dir: string; depth: number }[] = START[platform === 'darwin' ? 'darwin' : 'other'].map((d) => ({ dir: join(home, d), depth: 0 }))
  // runs on past the budget only to see whether anything was left unread: the first entry over it is a cut
  while (queue.length) {
    const { dir, depth } = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (budget-- <= 0) return { hits, cut: true }
      const full = join(dir, e.name)
      const ext = extname(e.name).toLowerCase()
      if (e.isDirectory()) {
        if (KIND[ext]?.folder) hits.push(full)
        else if (depth < DEPTH && !SKIP_DIR.test(e.name) && !PACKAGE.test(e.name)) queue.push({ dir: full, depth: depth + 1 })
      } else if (e.isFile() && kindOf(full) && !kindOf(full).folder) hits.push(full)
    }
  }
  return { hits, cut: false }
}

const realFs: NonNullable<FindDeps['fs']> = {
  stat: (path) => stat(path).catch(() => null),
  async head(path, bytes) {
    const fh = await open(path, 'r').catch(() => null)
    if (!fh) return null
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, bytes, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  }
}

/** fn over every item, at most `limit` at a time, results in item order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Every edit found, newest first. Paths that vanish or can't be read between finding and looking are left out. */
export async function findPastEdits(deps: FindDeps): Promise<Look> {
  const lim = { ...LIMITS, ...deps.limits }
  const fs = deps.fs ?? realFs
  let cut = false
  const fromSpotlight: string[] = []
  for (const q of deps.spotlight ? SPOTLIGHT_QUERIES : []) {
    const got = await deps.spotlight!(q, lim.spotlight)
    if (!got) continue
    // a Spotlight that ignores max is held to it too
    cut ||= got.cut || got.paths.length > lim.spotlight
    fromSpotlight.push(...got.paths.slice(0, lim.spotlight))
  }
  const walked = await walk(deps.home, deps.platform, lim.walk)
  cut ||= walked.cut
  const paths = [...new Set([...fromSpotlight, ...walked.hits])].filter((p) => kindOf(p) && !excluded(p, deps.home))
  const seen = await mapLimit(paths, lim.concurrency, async (path) => {
    const st = await fs.stat(path)
    const k = kindOf(path)
    return st && st.isDirectory() === k.folder ? { path, st, k } : null
  })
  // one row per CapCut project: draft_content.json where both are there
  const drafts = new Set(seen.filter((x) => x?.k.kind === 'capcut').map((x) => x!.path))
  const twin = (p: string) => /draft_info\.json$/i.test(p) && drafts.has(join(dirname(p), 'draft_content.json'))
  const candidates = seen.filter((x): x is NonNullable<typeof x> => x !== null && !twin(x.path)).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  // XML is everywhere; only the newest are opened to see whether Premiere Pro wrote them
  const xml = candidates.filter((c) => c.k.kind === 'premiere-xml' && c.st.size <= XML_MAX_BYTES)
  if (xml.length > lim.sniff) cut = true
  const premiere = new Set(
    (
      await mapLimit(xml.slice(0, lim.sniff), lim.concurrency, async (c) =>
        // FCP7 XML, which Premiere Pro writes for File › Export › Final Cut Pro XML: `<xmeml version="4">`
        /<xmeml[\s>]/.test((await fs.head(c.path, 2048)) ?? '') ? c.path : null
      )
    ).filter(Boolean)
  )
  const edits = candidates
    .filter((c) => c.k.kind !== 'premiere-xml' || premiere.has(c.path))
    .map(({ path, st, k }) => ({
      id: idOf(path),
      path,
      // a CapCut project by its folder's name, and the lesson's name for it (main style-learn.ts nameOf)
      name: k.kind === 'capcut' ? basename(dirname(path)) : basename(path, extname(path)),
      file: k.kind === 'capcut' ? `${basename(dirname(path))}/${basename(path)}` : basename(path),
      where: k.kind === 'capcut' && IN_CAPCUT.test(path) ? 'CapCut' : whereOf(k.kind === 'capcut' ? dirname(path) : path, deps.home),
      app: k.app,
      kind: k.kind,
      modified: new Date(st.mtimeMs).toISOString(),
      readable: READABLE.has(k.kind)
    }))
  return { edits, cut }
}

/** Spotlight through `mdfind`, stopped once it has listed more than `max` paths or after 8 s; null when it fails,
 * so the walk decides. */
export function mdfind(query: string, max: number): Promise<{ paths: string[]; cut: boolean } | null> {
  return new Promise((resolve) => {
    const child = spawn('mdfind', [query], { stdio: ['ignore', 'pipe', 'ignore'] })
    const paths: string[] = []
    let rest = ''
    let done = false
    const finish = (out: { paths: string[]; cut: boolean } | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      resolve(out)
    }
    const timer = setTimeout(() => finish({ paths: paths.slice(0, max), cut: true }), 8000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) if (line) paths.push(line)
      if (paths.length > max) finish({ paths: paths.slice(0, max), cut: true })
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      const all = [...paths, ...(rest ? [rest] : [])]
      finish(code === 0 ? { paths: all.slice(0, max), cut: all.length > max } : null)
    })
  })
}

/** The engine's reference-scan result, paired back to the edits by path. */
export function countsOf(found: Found[], scanned: unknown): Record<string, { timelines: number } | { problem: string }> {
  const files = (scanned as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) throw new Error('reference-scan returned no files list')
  const byPath = new Map(found.map((f) => [f.path, f.id]))
  const out: Record<string, { timelines: number } | { problem: string }> = {}
  for (const f of files as { path?: unknown; timelines?: unknown; error?: { message?: unknown } }[]) {
    const id = typeof f.path === 'string' ? byPath.get(f.path) : undefined
    if (!id) continue
    if (typeof f.timelines === 'number') out[id] = { timelines: f.timelines }
    else if (typeof f.error?.message === 'string') out[id] = { problem: f.error.message }
  }
  return out
}
