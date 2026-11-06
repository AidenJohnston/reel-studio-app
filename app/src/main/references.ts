// Reference reels (My style): <Reel Studio root>/References holds references.json, a copy of each reel under files/
// and one still per reel under .posters/. The app writes the readout into references.json with every change, so the
// editor's read_references tool (ai/src/tools.ts) reads the same numbers and sentences the page shows.
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync, promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { serialized, writeJson } from './store'
import { toUserError } from './engine'
import {
  MAX_REFERENCE_SECONDS, REFERENCES_FILE, REFERENCES_FOLDER, VIDEO_EXTENSIONS, checkMeasure, linkPolicy, readEntry, readout, stateOf,
  type Readout, type ReferenceEntry, type ReferenceView
} from '../shared/references'

type RunEngine = (command: string, args: string[], onProgress?: (p: unknown) => void, signal?: AbortSignal) => Promise<any>

export interface ReferenceDeps {
  root: () => string
  runEngine: RunEngine
  /** a reel was measured or failed: the page reads the list again */
  onChange: () => void
  log: (line: string) => void
  /** the page's URL for a still on disk (media-url.ts mediaUrl) */
  mediaUrl: (abs: string, bust?: number) => string
}

export interface ReferenceList {
  references: ReferenceView[]
  readout: Readout
}

const userError = (code: string, userMessage: string) => Object.assign(new Error(userMessage), { code, userMessage })

/** `file` is inside `folder` (not the folder itself). */
const inside = (file: string, folder: string): boolean => {
  const r = relative(resolve(folder), resolve(file))
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}

