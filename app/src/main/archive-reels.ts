// Reels from the whole footage archive (tracker raw-to-many-reels). The editor reads every indexed video's lines
// (engine footage digest) and proposes reels, each a few spans of one to three files (ai propose-archive.ts). The
// proposal is kept in the app's settings folder, not in any reel. A pick makes a new reel from those files, and its
// cut is the spans as time-based clips (project.json cut.keep clip items), so its first edit starts from them and
// stays inside them (ai editor.ts proposedReel). The person's files are never changed.
import { existsSync, promises as fs } from 'node:fs'
import { basename, join, sep } from 'node:path'
import type { AI, ArchiveCandidate } from './ai-types'
import type { RunEngine } from './engine'
import type { JobManager } from './jobs'
import { projectDir, readAppState, readProject, stamp, uniqueSlug, updateAppState, writeJson, writeProject } from './store'
import type { ArchiveStatus, ProjectJson } from '../shared/api'

/** app.json `fromArchive`: what a reel made from an archive pick is seeded with once its copy is in. */
export interface ArchiveSeed {
  candidate: string
  title: string
  hook: string
  why: string
  /** file: the position of the file in the reel's sources, in the order they were copied in (s1, s2, …; the copy
   * keeps that order, index.ts startFirstEdit passes engine init --keep-order) */
  spans: { file: number; t0: number; t1: number }[]
  /** the files' own names in that order: the editor's brief, and the check that the copy kept the order */
  names: string[]
}

interface Stored {
  at: string
  candidates: ArchiveCandidate[]
  notes: string
  /** candidate id -> the reel made from it */
  made: Record<string, string>
  /** the index had more lines than one proposal reads (engine footage digest) */
  truncated: boolean
  /** ref -> the indexed content the editor read, so a file swapped since is never cut by these times */
  hashes: Record<string, string>
}

interface DigestFile { ref: string; name: string; hash: string; duration: number; lines: { s: number; e: number; text: string }[] }

export interface ArchiveDeps {
  /** get: the job's `done` settles when it ends, however it ends */
  jobs: Pick<JobManager, 'start'> & { get: (id: string) => { done: Promise<void> } | undefined }
  /** the AI as it is now (index.ts assigns it after startup) */
  ai: () => Pick<AI, 'active' | 'proposeFromArchive'>
  runEngine: RunEngine
  root: () => string
  /** where the proposal is kept (the app's settings folder) */
  file: () => string
  /** Library/... or Footage/<folder>/<file> to the file on disk; throws a user error when it can't be reached */
  resolve: (ref: string) => Promise<string>
  /** index.ts startFirstEdit; throws when the job can't start (another job on it, the app quitting) */
  startFirstEdit: (slug: string, init: { title: string; files: string[] }) => string
}

const SOURCES_CHANGED = { code: 'SOURCES_CHANGED', userMessage: "This reel's videos didn't copy in as proposed. Delete it and make it again from Library." }

