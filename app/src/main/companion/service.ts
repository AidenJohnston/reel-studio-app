// What a paired device's calls do, and what goes back: the desktop's own project reads and note path, turned into
// shared/contract.ts shapes that carry no path on this computer. No Electron imports; index.ts hands in the pieces
// (the same functions its IPC handlers call), tests hand in fakes.
import { realpathSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import type { JobEvent, NoteMoment, ProjectDetail, ProjectSummary } from '../../shared/api'
import {
  BadRequest, mediaRef, parseMediaRef, type AppInfoDto, type ChatLineDto, type ContractEvent, type JobDto, type Method, type NoteArgs,
  type NoteResult, type ReelDto, type ReelSummaryDto, type Results, type Scope, type VersionDto
} from '../../shared/contract'
import { checkMoment } from '../../shared/moments'
import { versionChanges } from '../../shared/versions'
import { pathFromMediaUrl } from '../media-url'

export interface ServiceDeps {
  list(): Promise<ProjectSummary[]>
  /** projects:get's answer, running job included. */
  get(slug: string): Promise<ProjectDetail>
  projectDir(slug: string): string
  /** projects:note's handler: (slug, text, attachments, moment, onVersion). */
  note(slug: string, text: string, attachments: undefined, moment: NoteMoment | undefined, onVersion: number | undefined): Promise<{ jobId: string | null; queued?: boolean }>
  cancel(jobId: string, slug: string): Promise<void>
  timeline(slug: string, n: number): Promise<{ duration: number; words: { id: string; w: string; s: number; e: number }[] } | null>
  editorConnected(): Promise<boolean>
  installationId(): Promise<string>
  appVersion: string
  computer: string
}

/** The chat lines a device sees: enough to follow a conversation about a reel, small enough for a phone. */
export const CHAT_LINES = 40
/** Note answers kept for a retry with the same request id. In memory: a retry after the app restarted runs again. */
const REPLAYS_MAX = 500
const REPLAY_KEEP_MS = 30 * 60_000
/** How long a ref's file stays looked up, so a video's range requests don't each reread the reel. */
const MEDIA_CACHE_MS = 20_000

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

export const summaryDto = (s: ProjectSummary): ReelSummaryDto => ({
  id: s.slug,
  title: s.title,
  status: s.status,
  latest: s.version,
  cover: s.thumbnail ? mediaRef('thumb', s.slug) : null,
  updatedAt: s.updatedAt,
  waiting: s.waiting
})

export function jobDto(job: ProjectDetail['job']): JobDto | null {
  if (!job) return null
  return { id: job.id, message: job.message, overall: job.overall, secondsLeft: job.secondsLeft, waiting: job.waiting || job.waitingForRender }
}

export function reelDto(d: ProjectDetail): ReelDto {
  const changes = versionChanges(d.versions, d.versionsMade)
  const versions: VersionDto[] = d.versions.map((v) => ({
    n: v.n,
    parent: v.parent,
    video: mediaRef('video', d.slug, v.n),
    cover: v.cover ? mediaRef('cover', d.slug, v.n) : null,
    createdAt: v.createdAt,
    draft: v.draft,
    change: changes.get(v.n) ?? ''
  }))
  const chat: ChatLineDto[] = d.chat
    .filter((m) => m.text.trim() && !m.plan && !m.reels)
    .slice(-CHAT_LINES)
    .map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at, version: m.version ?? null, moment: m.moment?.at ?? null }))
  return { ...summaryDto(d), versions, chat, job: jobDto(d.job), error: d.lastError?.userMessage ?? null }
}

/** A desktop job event as a device sees it, or null for what devices don't follow. */
export function contractEvent(channel: string, payload: unknown): ContractEvent | null {
  if (channel === 'queue:change') return typeof payload === 'string' ? { type: 'changed', project: payload } : null
  if (channel !== 'job:event') return null
  const e = payload as JobEvent
  if (!e || typeof e !== 'object' || !e.slug) return null
  switch (e.type) {
    case 'status':
      return { type: 'job', project: e.slug, job: { id: e.jobId, message: e.message, overall: e.overall, secondsLeft: e.secondsLeft, waiting: e.waiting || e.waitingForRender }, done: false }
    case 'done':
    case 'error':
    case 'cancelled':
      return { type: 'job', project: e.slug, job: null, done: true }
    case 'render':
    case 'reply':
    case 'paused':
      return { type: 'changed', project: e.slug }
    default:
      return null
  }
}

const forbidden = (): never => {
  throw { code: 'FORBIDDEN', userMessage: 'This device can watch only. Pair it again in Reel Studio with notes allowed.' }
}