export function createReferenceLibrary(d: ReferenceDeps) {
  const dir = (): string => join(d.root(), REFERENCES_FOLDER)
  const file = (): string => join(dir(), REFERENCES_FILE)
  const poster = (id: string): string => join(dir(), '.posters', `${id}.jpg`)
  const abs = (e: ReferenceEntry): string | null => (e.file ? join(dir(), ...e.file.split('/')) : null)
  // one read-change-write at a time for references.json
  const serial = <T>(fn: () => Promise<T>): Promise<T> => serialized(`references:${resolve(file())}`, fn)

  /** No file is no references. A file that is not JSON is set aside next to it and the list starts over, so the
   * person can add again; entries it can't read are skipped. */
  async function read(): Promise<ReferenceEntry[]> {
    let text: string
    try {
      text = await fs.readFile(file(), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    let data: unknown
    try {
      data = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      data = null
    }
    const list = (data as { references?: unknown } | null)?.references
    if (!Array.isArray(list)) {
      const aside = join(dir(), `references.damaged ${Date.now()}.json`)
      await fs.rename(file(), aside)
      d.log(`[references] ${REFERENCES_FILE} could not be read; kept as ${basename(aside)}`)
      return []
    }
    return list.map(readEntry).filter((e): e is ReferenceEntry => !!e)
  }

  /** References/ and one folder in it, made if missing. A folder that is a link to somewhere else is refused: the app
   * copies into, writes stills into and deletes from these, and must never do that outside the library folder. */
  async function folder(sub?: 'files' | '.posters'): Promise<string> {
    const top = dir()
    const path = sub ? join(top, sub) : top
    await fs.mkdir(path, { recursive: true })
    const realRoot = await fs.realpath(d.root())
    for (const p of sub ? [top, path] : [top]) {
      if ((await fs.lstat(p)).isSymbolicLink() || !inside(await fs.realpath(p), realRoot)) {
        throw userError('UNSAFE_PATH', `The ${REFERENCES_FOLDER} folder in your library points somewhere else. Remove that link, then try again.`)
      }
    }
    return path
  }

  async function write(entries: ReferenceEntry[]): Promise<void> {
    await folder()
    await writeJson(file(), { version: 1, references: entries, readout: readout(entries) })
  }

  const change = (fn: (entries: ReferenceEntry[]) => ReferenceEntry[] | Promise<ReferenceEntry[]>): Promise<ReferenceEntry[]> =>
    serial(async () => {
      const next = await fn(await read())
      await write(next)
      return next
    })

  // ---- measuring, one reel at a time --------------------------------------------------------------------------
  let measuring: Promise<void> | null = null
  /** the reel the engine has open now: Remove waits for it, since Windows can't delete a file another process holds */
  let current: { id: string; done: Promise<void> } | null = null
  /** reels that failed in this run of the app are not tried again until the person adds them again */
  const failed = new Set<string>()

  function measureSoon(): void {
    measuring ??= (async () => {
      try {
        for (;;) {
          const next = (await serial(read)).find((e) => stateOf(e) === 'measuring' && !failed.has(e.id))
          if (!next) return
          const done = measureOne(next)
          current = { id: next.id, done: done.catch(() => undefined) }
          try {
            await done
          } finally {
            current = null
          }
          d.onChange()
        }
      } finally {
        measuring = null
      }
    })().catch((e) => d.log(`[references] measuring stopped: ${String(e)}`))
  }

  async function measureOne(entry: ReferenceEntry): Promise<void> {
    const src = abs(entry)!
    let patch: Partial<ReferenceEntry>
    try {
      await folder('.posters')
      const m = checkMeasure(await d.runEngine('measure-reel', ['--file', src, '--poster', poster(entry.id)]))
      delete m.poster // the still has a fixed place; a stored path would break when the library folder moves
      patch = { measure: m }
    } catch (e) {
      failed.add(entry.id)
      patch = { problem: toUserError(e).userMessage }
      d.log(`[references] ${entry.id} not measured: ${String((e as Error)?.message ?? e)}`)
    }
    await change((all) => all.map((x) => (x.id === entry.id ? { ...x, ...patch } : x)))
  }

  /** Refuses what is not a video with a picture, or is too long to be a reel. `name`: what the person calls it. */
  async function checkVideo(path: string, name: string): Promise<void> {
    const ext = extname(path).slice(1).toLowerCase()
    if (!(VIDEO_EXTENSIONS as readonly string[]).includes(ext)) throw userError('NOT_VIDEO', `${name} isn't a video. Add an MP4, MOV, M4V, WebM or MKV file.`)
    const info = await d.runEngine('probe', [path])
    if (!(Number(info?.duration) > 0) || !(Number(info?.width) > 0)) throw userError('NOT_VIDEO', `${name} isn't a video Reel Studio can read.`)
    if (Number(info.duration) > MAX_REFERENCE_SECONDS) throw userError('TOO_LONG', `${name} is longer than 10 minutes. Add a reel, or a short part of the video.`)
  }

  /** A copy of `src` in files/, after checking it is a video short enough to be a reel. */
  async function copyIn(src: string, id: string): Promise<string> {
    await checkVideo(src, basename(src))
    const name = `${id}.${extname(src).slice(1).toLowerCase()}`
    await fs.copyFile(src, join(await folder('files'), name), fsConstants.COPYFILE_EXCL)
    return `files/${name}`
  }

  const titleOf = (path: string): string => basename(path, extname(path)).slice(0, 120)

  return {
    dir,

    async list(): Promise<ReferenceList> {
      const entries = await serial(read)
      if (entries.some((e) => stateOf(e) === 'measuring' && !failed.has(e.id))) measureSoon()
      const references = entries.map((e): ReferenceView => {
        const still = poster(e.id)
        const url = e.measure && existsSync(still) ? d.mediaUrl(still) : undefined
        // a reel whose measuring failed in this run reads as a problem even before the file says so
        const state = failed.has(e.id) && !e.measure && !e.problem ? 'problem' : stateOf(e)
        return { ...e, state, ...(url ? { posterUrl: url } : {}) }
      })
      return { references, readout: readout(entries) }
    },

    /** Copies each video in, then measures them in the background. Files it skips come back with the reason. */
    async addFiles(paths: string[]): Promise<{ added: number; skipped: { name: string; reason: string }[] }> {
      const skipped: { name: string; reason: string }[] = []
      const added: ReferenceEntry[] = []
      const before = await serial(read)
      for (const src of paths) {
        const name = basename(src)
        const size = (await fs.stat(src).catch(() => null))?.size
        if (size === undefined) {
          skipped.push({ name, reason: 'That file is not where it was.' })
          continue
        }
        // the same file added twice: same name and size as a copy already kept
        const same = [...before, ...added].find((e) => e.original === name && e.file && existsSync(abs(e)!))
        if (same && (await fs.stat(abs(same)!)).size === size) {
          skipped.push({ name, reason: 'It is already in your reference reels.' })
          continue
        }
        const id = randomUUID()
        try {
          added.push({ id, title: titleOf(src), addedAt: new Date().toISOString(), file: await copyIn(src, id), original: name })
        } catch (e) {
          skipped.push({ name, reason: toUserError(e).userMessage })
        }
      }
      if (added.length) await change((all) => [...added.reverse(), ...all])
      measureSoon()
      return { added: added.length, skipped }
    },

    /** A pasted link. A link straight to a video file is downloaded; any other link is kept, with what to do to add
     * its file (shared/references.ts linkPolicy). */
    async addLink(raw: string): Promise<ReferenceEntry> {
      const policy = linkPolicy(raw)
      if (policy.kind === 'invalid') throw userError('BAD_LINK', policy.why)
      const existing = (await serial(read)).find((e) => e.link?.url === policy.url)
      if (existing) throw userError('ALREADY', 'That link is already in your reference reels.')
      const id = randomUUID()
      const base: ReferenceEntry = { id, title: policy.title.slice(0, 120), addedAt: new Date().toISOString(), link: { url: policy.url, platform: policy.kind === 'ask-file' ? policy.platform : new URL(policy.url).hostname } }
      let entry: ReferenceEntry
      if (policy.kind === 'ask-file') entry = { ...base, needsFile: policy.why }
      else {
        const files = await folder('files')
        const r = await d.runEngine('download-media', ['--url', policy.url, '--kind', 'video', '--dest', files, '--name', id])
        const saved = typeof r?.path === 'string' ? resolve(r.path) : ''
        if (!saved || !inside(saved, files) || !basename(saved).startsWith(`${id}.`)) throw userError('DOWNLOAD_FAILED', 'The download did not finish. Try again, or save the video and add the file.')
        // a downloaded file passes the same checks as a picked one, and goes when it fails them
        try {
          await checkVideo(saved, policy.title)
        } catch (e) {
          await fs.rm(saved, { force: true })
          throw e
        }
        entry = { ...base, file: `files/${basename(saved)}`, original: basename(new URL(policy.url).pathname) }
      }
      await change((all) => [entry, ...all])
      measureSoon()
      return entry
    },

    /** The file for a link the app would not download. */
    async attach(id: string, src: string): Promise<void> {
      const entry = (await serial(read)).find((e) => e.id === id)
      if (!entry) throw userError('NOT_FOUND', 'That reference is not in the list any more.')
      if (entry.file) throw userError('HAS_FILE', 'That reference already has its file.')
      const saved = await copyIn(src, id)
      failed.delete(id)
      await change((all) => all.map((e) => {
        if (e.id !== id) return e
        const { needsFile: _asked, problem: _problem, ...rest } = e
        return { ...rest, file: saved, original: basename(src) }
      }))
      measureSoon()
    },

    /** Takes it out of the list and deletes the app's copy and still. The person's own file is never touched. */
    async remove(id: string): Promise<void> {
      let gone: ReferenceEntry | undefined
      await change((all) => {
        gone = all.find((e) => e.id === id)
        return all.filter((e) => e.id !== id)
      })
      if (!gone) return
      failed.delete(id)
      if (current?.id === id) await current.done
      const copy = abs(gone)
      if (copy) await fs.rm(join(await folder('files'), basename(copy)), { force: true })
      await fs.rm(join(await folder('.posters'), `${id}.jpg`), { force: true })
    },

    async get(id: string): Promise<{ entry: ReferenceEntry; file: string | null } | null> {
      const entry = (await serial(read)).find((e) => e.id === id)
      return entry ? { entry, file: abs(entry) } : null
    }
  }
}

export type ReferenceLibrary = ReturnType<typeof createReferenceLibrary>