export function createArchiveReels(deps: ArchiveDeps) {
  // the look running now; cleared when its job ends, however it ends (a Stop before it began included)
  let search: { jobId: string; message: string } | null = null
  // a look being started: a second Find meanwhile joins it rather than starting another
  let starting: Promise<{ jobId: string }> | null = null
  let failed: string | null = null

  const read = async (): Promise<Stored | null> => {
    try {
      return JSON.parse(await fs.readFile(deps.file(), 'utf8')) as Stored
    } catch {
      return null
    }
  }

  const digest = async (args: string[], signal?: AbortSignal): Promise<{ files: DigestFile[]; truncated: boolean }> => {
    const r = (await deps.runEngine('footage', ['digest', '--root', deps.root(), ...args], undefined, signal)) as { files?: DigestFile[]; truncated?: boolean }
    return { files: Array.isArray(r?.files) ? r.files : [], truncated: !!r?.truncated }
  }

  async function status(): Promise<ArchiveStatus> {
    const s = await read()
    return {
      state: search ? 'finding' : failed ? 'error' : 'idle',
      message: search?.message ?? failed ?? undefined,
      jobId: search?.jobId,
      candidates: (s?.candidates ?? []).map((c) => ({ ...c, made: s!.made[c.id] ?? null })),
      notes: s?.notes ?? '',
      truncated: !!s?.truncated,
      at: s?.at ?? null
    }
  }

  /** Starts the editor's look across the footage; nothing is written until it answers. */
  function find(): Promise<{ jobId: string }> {
    if (search) return Promise.resolve({ jobId: search.jobId })
    starting ??= begin().finally(() => {
      starting = null
    })
    return starting
  }

  async function begin(): Promise<{ jobId: string }> {
    const ai = deps.ai()
    const active = await ai.active().catch(() => null)
    if (!active?.connected || active.id === 'none' || !ai.proposeFromArchive) {
      throw { code: 'NO_AI', userMessage: 'Connect an editor to find reels in your footage.' }
    }
    const propose = ai.proposeFromArchive.bind(ai)
    failed = null
    const mine = { jobId: '', message: 'Reading what your footage says' }
    const jobId = deps.jobs.start(null, 'propose', async (emit, signal) => {
      try {
        const found = await digest([], signal)
        if (!found.files.length) {
          throw { code: 'NO_FOOTAGE', userMessage: 'None of your footage has been read yet. Add a footage folder, or videos to your Library, and try again once they are read.' }
        }
        mine.message = 'Finding reels in your footage'
        const files = found.files.map(({ ref, name, duration, lines }) => ({ ref, name, duration, lines }))
        const r = await propose({ files }, signal, (e) => {
          if (e.type === 'status' && e.message) mine.message = e.message
          emit(e)
        })
        if (signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
        const hashes = Object.fromEntries(found.files.map((f) => [f.ref, f.hash]))
        const stored: Stored = { at: new Date().toISOString(), candidates: r.candidates, notes: r.notes, made: {}, truncated: found.truncated, hashes }
        await writeJson(deps.file(), stored)
        const n = r.candidates.length
        return { summary: n === 0 ? "I didn't find a reel that stands on its own in your footage." : n === 1 ? 'I found one reel in your footage.' : `I found ${n} reels in your footage.` }
      } catch (e) {
        const code = (e as { code?: string })?.code
        if (code !== 'CANCELLED') failed = (e as { userMessage?: string })?.userMessage ?? 'Finding reels stopped. Try again.'
        throw e
      }
    })
    mine.jobId = jobId
    search = mine
    const over = (): void => {
      if (search === mine) search = null
    }
    const done = deps.jobs.get(jobId)?.done
    if (done) void done.then(over, over)
    else over()
    return { jobId }
  }

  /** A reel from each pick, in the proposal's order. Every pick is checked first: a file that can't be reached (an
   * unplugged drive) or isn't the one the editor read refuses them all, with the reason, before anything is made. */
  async function make(ids: string[]): Promise<{ made: { id: string; slug: string }[] }> {
    const s = await read()
    if (!s) throw { code: 'PROPOSAL_GONE', userMessage: 'Find reels in your footage first.' }
    const picks = s.candidates.filter((c) => ids.includes(c.id))
    if (picks.length !== ids.length) throw { code: 'PROPOSAL_GONE', userMessage: "That reel isn't in the list any more. Find reels again." }
    if (picks.some((c) => s.made[c.id])) throw { code: 'ALREADY_MADE', userMessage: 'That reel is made already. Open it from Reels.' }

    const refs = [...new Set(picks.flatMap((c) => c.spans.map((x) => x.ref)))]
    const where = new Map(await Promise.all(refs.map(async (r) => [r, await deps.resolve(r)] as const)))
    const now = new Map((await digest(refs.flatMap((r) => ['--ref', r]))).files.map((f) => [f.ref, f.hash]))
    const changed = refs.find((r) => !s.hashes?.[r] || now.get(r) !== s.hashes[r])
    if (changed) throw { code: 'FOOTAGE_CHANGED', userMessage: `${basename(changed)} changed since your editor read it. Find reels again.` }

    const made: { id: string; slug: string }[] = []
    for (const c of picks) {
      const order = [...new Set(c.spans.map((x) => x.ref))]
      const files = order.map((r) => where.get(r)!)
      const seed: ArchiveSeed = {
        candidate: c.id, title: c.title, hook: c.hook, why: c.why,
        spans: c.spans.map((x) => ({ file: order.indexOf(x.ref), t0: x.t0, t1: x.t1 })),
        names: files.map((f) => basename(f))
      }
      const slug = await uniqueSlug(c.title)
      // copyFrom with it: a quit before the job records it still leaves a reel that copies in on Resume
      await updateAppState(slug, (st) => {
        st.status = 'working'
        st.title = c.title
        st.createdAt = new Date().toISOString()
        st.fromArchive = seed
        st.copyFrom = files
      })
      // made before its job starts, so a quit at any point after leaves the pick marked and its reel on Reels to
      // Resume, never a second reel from it
      s.made[c.id] = slug
      try {
        await writeJson(deps.file(), s)
        deps.startFirstEdit(slug, { title: c.title, files })
      } catch (e) {
        // never started: no reel is left behind, and the pick can be made again
        delete s.made[c.id]
        await writeJson(deps.file(), s).catch(() => undefined)
        await fs.rm(projectDir(slug), { recursive: true, force: true })
        throw e
      }
      made.push({ id: c.id, slug })
    }
    return { made }
  }

  return { status, find, make }
}

export type ArchiveReels = ReturnType<typeof createArchiveReels>

/** A Library/... ref the engine's digest named, as the real file on disk: refused when it is gone, is not a file,
 * or leads outside the Library (a `..`, a link). */
export async function libraryRef(ref: string, library: string): Promise<string> {
  const gone = { code: 'FILE_GONE', userMessage: `${basename(ref.replace(/\\/g, '/'))} is not in your Library any more.` }
  const m = /^Library\/(.+)$/.exec(ref.replace(/\\/g, '/'))
  const parts = m ? m[1].split('/') : []
  if (!m || parts.some((p) => p === '..' || p === '' || p === '.')) throw gone
  try {
    const base = await fs.realpath(library)
    const real = await fs.realpath(join(base, ...parts))
    if (!real.startsWith(base + sep) || !(await fs.stat(real)).isFile()) throw gone
    return real
  } catch {
    throw gone
  }
}

/** The clips an archive pick's reel is cut from: its spans in order, each on the source its file was copied to,
 * kept inside that copy's length (the index rounds times; a part well past the end is not this file). */
export function clipsFromSeed(seed: Pick<ArchiveSeed, 'spans'>, sources: { id: string; duration?: number }[]): { clip: string; source: string; in: number; out: number }[] {
  return seed.spans.map((x, i) => {
    const src = sources[x.file]
    const end = src?.duration ?? 0
    if (!src || x.t0 >= end || x.t1 > end + 0.5) throw SOURCES_CHANGED
    return { clip: `c${i + 1}`, source: src.id, in: Math.max(0, x.t0), out: Math.min(x.t1, end) }
  })
}

/**
 * After the copy of an archive pick's files (index.ts startFirstEdit): the spans as its cut and what it is about,
 * once. A resume finds them there and leaves them.
 */
export async function seedFromArchive(slug: string): Promise<void> {
  const seed = (await readAppState(slug)).fromArchive
  if (!seed || !existsSync(join(projectDir(slug), 'project.json'))) return
  const p = await readProject(slug)
  if (p.proposal) return
  const sources = p.sources ?? []
  // each part names its file by position, so the copy must hold exactly those files in that order
  if (sources.length !== seed.names.length || sources.some((x, i) => x.originalName !== seed.names[i])) throw SOURCES_CHANGED
  const keep = clipsFromSeed(seed, sources)
  // the shared type names only word ranges; clip items are the engine's other keep shape (schema $defs/clip)
  p.cut = { ...p.cut, keep: keep as unknown as NonNullable<ProjectJson['cut']>['keep'] }
  p.proposal = { title: seed.title, hook: seed.hook, why: seed.why, archive: true, files: seed.names, candidate: seed.candidate }
  await writeProject(slug, p)
  await updateAppState(slug, (st) => void st.chat.push(stamp({ from: 'editor', text: `This reel comes from your footage: ${seed.names.join(', ')}.` })))
}