export function createCompanionService(deps: ServiceDeps) {
  const replays = new Map<string, { at: number; answer: Promise<NoteResult> }>()
  const media = new Map<string, { at: number; found: { file: string; name: string } | null }>()

  async function note(device: string, slug: string, a: NoteArgs): Promise<NoteResult> {
    const key = `${device}:${slug}:${a.requestId}`
    const t = Date.now()
    for (const [k, r] of replays) {
      if (t - r.at < REPLAY_KEEP_MS && replays.size <= REPLAYS_MAX) break
      replays.delete(k)
    }
    const seen = replays.get(key)
    if (seen) return { ...(await seen.answer), replayed: true }
    const answer = (async (): Promise<NoteResult> => {
      let moment: NoteMoment | undefined
      if (a.at !== undefined && a.version !== undefined) {
        // The words are rebuilt from the render either way (checkMoment); the handler checks the moment again.
        const c = checkMoment({ at: a.at, version: a.version, words: ['w0'], quote: '' }, await deps.timeline(slug, a.version))
        if ('refuse' in c) throw { code: 'BAD_MOMENT', userMessage: c.refuse }
        moment = c.moment
      }
      const r = await deps.note(slug, a.text, undefined, moment, a.version)
      return { jobId: r.jobId, queued: !!r.queued, replayed: false }
    })()
    replays.set(key, { at: t, answer })
    // A refused note can be sent again with the same id once it's fixed (a typo in the moment, no words there).
    answer.catch(() => replays.delete(key))
    return answer
  }

  return {
    async call<M extends Method>(device: { id: string; scopes: Scope[] }, method: M, args: unknown[]): Promise<Results[M]> {
      const has = (s: Scope): boolean => device.scopes.includes(s)
      switch (method) {
        case 'app.info': {
          const info: AppInfoDto = {
            version: deps.appVersion,
            contract: 1,
            computer: deps.computer,
            installationId: await deps.installationId(),
            scopes: [...device.scopes],
            editor: await deps.editorConnected()
          }
          return info as Results[M]
        }
        case 'projects.list':
          // A planned reel with no video yet has nothing to watch or note; its planning chat stays on the computer.
          return (await deps.list()).filter((s) => !s.noVideo).map(summaryDto) as Results[M]
        case 'projects.get':
          return reelDto(await deps.get(args[0] as string)) as Results[M]
        case 'projects.note':
          if (!has('note')) forbidden()
          return (await note(device.id, args[0] as string, args[1] as NoteArgs)) as Results[M]
        case 'jobs.cancel':
          if (!has('note')) forbidden()
          await deps.cancel(args[1] as string, args[0] as string)
          return null as Results[M]
        default:
          throw new BadRequest('unknown method')
      }
    },

    /**
     * The file a ref names, or null. The ref only picks among files the reel's own detail lists, and the file must
     * really sit inside that reel's folder (symlinks resolved), so no request names a path.
     */
    async mediaFile(ref: string): Promise<{ file: string; type: string; name: string } | null> {
      const cached = media.get(ref)
      let found: { file: string; name: string } | null
      if (cached && Date.now() - cached.at < MEDIA_CACHE_MS) found = cached.found
      else {
        found = await locate(ref).catch(() => null)
        media.set(ref, { at: Date.now(), found })
        if (media.size > 200) media.delete(media.keys().next().value!)
      }
      if (!found) return null
      const ext = extname(found.file).toLowerCase()
      const type = TYPES[ext]
      return type ? { file: found.file, type, name: found.name + ext } : null
    }
  }

  /** The file and a name to save it under ("My reel, version 3"). */
  async function locate(ref: string): Promise<{ file: string; name: string } | null> {
    const r = parseMediaRef(ref)
    if (!r) return null
    const d = await deps.get(r.project)
    const name = r.n === null ? d.title : `${d.title}, version ${r.n}`
    let path: string | null = null
    if (r.kind === 'thumb') path = d.thumbnail ? pathFromMediaUrl(d.thumbnail) : null
    else {
      const v = d.versions.find((x) => x.n === r.n)
      if (v) path = r.kind === 'video' ? v.videoPath : v.cover ? pathFromMediaUrl(v.cover) : null
    }
    if (!path) return null
    const root = realpathSync.native(resolve(deps.projectDir(r.project)))
    const real = realpathSync.native(resolve(path))
    return real.startsWith(root.endsWith(sep) ? root : root + sep) ? { file: real, name } : null
  }
}

export type CompanionService = ReturnType<typeof createCompanionService>
