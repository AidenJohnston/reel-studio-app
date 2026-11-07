// Footage folders (tracker media-drive): a folder or drive of someone's videos, indexed where it is (engine
// footage.py index --source) and watched for new files. Nothing is copied until a clip is used: importFootage puts
// that one file in the Library, so the editor's paths stay inside the project and the Library (ai/src/safety.ts).
// A folder that goes away (a drive unplugged) keeps its index and shows as not plugged in until it comes back.
import { createHash } from 'node:crypto'
import { promises as fs, realpathSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { FootageSource } from '../shared/api'
import { VIDEO_EXT } from './library'
import { isInside } from './path-inside'

export interface SavedSource {
  id: string
  path: string
  addedAt: string
}

/** What the last index run said about each folder (engine index's `places`). */
export interface PlaceCount {
  id: string
  files: number
  online: boolean
}

type Watch = (path: string, listener: (event: string, file: string | null) => void) => Pick<FSWatcher, 'close' | 'on'>

export interface SourcesDeps {
  load(): Promise<SavedSource[]>
  save(sources: SavedSource[]): Promise<void>
  /** the Reel Studio folder: a footage folder may not hold it or sit inside it */
  root(): string
  /** something changed that the index should read: a folder added or removed, new files, a drive back */
  changed(): void
  watch?: Watch
  /** how often an unplugged folder is looked for; also catches a drive whose watcher never fired */
  pollMs?: number
  /** debounce for watcher events: a copy of many files is one index run */
  settleMs?: number
}

const bad = (code: string, userMessage: string) => ({ code, userMessage })

/** A folder's id, from its path (engine SOURCE_ID): the same folder added again is the same source. */
export function sourceId(folder: string): string {
  return 'src-' + createHash('sha256').update(canon(folder)).digest('hex').slice(0, 16)
}

/** The folder as the file system knows it: links followed, and lower case where names ignore case (Windows, macOS). */
function canon(p: string): string {
  let real = resolve(p)
  try {
    real = realpathSync.native(real)
  } catch {
    /* not there: compared as written */
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real
}

const inside = (child: string, parent: string): boolean => isInside(canon(child), canon(parent))

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function createFootageSources(deps: SourcesDeps) {
  const watch: Watch = deps.watch ?? ((p, listener) => fsWatch(p, { recursive: true, persistent: false }, listener))
  const watchers = new Map<string, Pick<FSWatcher, 'close' | 'on'>>()
  let saved: SavedSource[] | null = null
  let counts = new Map<string, PlaceCount>()
  const online = new Map<string, boolean>()
  let poll: ReturnType<typeof setInterval> | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const all = async (): Promise<SavedSource[]> => (saved ??= await deps.load())

  const soon = (): void => {
    clearTimeout(settle)
    settle = setTimeout(() => deps.changed(), deps.settleMs ?? 4000)
  }

  function arm(s: SavedSource): void {
    if (stopped || watchers.has(s.id) || !isFolder(s.path)) return
    try {
      const w = watch(s.path, (_event, file) => {
        if (!file || VIDEO_EXT.has(extname(file).toLowerCase())) soon()
      })
      // an unplugged drive ends its watcher with an error; the poll finds it again
      w.on('error', () => disarm(s.id))
      watchers.set(s.id, w)
    } catch {
      /* a folder that can't be watched is still read on each poll */
    }
  }

  function disarm(id: string): void {
    watchers.get(id)?.close()
    watchers.delete(id)
  }

  let polls = 0
  /** Looks at every folder once: one that came back or went away re-reads the index. A plugged-in folder that can't
   * be watched (some network drives) is read every fourth look, and every folder every twentieth, since a watcher
   * on some file systems registers and then never reports a change. */
  async function check(): Promise<void> {
    let moved = false
    polls++
    for (const s of await all()) {
      const now = isFolder(s.path)
      if (online.has(s.id) && online.get(s.id) !== now) moved = true
      online.set(s.id, now)
      if (now) arm(s)
      else disarm(s.id)
      if (now && (polls % 20 === 0 || (polls % 4 === 0 && !watchers.has(s.id)))) moved = true
    }
    if (moved) deps.changed()
  }

  async function list(): Promise<FootageSource[]> {
    return (await all()).map((s) => {
      const c = counts.get(s.id)
      return { id: s.id, path: s.path, name: basename(s.path) || s.path, online: isFolder(s.path), files: c ? c.files : null, addedAt: s.addedAt }
    })
  }

  return {
    list,
    /** Starts watching, and looks for unplugged folders every pollMs. */
    async start(): Promise<void> {
      stopped = false
      await check()
      poll = setInterval(() => void check(), deps.pollMs ?? 15_000)
      poll.unref?.()
    },
    stop(): void {
      stopped = true
      clearInterval(poll)
      clearTimeout(settle)
      for (const id of [...watchers.keys()]) disarm(id)
    },

    async add(folder: string): Promise<FootageSource[]> {
      const path = resolve(folder)
      if (!isFolder(path)) throw bad('NOT_FOLDER', 'That is not a folder. Choose the folder your videos are in.')
      const root = deps.root()
      if (inside(path, root)) throw bad('INSIDE_LIBRARY', 'That folder is part of Reel Studio already. Choose a folder of your own videos.')
      if (inside(root, path)) throw bad('HOLDS_LIBRARY', 'That folder holds your Reel Studio folder. Choose the folder your videos are in.')
      const current = await all()
      const id = sourceId(path)
      if (current.some((s) => s.id === id)) throw bad('ALREADY_ADDED', `${basename(path) || path} is added already.`)
      const near = current.find((s) => inside(path, s.path) || inside(s.path, path))
      if (near) throw bad('OVERLAPS', `That folder overlaps ${basename(near.path) || near.path}, which is added already. Remove it first, or choose another folder.`)
      saved = [...current, { id, path, addedAt: new Date().toISOString() }]
      await deps.save(saved)
      online.set(id, true)
      arm(saved[saved.length - 1])
      deps.changed()
      return list()
    },

    /** The folder's files stay where they are; its index entries go with the next run. */
    async remove(id: string): Promise<FootageSource[]> {
      const current = await all()
      if (!current.some((s) => s.id === id)) throw bad('NOT_ADDED', 'That folder was removed already.')
      saved = current.filter((s) => s.id !== id)
      await deps.save(saved)
      disarm(id)
      online.delete(id)
      counts.delete(id)
      deps.changed()
      return list()
    },

    /** engine footage index arguments for every folder, plugged in or not (index keeps an unplugged one's work) */
    async indexArgs(): Promise<string[]> {
      return (await all()).flatMap((s) => ['--source', `${s.id}=${s.path}`])
    },

    /** The last index run's per-folder counts. */
    indexed(places: PlaceCount[]): void {
      counts = new Map(places.map((p) => [p.id, p]))
    },

    /**
     * Footage/<id>/<rel>, as engine search names a file in a footage folder, to the file on disk. Refused when the
     * folder was removed or is unplugged, or the path leaves the folder.
     */
    async resolve(ref: string): Promise<{ abs: string; source: SavedSource }> {
      const m = /^Footage\/(src-[0-9a-f]{8,32})\/(.+)$/.exec(String(ref ?? '').replace(/\\/g, '/'))
      if (!m) throw bad('BAD_FOOTAGE_PATH', 'That is not a clip from one of your footage folders.')
      const source = (await all()).find((s) => s.id === m[1])
      if (!source) throw bad('FOLDER_REMOVED', 'That footage folder was removed. Add it again in Library to use its clips.')
      if (!isFolder(source.path)) throw bad('FOLDER_OFFLINE', `Plug in ${basename(source.path) || source.path} to use this clip.`)
      const parts = m[2].split('/')
      if (parts.some((p) => p === '..' || p === '' || p === '.')) throw bad('BAD_FOOTAGE_PATH', 'That clip is outside its footage folder.')
      const abs = join(source.path, ...parts)
      const real = await fs.realpath(abs).catch(() => null)
      const base = await fs.realpath(source.path)
      if (!real || !isInside(real, base)) throw bad('FILE_GONE', `${basename(abs)} is not in ${basename(source.path)} any more.`)
      if ((await fs.lstat(abs)).isSymbolicLink() || !(await fs.stat(real)).isFile()) throw bad('FILE_GONE', `${basename(abs)} is not in ${basename(source.path)} any more.`)
      if (!VIDEO_EXT.has(extname(abs).toLowerCase())) throw bad('BAD_FOOTAGE_PATH', 'Only videos are read from footage folders.')
      return { abs: real, source }
    },

  }
}

export type FootageSources = ReturnType<typeof createFootageSources>
