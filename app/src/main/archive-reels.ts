// Reels from the whole footage archive (tracker raw-to-many-reels). The editor reads every indexed file's lines
// (engine footage digest) and proposes reels, each a few spans of one to three files (ai propose-archive.ts). The
// proposal is kept in the app's settings folder, not in any reel. A pick makes a new reel from those files, and its
// cut is the spans as time-based clips (project.json cut.keep clip items), so its first edit starts from them and
// stays inside them (ai editor.ts proposedReel). The person's files are never changed.
import { existsSync, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
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
  /** file: the position of the file in the reel's sources, in the order they were copied in (s1, s2, …) */
  spans: { file: number; t0: number; t1: number }[]
  /** the files' own names, for the editor's brief */
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
}

export interface ArchiveDeps {
  jobs: Pick<JobManager, 'start'>
  /** the AI as it is now (index.ts assigns it after startup) */
  ai: () => Pick<AI, 'active' | 'proposeFromArchive'>
  runEngine: RunEngine
  root: () => string
  /** where the proposal is kept (the app's settings folder) */
  file: () => string
  /** Library/... or Footage/<folder>/<file> to the file on disk; throws a user error when it can't be reached */
  resolve: (ref: string) => Promise<string>
  /** index.ts startFirstEdit */
  startFirstEdit: (slug: string, init: { title: string; files: string[] }) => string
}

export function createArchiveReels(deps: ArchiveDeps) {
  let finding: { jobId: string; message: string } | null = null
  let failed: string | null = null

  const read = async (): Promise<Stored | null> => {
    try {
      return JSON.parse(await fs.readFile(deps.file(), 'utf8')) as Stored
    } catch {
      return null
    }
  }

  async function status(): Promise<ArchiveStatus> {
    const s = await read()
    return {
      state: finding ? 'finding' : failed ? 'error' : 'idle',
      message: finding?.message ?? failed ?? undefined,
      jobId: finding?.jobId,
      candidates: (s?.candidates ?? []).map((c) => ({ ...c, made: s!.made[c.id] ?? null })),
      notes: s?.notes ?? '',
      truncated: !!s?.truncated,
      at: s?.at ?? null
    }
  }

  /** Starts the editor's look across the footage; nothing is written until it answers. */
  async function find(): Promise<{ jobId: string }> {
    if (finding) return { jobId: finding.jobId }
    const ai = deps.ai()
    const active = await ai.active().catch(() => null)
    if (!active?.connected || active.id === 'none' || !ai.proposeFromArchive) {
      throw { code: 'NO_AI', userMessage: 'Connect an editor to find reels in your footage.' }
    }
    const propose = ai.proposeFromArchive.bind(ai)
    failed = null
    const jobId = deps.jobs.start(null, 'propose', async (emit, signal) => {
      try {
        const say = (message: string) => {
          if (finding) finding.message = message
        }
        say('Reading what your footage says')
        const digest = (await deps.runEngine('footage', ['digest', '--root', deps.root()], undefined, signal)) as {
          files?: { ref: string; name: string; duration: number; lines: { s: number; e: number; text: string }[] }[]
          truncated?: boolean
        }
        const files = Array.isArray(digest?.files) ? digest.files : []
        if (!files.length) {
          throw { code: 'NO_FOOTAGE', userMessage: 'None of your footage has been read yet. Add a footage folder, or videos to your Library, and try again once they are read.' }
        }
        say('Finding reels in your footage')
        const found = await propose({ files }, signal, (e) => {
          if (e.type === 'status' && e.message) say(e.message)
          emit(e)
        })
        if (signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
        const stored: Stored = { at: new Date().toISOString(), candidates: found.candidates, notes: found.notes, made: {}, truncated: !!digest.truncated }
        await writeJson(deps.file(), stored)
        const n = found.candidates.length
        return { summary: n === 0 ? "I didn't find a reel that stands on its own in your footage." : n === 1 ? 'I found one reel in your footage.' : `I found ${n} reels in your footage.` }
      } catch (e) {
        failed = (e as { userMessage?: string })?.userMessage ?? 'Finding reels stopped. Try again.'
        throw e
      } finally {
        finding = null
      }
    })
    finding = { jobId, message: 'Reading what your footage says' }
    return { jobId }
  }

  /** A reel from each pick, in the proposal's order. A file that can't be reached (an unplugged drive) refuses that
   * reel with the reason, before anything is made for it. */
  async function make(ids: string[]): Promise<{ made: { id: string; slug: string }[] }> {
    const s = await read()
    if (!s) throw { code: 'PROPOSAL_GONE', userMessage: 'Find reels in your footage first.' }
    const picks = s.candidates.filter((c) => ids.includes(c.id))
    if (picks.length !== ids.length) throw { code: 'PROPOSAL_GONE', userMessage: "That reel isn't in the list any more. Find reels again." }
    if (picks.some((c) => s.made[c.id])) throw { code: 'ALREADY_MADE', userMessage: 'That reel is made already. Open it from Reels.' }
    const made: { id: string; slug: string }[] = []
    for (const c of picks) {
      const refs = [...new Set(c.spans.map((x) => x.ref))]
      const files = await Promise.all(refs.map((r) => deps.resolve(r)))
      const seed: ArchiveSeed = {
        candidate: c.id, title: c.title, hook: c.hook, why: c.why,
        spans: c.spans.map((x) => ({ file: refs.indexOf(x.ref), t0: x.t0, t1: x.t1 })),
        names: files.map((f) => basename(f))
      }
      const slug = await uniqueSlug(c.title)
      await updateAppState(slug, (st) => {
        st.status = 'working'
        st.title = c.title
        st.createdAt = new Date().toISOString()
        st.fromArchive = seed
      })
      s.made[c.id] = slug
      await writeJson(deps.file(), s)
      deps.startFirstEdit(slug, { title: c.title, files })
      made.push({ id: c.id, slug })
    }
    return { made }
  }

  return { status, find, make }
}

export type ArchiveReels = ReturnType<typeof createArchiveReels>

/** The clips an archive pick's reel is cut from: its spans in order, each on the source its file was copied to. */
export function clipsFromSeed(seed: Pick<ArchiveSeed, 'spans'>): { clip: string; source: string; in: number; out: number }[] {
  return seed.spans.map((x, i) => ({ clip: `c${i + 1}`, source: `s${x.file + 1}`, in: x.t0, out: x.t1 }))
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
  const known = new Set((p.sources ?? []).map((x) => x.id))
  const keep = clipsFromSeed(seed)
  if (keep.some((k) => !known.has(k.source))) throw { code: 'SOURCES_CHANGED', userMessage: "This reel's videos didn't copy in as proposed. Delete it and make it again from Library." }
  // the shared type names only word ranges; clip items are the engine's other keep shape (schema $defs/clip)
  p.cut = { ...p.cut, keep: keep as unknown as NonNullable<ProjectJson['cut']>['keep'] }
  p.proposal = { title: seed.title, hook: seed.hook, why: seed.why, archive: true, files: seed.names, candidate: seed.candidate }
  await writeProject(slug, p)
  await updateAppState(slug, (st) => void st.chat.push(stamp({ from: 'editor', text: `This reel comes from your footage: ${seed.names.join(', ')}.` })))
}
