// Project store: folders on disk under <Reel Studio>/Projects (docs/architecture.md section 3).
// project.json belongs to the engine and the AI. The app keeps its own small state
// (chat history, running job, last error) in app.json next to it.
import { existsSync, promises as fs } from 'node:fs'
import { join, basename, dirname, extname, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BIN_FOLDERS, binDir, noteStagingDir, projectsDir, libraryDir, reelStudioRoot } from './paths'
import type {
  ChatMessage,
  PausedFor,
  ChecklistItem,
  EditFact,
  NoteAttachment,
  NoteOutcome,
  ProjectDetail,
  ProjectJson,
  ProjectSummary,
  ScreenStatus,
  ReelPlan,
  StoredProposal,
  ScriptResult,
  VersionInfo,
  VersionMade,
  Word,
  JobKind,
  QueuedNote
} from '../shared/api'
import { mediaUrl } from './media-url'
import { COPY_GONE, POSTER, canCopyAgain } from './first-video'
import type { ReelSeed } from './propose-reels'
import type { ArchiveSeed } from './archive-reels'
import { replyChat, styleConsent, type ChatLine } from './style-consent'
import { keptIds } from '../shared/cut'
import { readCaptionLines } from '../shared/subtitle-lines'
import { versionMessage } from '../shared/describe'
import { planAsScript } from '../shared/plan'
export { keptIds, rangesFromKept, rangesKeepingOrder } from '../shared/cut'

export interface AppState {
  chat: ChatMessage[]
  /** `noteId`: what a note job saves its note under in project.json.notes (its queue entry's id). */
  job: { id: string; kind: JobKind; startedAt: string; note?: string; noteId?: string } | null
  status: ScreenStatus
  lastError: { code: string; userMessage: string } | null
  /** Title chosen at creation, shown until project.json exists. */
  title?: string
  /** The title made from the video file's name, while the reel may still go by it: another video after a failed
   * Version 1 gives the reel its own file's title only if the reel still has this one (main/first-video.ts). Absent on
   * a reel named some other way, and on reels made before it was kept. */
  fileTitle?: string
  /** When a reel planned before it had a video was made (a reel with a video has project.json's). */
  createdAt?: string
  /** An AI editor made the first edit (false/absent = the simple no-AI edit). */
  aiEdited?: boolean
  /** What made each version, written once when it was made (jobs.ts). Versions made before these records existed have none. */
  versionsMade?: VersionMade[]
  /** Notes sent and not yet saved in project.json, oldest first; the first may be running (main/note-queue.ts). */
  queue?: QueuedNote[]
  /** The queue waits for Resume: after Stop, a failed note, or a restart. */
  queueHeld?: boolean
  /** Paused without you: why, and when it continues on its own (main/pause.ts). Cleared when any job starts. */
  paused?: PausedFor
  /** Each time a version was posted. Insights joins the sidebar once any reel has one (ux-foundation-b.md section 6);
   * posting itself is not built yet (spec.md section 11), so nothing writes this today. */
  posted?: { version: number; platform: 'instagram'; at: string }[]
  /** The plan made before the video: in the planning chat or the plain form (shared/plan.ts checks it). */
  plan?: ReelPlan
  /** The reels the editor last found in this reel's video (main/propose-reels.ts). */
  proposal?: StoredProposal
  /** This reel was made from another reel's proposal: what it is seeded from, kept so a resume can seed it again. */
  from?: ReelSeed
  /** Made from a pick of reels across the footage archive: seeded once its copy is in (main/archive-reels.ts). */
  fromArchive?: ArchiveSeed
  /** The person chose this reel's series (or no series) themselves: automatic grouping leaves it alone (main/series.ts). */
  seriesChosen?: boolean
  /** The files Version 1 copies its video from, kept until the copy is in (project.json written): a first edit stopped
   * during the copy copies them again (main/index.ts startFirstEdit). */
  copyFrom?: string[]
}

const EMPTY_STATE: AppState = { chat: [], job: null, status: 'new', lastError: null }

export async function ensureRoot(): Promise<void> {
  await fs.mkdir(projectsDir(), { recursive: true })
  for (const k of Object.keys(BIN_FOLDERS) as (keyof typeof BIN_FOLDERS)[]) {
    await fs.mkdir(binDir(k), { recursive: true })
  }
}

export function projectDir(slug: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug)) throw new Error(`bad slug: ${slug}`)
  return join(projectsDir(), slug)
}

// ---- titles and slugs -----------------------------------------------------------------------

export function titleFromFile(file: string): string {
  let t = basename(file, extname(file))
    .replace(/[_]+/g, ' ')
    .replace(/(?<=\S)-(?=\S)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Camera and editing leftovers are not a title: dates, IMG_1234, "take 01", "raw", "final".
  const cleaned = t
    .replace(/^(19|20)\d{2} ?\d{2} ?\d{2}( \d{2} ?\d{2}( ?\d{2})?)?(?=\s|$)/, ' ')
    .replace(/^(img|vid|mov|pxl|dsc|gopr|dji) ?\d+(?=\s|$)/i, ' ')
    .replace(/(^|\s)(take ?\d+|raw|final|v\d+|copy|talkinghead|talking head)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  t = /[a-z]{2}/i.test(cleaned) ? cleaned : ''
  if (!t) t = 'My reel'
  if (t.length > 48) t = t.slice(0, 48).replace(/\s+\S*$/, '').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Names Windows keeps for devices, with or without an extension: a folder by one of them can't be made there. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return !s ? 'video' : WINDOWS_DEVICE.test(s) ? `${s}-reel` : s
}

/** A slug for `title`, and its folder, made here: the folder is created exclusively, so two reels made at the same
 * moment with the same title never share one. */
export async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title)
  await fs.mkdir(projectsDir(), { recursive: true })
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`
    try {
      await fs.mkdir(join(projectsDir(), slug))
      return slug
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

// ---- json helpers -----------------------------------------------------------------------------

const WINDOWS_LOCK = ['EPERM', 'EBUSY', 'EACCES']
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Missing or unparseable file -> fallback. A file briefly locked by a writer (Windows) is retried. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  for (let i = 0; ; i++) {
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (WINDOWS_LOCK.includes(code) && i < 40) {
        await sleep(10 + i * 10)
        continue
      }
      return fallback
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }
}

/**
 * Atomic write: a crash mid-write never leaves half a file behind.
 * On Windows a rename over a file that someone is reading fails with EPERM/EBUSY/EACCES for a few
 * milliseconds, so retry before giving up, and never leave the temp file behind.
 */
export async function writeJson(path: string, data: unknown, opts: { durable?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const text = JSON.stringify(data, null, 2) + '\n'
  if (!opts.durable) await fs.writeFile(tmp, text, 'utf8')
  else {
    const fh = await fs.open(tmp, 'w')
    try {
      await fh.writeFile(text, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
  }
  await renameWithRetry(tmp, path, 40, opts.signal)
  if (opts.durable) await syncRename(path)
}

/** Flushes a rename to disk: the folder on macOS/Linux; Windows can't open a folder for this, so the
 * renamed file itself is flushed, which writes its directory entry too. */
async function syncRename(path: string): Promise<void> {
  const fh = await fs.open(process.platform === 'win32' ? path : dirname(path), process.platform === 'win32' ? 'r+' : 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** `signal`: a job's Stop. Checked before each try, so a write Stop reaches in time replaces nothing (the rename is
 * the commit: once it is submitted, the write stands). */
export async function renameWithRetry(from: string, to: string, tries = 40, signal?: AbortSignal): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      if (signal?.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (i >= tries || !WINDOWS_LOCK.includes(code)) {
        await fs.rm(from, { force: true }).catch(() => {})
        throw e
      }
      await sleep(Math.min(250, 10 + i * 10))
    }
  }
}

/** One read-modify-write at a time per file, so two updates never lose each other's change. */
const fileQueues = new Map<string, Promise<unknown>>()
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.catch(() => undefined)
  fileQueues.set(key, tail)
  void tail.then(() => {
    if (fileQueues.get(key) === tail) fileQueues.delete(key)
  })
  return run
}

export function readProject(slug: string): Promise<ProjectJson> {
  const p = join(projectDir(slug), 'project.json')
  return serialized(p, async () => JSON.parse(await fs.readFile(p, 'utf8')) as ProjectJson)
}

export async function writeProject(slug: string, project: ProjectJson, opts: { durable?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  project.updatedAt = new Date().toISOString()
  const file = join(projectDir(slug), 'project.json')
  await serialized(file, () => writeJson(file, project, opts))
}

const STATE_UNREADABLE = { code: 'STATE_UNREADABLE', userMessage: 'I could not read this video\'s notes right now. Try again in a moment.' }

/** Only a missing app.json is an empty one. One that can't be read or parsed throws: reading it as empty
 * would make the next write erase the chat and the waiting notes. */
async function readAppStateNow(file: string): Promise<AppState> {
  if (!existsSync(file)) return { ...EMPTY_STATE, chat: [] }
  const s = await readJson<Partial<AppState> | null>(file, null)
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw STATE_UNREADABLE
  return { ...EMPTY_STATE, ...s, chat: s.chat ?? [] }
}

/** Reads go through the same per-file queue as writes, so our own reads never block a rename. */
export function readAppState(slug: string): Promise<AppState> {
  const file = join(projectDir(slug), 'app.json')
  return serialized(file, () => readAppStateNow(file))
}

/** `durable`: on disk before this resolves (fsync), for writes a creator was told happened (the note queue).
 * A state holding queued notes is always flushed: every write replaces the copy that holds them. */
export function updateAppState(slug: string, fn: (s: AppState) => void, opts: { durable?: boolean } = {}): Promise<AppState> {
  const file = join(projectDir(slug), 'app.json')
  return serialized(file, async () => {
    const s = await readAppStateNow(file)
    fn(s)
    await writeJson(file, s, { durable: opts.durable || !!s.queue?.length })
    return s
  })
}

export async function addChat(
  slug: string,
  from: ChatMessage['from'],
  text: string,
  version?: number,
  actions?: ChatMessage['actions'],
  suggestion?: string,
  attachments?: ChatMessage['attachments'],
  moment?: ChatMessage['moment'],
  proposal?: ChatMessage['proposal'],
  sources?: ChatMessage['sources']
): Promise<string> {
  const id = randomUUID()
  await updateAppState(slug, (s) => {
    // note-atomic's stamp(), with the id change-at-moment returns to the caller (the note's mark)
    s.chat.push({
      ...stamp({
        from, text, version,
        ...(actions?.length ? { actions } : {}), ...(suggestion ? { suggestion } : {}), ...(attachments?.length ? { attachments } : {}),
        ...(moment ? { moment } : {}), ...(proposal ? { proposal } : {}), ...(sources?.length ? { sources } : {})
      }),
      id
    })
  })
  return id
}

/** Records how a note's job ended on the note itself, so its mark never borrows another note's reply. */
export function settleNote(s: AppState, jobId: string, outcome: NoteOutcome): void {
  for (const m of s.chat) if (m.jobId === jobId) m.outcome = outcome
}

export const stamp = (line: ChatLine): ChatMessage => ({ id: randomUUID(), at: new Date().toISOString(), ...line })

// ---- a reel planned before it has a video -----------------------------------------------------

export const PLANNED_TITLE = 'New reel'

/** New reel: a folder with only app.json, "No video yet", until a video is added. */
export async function createPlanned(): Promise<string> {
  await fs.mkdir(projectsDir(), { recursive: true })
  const slug = await uniqueSlug(PLANNED_TITLE)
  await fs.mkdir(projectDir(slug), { recursive: true })
  await updateAppState(slug, (s) => {
    s.status = 'planned'
    s.title = PLANNED_TITLE
    s.createdAt = new Date().toISOString()
  })
  return slug
}

/**
 * A New reel nobody has done anything with: still "New reel", nothing planned or queued, no video and nothing else
 * in its folder. Leaving one, or pressing New reel again, must not leave a pile of empty cards on Reels.
 */
export function isUntouchedPlanned(s: AppState, files: string[]): boolean {
  return (
    s.status === 'planned' &&
    !s.job &&
    s.title === PLANNED_TITLE &&
    s.chat.length === 0 &&
    !s.plan &&
    !s.queue?.length &&
    files.every((f) => f === 'app.json')
  )
}

/** Removes `slug` if it is an untouched New reel and no job runs on it. Read and removal share the app.json lane, so a
 * write that touches it first (a script, a rename, a video) keeps it. */
export async function discardIfUntouched(slug: string, running: (slug: string) => boolean): Promise<boolean> {
  const dir = projectDir(slug)
  return serialized(join(dir, 'app.json'), async () => {
    if (running(slug)) return false
    const files = await fs.readdir(dir).catch(() => null)
    if (!files || !isUntouchedPlanned(await readAppStateNow(join(dir, 'app.json')), files)) return false
    await fs.rm(dir, { recursive: true, force: true })
    return true
  })
}

/** New reel: an untouched one already there is the new reel (⌘N twice opens the same one); otherwise a new one. */
export async function planReel(running: (slug: string) => boolean): Promise<string> {
  const slugs = await fs.readdir(projectsDir()).catch(() => [] as string[])
  for (const slug of slugs) {
    try {
      projectDir(slug)
    } catch {
      continue
    }
    const files = await fs.readdir(projectDir(slug)).catch(() => null)
    if (files && !running(slug) && isUntouchedPlanned(await readAppState(slug), files)) return slug
  }
  return createPlanned()
}

/** The newest script the editor wrote for this reel. */
export function latestScript(s: AppState): ScriptResult | null {
  for (let i = s.chat.length - 1; i >= 0; i--) if (s.chat[i].script) return s.chat[i].script!
  return null
}

/** Once `engine init` has made project.json for a planned reel: its plan, or else the newest script the editor wrote
 * before planning was a chat, goes in as project.json `script`, for the first edit to read (shared/plan.ts planAsScript). */
export async function carryScript(slug: string): Promise<void> {
  const st = await readAppState(slug)
  const script = st.plan ? planAsScript(st.plan) : latestScript(st)
  if (!script) return
  const p = await readProject(slug)
  p.script = script
  await writeProject(slug, p)
}

// ---- versions ---------------------------------------------------------------------------------

/**
 * Records what made a version. jobs.ts calls this only for a number that had no version when the job
 * started, so an older record for it belongs to a version since deleted, and is replaced.
 */
export async function recordVersionMade(slug: string, made: VersionMade): Promise<void> {
  await updateAppState(slug, (s) => {
    s.versionsMade = [...(s.versionsMade ?? []).filter((r) => r.version !== made.version), made]
  })
}

const VIDEO_NAMES = ['export.mp4', 'draft.mp4']

export async function listVersions(dir: string): Promise<VersionInfo[]> {
  const vdir = join(dir, 'versions')
  let names: string[] = []
  let saved: number
  try {
    names = await fs.readdir(vdir)
    saved = Number(JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8')).version) || 0
  } catch {
    return []
  }
  // docs/versions.md: a version is a `vN` folder with `export.mp4`, N up to project.json's `version`
  // (a higher one is a render that was never saved, which the next final render replaces). Drafts
  // live in `versions/preview/` and are overwritten; they only show (as n = 0, "Preview") when no final version exists yet,
  // e.g. when an AI run's final render failed.
  const out: VersionInfo[] = []
  const push = async (n: number, d: string, video: string): Promise<void> => {
    const st = await fs.stat(video)
    const cover = join(d, 'cover.png')
    let parent: number | null = n > 1 ? n - 1 : null
    let parents: [number, number] | undefined
    if (n > 0) {
      let metadata: string | undefined
      try { metadata = await fs.readFile(join(d, 'version.json'), 'utf8') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (metadata !== undefined) {
        const parsed = JSON.parse(metadata)
        const value: unknown = parsed?.parent
        if (n === 1 ? value !== null : typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= n) {
          throw new Error(`Invalid parent for Version ${n}`)
        }
        parent = value as number | null
        if (parsed.parents !== undefined) {
          const pair: unknown = parsed.parents
          if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== parent || pair[0] === pair[1]
            || pair.some((p) => !Number.isSafeInteger(p) || p < 1 || p >= n)) throw new Error(`Invalid parents for Version ${n}`)
          parents = pair as [number, number]
        }
      }
    }
    const receipts = await readJson<{ renderId: string; facts: EditFact[] }[] | null>(join(d, 'receipts.json'), null)
    // a rewording describes the receipts up to the one it names; a later receipt in this folder makes it stale
    const titled = await readJson<{ renderId: string; title: string; summary: string } | null>(join(d, 'title.json'), null)
    // which model made it (main/index.ts recordMadeWith), for its line in the notes
    const made = await readJson<{ model?: unknown } | null>(join(d, 'made-with.json'), null)
    // an engine that records receipts gives every render an id (render_identity.py)
    const manifest = receipts || n === 0 ? null : await readJson<{ renderId?: unknown } | null>(join(d, 'render.json'), null)
    out.push({
      ...(receipts ? { facts: receipts.flatMap((r) => r.facts) } : {}),
      ...(n > 0 && !receipts && typeof manifest?.renderId !== 'string' ? { beforeReceipts: true as const } : {}),
      ...(titled && titled.renderId === receipts?.at(-1)?.renderId ? { wording: { title: titled.title, summary: titled.summary } } : {}),
      ...(typeof made?.model === 'string' && made.model ? { madeWith: made.model.slice(0, 80) } : {}),
      n,
      parent,
      ...(parents ? { parents } : {}),
      video: mediaUrl(video, st.mtimeMs),
      videoPath: video,
      draft: basename(video) !== 'export.mp4',
      cover: existsSync(cover) ? mediaUrl(cover, st.mtimeMs) : null,
      createdAt: st.mtime.toISOString()
    })
  }
  for (const name of names) {
    const m = /^v(\d+)$/.exec(name)
    if (!m || Number(m[1]) > saved) continue
    const d = join(vdir, name)
    const video = join(d, 'export.mp4')
    if (!existsSync(video) || existsSync(join(d, '.rendering'))) continue
    await push(Number(m[1]), d, video)
  }
  if (!out.length) {
    const d = join(vdir, PREVIEW_DIR)
    if (existsSync(join(d, 'draft.mp4')) && !existsSync(join(d, '.rendering'))) await push(0, d, join(d, 'draft.mp4'))
  }
  return out.sort((a, b) => a.n - b.n)
}

/** The engine's scratch folder for drafts (docs/versions.md). */
export const PREVIEW_DIR = 'preview'

/**
 * Removes versions that never finished (crash or quit mid-render, or a note that never saved its
 * final) and stray temp files. A finished version has a video file, no `.rendering` marker, and a
 * number project.json has saved. Runs only in the job lane or at startup, before any job.
 */
export async function cleanPartialVersions(dir: string): Promise<string[]> {
  const removed: string[] = []
  const vdir = join(dir, 'versions')
  let names: string[] = []
  try {
    names = await fs.readdir(vdir)
  } catch {
    return removed
  }
  // a folder up to project.json's version is a saved version, and stays even with a file missing
  // (render.py never encodes into it); one above it is a final no note or render ever saved
  // (docs/versions.md); null: project.json can't be read, so only the files decide
  const p = await readJson<{ version?: unknown } | null>(join(dir, 'project.json'), null)
  const saved = p ? Number(p.version) || 0 : null
  for (const name of names) {
    // The engine's scratch previews (docs/versions.md) are the engine's to overwrite (review 31).
    if (name === PREVIEW_DIR) continue
    const d = join(vdir, name)
    const st = await fs.stat(d).catch(() => null)
    if (!st) continue
    if (!st.isDirectory()) {
      if (/\.(tmp|part)$/i.test(name)) {
        await fs.rm(d, { force: true })
        removed.push(d)
      }
      continue
    }
    const n = /^v(\d+)$/.exec(name)
    const finished =
      !!n &&
      (saved !== null ? Number(n[1]) <= saved : VIDEO_NAMES.some((v) => existsSync(join(d, v))) && !existsSync(join(d, '.rendering')))
    if (!finished) {
      await fs.rm(d, { recursive: true, force: true })
      removed.push(d)
      continue
    }
    for (const f of await fs.readdir(d)) {
      if (/\.(tmp|part)$/i.test(f) || /\.partial\./i.test(f)) {
        await fs.rm(join(d, f), { force: true })
        removed.push(join(d, f))
      }
    }
  }
  return removed
}

/**
 * Called once at startup, before any job can run: a project whose app.json still says a job is
 * running was interrupted (quit, crash, power cut). Clean it up and mark it so the UI can offer
 * to pick up where it left off.
 */
export async function recoverInterrupted(stillRunning: string[] = []): Promise<string[]> {
  const recovered: string[] = []
  let slugs: string[] = []
  try {
    slugs = await fs.readdir(projectsDir())
  } catch {
    return recovered
  }
  for (const slug of slugs) {
    try {
      projectDir(slug) // refuses a folder name that is not a project
    } catch {
      continue
    }
    if (stillRunning.includes(slug)) continue // an engine of the last run may still write there
    if ((await settleInterrupted(slug)) === 'settled') recovered.push(slug)
  }
  return recovered
}

/**
 * Ends a job app.json still records but nothing is running: the app quit or crashed during it, or the
 * write that ends it failed. Runs at startup, before any job, and as the next job on that project
 * begins, so a new job
 * never replaces a marker whose note may already be saved. A note found saved in project.json (by its
 * job id) gets its reply and questions; one that is not gets "send it again". While project.json
 * cannot be read the marker stays for the next try: the note may be saved, and telling the creator
 * to send it again would apply it twice.
 */
export async function settleInterrupted(slug: string): Promise<'settled' | 'unreadable' | 'nothing'> {
  const dir = projectDir(slug)
  if (!existsSync(join(dir, 'app.json'))) return 'nothing'
  const s = await readAppState(slug).catch(() => null)
  if (!s) return 'unreadable'
  if (!s.job) return 'nothing'
  const saved = s.job.kind === 'note' ? await savedNote(dir, s.job.noteId ?? s.job.id) : null
  if (saved === UNREADABLE) return 'unreadable'
  // an Edit it myself change saved just before the app closed: its version is made (hand-edit.ts)
  const hand = s.job.kind === 'rerender' && s.job.noteId ? s.queue?.find((q) => q.id === s.job!.noteId && q.hand) : undefined
  const handSaved = hand ? await readJson<{ version?: number; handEdits?: unknown } | null>(join(dir, 'project.json'), null) : null
  const handVersion = Array.isArray(handSaved?.handEdits) && handSaved.handEdits.includes(hand!.id) ? Number(handSaved.version) : null
  await cleanPartialVersions(dir)
  // a note's private copy and drafts (ai editor.ts applyNote), which it deletes itself unless the app died
  await fs.rm(join(dir, 'work', 'notes'), { recursive: true, force: true })
  await updateAppState(slug, (st) => {
    // a script or a look for more reels writes no version: one cut short changes nothing to finish
    if (st.job?.kind === 'script' || st.job?.kind === 'propose') settleNote(st, st.job.id, 'stopped')
    else st.status = st.job?.kind === 'first-edit' || !existsSync(join(dir, 'versions')) ? 'interrupted' : 'ready'
    if (saved) {
      const reply = saved.reply ?? `I made your change. It is Version ${saved.version}.`
      st.chat.push(...replyChat(styleConsent(reply, saved.styleRulesAdded, saved.styleSuggestions), saved.version).map(stamp))
    } else if (handVersion !== null) {
      st.chat.push(stamp({ from: 'editor', text: versionMessage(handVersion, hand!.text), version: handVersion }))
    } else if (st.queue?.some((q) => q.id === st.job?.noteId)) {
      st.chat.push(stamp({ from: 'editor', text: 'Reel Studio closed before that change was made. It is waiting below. Press Send now when you want it.' }))
    } else if (st.status === 'ready' && st.job?.kind !== 'export') {
      st.chat.push(stamp({ from: 'editor', text: 'Reel Studio closed before that change was finished. Send your note again to make it.' }))
    }
    st.job = null
  })
  return 'settled'
}

interface SavedNote { id?: string; version: number; reply?: string; styleRulesAdded?: string[]; styleSuggestions?: string[] }
const UNREADABLE = Symbol('unreadable')

/** The note a job saved in project.json (ai/src/editor.ts applyNote), null when it is not there. */
async function savedNote(dir: string, jobId: string): Promise<SavedNote | null | typeof UNREADABLE> {
  const p = await readJson<{ notes?: SavedNote[] } | typeof UNREADABLE>(join(dir, 'project.json'), UNREADABLE)
  return p === UNREADABLE ? p : (p.notes?.find((n) => n.id === jobId) ?? null)
}

// ---- transcript and cut ------------------------------------------------------------------------

export async function readWords(dir: string, project: ProjectJson): Promise<Word[]> {
  const file = project.transcript?.file ?? 'work/transcript.json'
  const t = await readJson<{ words?: Word[] }>(join(dir, file), {})
  return Array.isArray(t.words) ? t.words : []
}

// ---- summaries ----------------------------------------------------------------------------------

/**
 * "What I did". Honest about who did what: without an AI editor nothing picked the best takes or
 * wrote the post caption, so those lines say what really happened (grandma test, findings 7 + 12).
 * `songTitle` names a frozen song that has no Library path (see songTitle).
 */
export function checklist(p: ProjectJson, words: Word[], kept: string[], versions: VersionInfo[], aiEdited = false, songTitle?: string): ChecklistItem[] {
  const cutWords = words.length - kept.length
  const caption = (p.post?.caption ?? '').trim()
  const items: ChecklistItem[] = [
    {
      key: 'listen',
      label: 'Listened to your video',
      done: words.length > 0,
      detail: undefined
    },
    // a flipped take is listed with why (when the app flipped it), and the Reel screen offers Undo
    ...(p.sources?.some((s) => s.mirror === true)
      ? [{ key: 'mirror', label: 'Flipped the picture (it was mirrored)', done: true, detail: p.sources.find((s) => s.mirror === true)?.mirrorCheck?.why }]
      : []),
    {
      key: 'cut',
      label: aiEdited ? 'Picked your best takes and cut the pauses' : 'Cut the pauses and repeated starts',
      done: !!p.cut?.keep?.length,
      // A count of cut words read like homework (design critique 1.3); the Reel screen shows the length instead.
      detail: p.cut?.keep?.length && cutWords > 0 ? 'cut' : undefined
    },
    {
      key: 'captions',
      label: p.captions?.enabled === false ? 'No subtitles' : 'Added subtitles',
      done: p.captions?.enabled !== false && !!p.cut?.keep?.length
    },
    {
      key: 'music',
      label: p.music?.track ? 'Added music' : 'No music yet',
      done: !!(p.music?.enabled && p.music?.track),
      detail: p.music?.track ? niceName(songTitle ?? p.music.track) : 'Add a song to your Library to use it'
    },
    {
      key: 'broll',
      label: p.broll?.length ? brollLabel(p.broll) : 'No pictures yet',
      done: !!p.broll?.length
    },
    {
      key: 'cover',
      label: 'Made your cover',
      done: versions.some((v) => v.cover)
    },
    {
      key: 'post',
      label: !caption ? 'Caption: add your own' : aiEdited ? 'Wrote your caption' : 'Your caption',
      done: !!caption
    }
  ]
  return items
}

/**
 * "Added 1 picture, 2 animations and 1 text card": an animation or a text card is not a picture, and
 * calling every one a picture contradicted "your Library had no pictures" (grandma3 #9).
 */
export function brollLabel(broll: NonNullable<ProjectJson['broll']>): string {
  const n = { picture: 0, animation: 0, text: 0 }
  for (const b of broll) {
    if ((b.treatment === 'text-pop' || b.treatment === 'text-behind') && !b.asset) n.text++
    else if (b.treatment === 'animation') n.animation++
    else n.picture++
  }
  const parts: string[] = []
  if (n.picture) parts.push(`${n.picture} ${n.picture === 1 ? 'picture' : 'pictures'}`)
  if (n.animation) parts.push(`${n.animation} ${n.animation === 1 ? 'animation' : 'animations'}`)
  if (n.text) parts.push(`${n.text} ${n.text === 1 ? 'text card' : 'text cards'}`)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  return `Added ${list}`
}

export function niceName(path: string): string {
  const n = basename(path, extname(path)).replace(/[_-]+/g, ' ').trim()
  // "2026 07 29 lofi beat" reads as "lofi beat"; a name that is only a date stays as it is.
  return n.replace(/^(19|20)\d{2} ?\d{2} ?\d{2}\s+(?=\S)/, '') || n
}

/**
 * Version 1 was stopped during its copy (there is no project.json) and nothing can copy it again: the files it copied
 * from can't be opened any more. It reads as failed with COPY_GONE, never as a pause that Resume would continue. A reel
 * seeded from another reel's proposal copies from that reel's video instead (`from`, main/propose-reels.ts).
 */
async function copyGone(st: AppState): Promise<boolean> {
  return st.status === 'interrupted' && !st.job && !st.from && !(await canCopyAgain(st.copyFrom))
}

export async function summary(slug: string): Promise<ProjectSummary | null> {
  const dir = projectDir(slug)
  let p: ProjectJson
  try {
    p = await readProject(slug)
  } catch {
    // A folder without a readable project.json is either being created or broken.
    const st = await readAppState(slug).catch(() => null)
    if (!st || !existsSync(join(dir, 'app.json'))) return null
    const at = st.createdAt ?? new Date().toISOString()
    const gone = await copyGone(st)
    // a script being written keeps a reel with no video planned
    const status: ScreenStatus = gone ? 'failed' : st.job && st.job.kind !== 'script' ? 'working' : st.status === 'ready' ? 'failed' : st.status
    return {
      slug,
      dir,
      title: st.title ?? slug,
      createdAt: at,
      updatedAt: st.chat[st.chat.length - 1]?.at ?? at,
      version: 0,
      // Version 1 failed before the video was copied in: the frame first-video.ts kept of the file
      thumbnail: existsSync(join(dir, POSTER)) ? mediaUrl(join(dir, POSTER)) : null,
      status,
      waiting: (st.queue ?? []).filter((q) => !q.attempt).length,
      noVideo: st.status === 'planned',
      take: null,
      versionAt: null,
      series: null,
      pausedFor: null,
      failedWhy: gone ? COPY_GONE.userMessage : status === 'failed' ? (st.lastError?.userMessage ?? null) : null,
      failedCode: gone ? COPY_GONE.code : status === 'failed' ? (st.lastError?.code ?? null) : null,
      posted: !!st.posted?.length
    }
  }
  const versions = await listVersions(dir)
  // Home still lists a video whose app.json can't be read right now; opening it says so
  const st = await readAppState(slug).catch((): AppState => ({ ...EMPTY_STATE, chat: [] }))
  const last = versions[versions.length - 1]
  const src = p.sources?.[0]
  const srcPath = src && (isAbsolute(src.path) ? src.path : join(dir, ...src.path.split('/')))
  // looking for more reels in it leaves a reel where it is on Home: no version is being made
  const status: ScreenStatus = st.job && st.job.kind !== 'propose'
    ? 'working'
    : versions.length
      ? 'ready'
      : st.status === 'ready'
        ? 'failed'
        : st.status
  return {
    slug,
    dir,
    title: p.title || slug,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    version: last?.n ?? 0,
    thumbnail: last?.cover ?? null,
    status,
    waiting: (st.queue ?? []).filter((q) => !q.attempt).length,
    noVideo: !st.job && !versions.length && !p.sources?.length,
    take: !last?.cover && srcPath && existsSync(srcPath) ? mediaUrl(srcPath) : null,
    versionAt: last?.createdAt ?? null,
    series: typeof p.series === 'string' && p.series.trim() ? p.series.trim() : null,
    pausedFor: st.paused ?? null,
    failedWhy: status === 'failed' ? (st.lastError?.userMessage ?? null) : null,
    failedCode: status === 'failed' ? (st.lastError?.code ?? null) : null,
    posted: !!st.posted?.length
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  let slugs: string[] = []
  try {
    slugs = await fs.readdir(projectsDir())
  } catch {
    return []
  }
  const out: ProjectSummary[] = []
  for (const slug of slugs) {
    try {
      projectDir(slug)
    } catch {
      continue
    }
    const s = await summary(slug).catch(() => null)
    if (s) out.push(s)
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

/** Lower case, accents and punctuation gone: "Crème-brûlée!" -> "creme brulee". */
const searchable = (t: string): string =>
  t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')

/** Each reel's spoken words, kept while its transcript file is unchanged: search reads every reel on each query. */
const spoken = new Map<string, { file: string; mtimeMs: number; words: string }>()

/** What was said in a reel, lower case and without punctuation (searchable). */
export async function spokenWords(slug: string, p: ProjectJson): Promise<string> {
  const dir = projectDir(slug)
  const file = join(dir, p.transcript?.file ?? 'work/transcript.json')
  const st = await fs.stat(file).catch(() => null)
  if (!st) return ''
  const hit = spoken.get(slug)
  if (hit && hit.file === file && hit.mtimeMs === st.mtimeMs) return hit.words
  const words = searchable((await readWords(dir, p)).map((w) => w.w).join(' '))
  spoken.set(slug, { file, mtimeMs: st.mtimeMs, words })
  return words
}

/** Every word of the query starts a word of the reel's title or of what was said in it. */
export async function searchProjects(query: string): Promise<string[]> {
  const terms = searchable(query).split(' ').filter(Boolean)
  if (!terms.length) return []
  const out: string[] = []
  for (const s of await listProjects()) {
    const p = await readProject(s.slug).catch(() => null)
    const words = ` ${searchable(s.title)} ${p ? await spokenWords(s.slug, p) : ''} `
    if (terms.every((t) => words.includes(` ${t}`))) out.push(s.slug)
  }
  return out
}

export async function detail(slug: string): Promise<ProjectDetail> {
  const dir = projectDir(slug)
  const s = await summary(slug)
  if (!s) throw { code: 'NOT_FOUND', userMessage: 'That reel could not be found. It may have been moved or deleted.' }
  const project = await readProject(slug).catch(() => ({}) as ProjectJson)
  const versions = await listVersions(dir)
  const words = await readWords(dir, project)
  const kept = keptIds(words, project.cut?.keep)
  const st = await readAppState(slug)
  const thumb = (a: NoteAttachment): NoteAttachment => attachmentThumb(slug, a)
  // the lines of the saved version (or of the preview before there is one): each render keeps its
  // caption report beside its video (docs/versions.md); a version made before that left it in work/
  const shown = join(dir, 'versions', project.version ? `v${project.version}` : PREVIEW_DIR)
  const captionLines = readCaptionLines(
    (await readJson<unknown>(join(shown, 'captions.json'), null)) ?? (await readJson<unknown>(join(dir, 'work', 'captions.json'), null))
  )
  const brollThumbs: Record<string, string> = {}
  const assets = (project.broll ?? []).map((b) => (typeof b.asset === 'string' ? b.asset : ''))
  const track = project.music?.track ?? ''
  const ledger = assets.some((a) => FROZEN_CLIP.test(a)) || FROZEN_SONG.test(track) ? await readLedger(dir) : []
  const clipSources = new Map(ledger.filter((r) => FROZEN_CLIP.test(r.committedPath) && ATTACHED_CLIP.test(r.intent)).map((r): [string, string] => [r.committedPath, r.intent]))
  for (const [i, b] of (project.broll ?? []).entries()) {
    // a clip the AI placed is its frozen copy; the attachment it was frozen from has the still
    const a = clipSources.get(assets[i]) ?? assets[i]
    // an attached clip or GIF (work/assets/attach-*.mp4) shows the still `engine attach` made of it
    const clip = ATTACHED_CLIP.exec(a)
    if (clip) {
      const t = join(dir, 'work', 'thumbs', `${clip[1]}.jpg`)
      if (existsSync(t)) brollThumbs[b.id] = mediaUrl(t)
      continue
    }
    if (!/\.(png|jpe?g|webp|gif)$/i.test(a)) continue
    const p = a.startsWith('Library/') || isAbsolute(a) ? resolveRootPath(a) : join(dir, ...a.split('/'))
    if (existsSync(p)) brollThumbs[b.id] = mediaUrl(p)
  }
  const brollCredits = await creditsFor(dir, project.broll ?? [])
  // The raw footage, for "hold for Original" and the Working screen's first frame.
  const sourceVideos: Record<string, string> = {}
  for (const src of project.sources ?? []) {
    const p = isAbsolute(src.path) ? src.path : join(dir, ...src.path.split('/'))
    if (existsSync(p)) sourceVideos[src.id] = mediaUrl(p)
  }
  const first = project.sources?.[0]
  return {
    ...s,
    sourceVideo: (first && sourceVideos[first.id]) ?? null,
    sourceVideos,
    project,
    versions,
    words,
    keptIds: kept,
    captionLines,
    brollThumbs,
    brollCredits,
    checklist: checklist(project, words, kept, versions, !!st.aiEdited, songTitle(ledger, track)),
    versionsMade: st.versionsMade ?? [],
    // a note's attached files get a URL for their still here (never stored: the root folder can move)
    // a planning reply's raw provider content stays in main (shared/plan.ts planTurns)
    chat: st.chat.map(({ planRaw: _raw, ...m }) => (m.attachments?.length ? { ...m, attachments: m.attachments.map(thumb) } : m)),
    // a copy that can't be made again says why where the video would be, as its card does
    lastError: s.failedCode === COPY_GONE.code ? COPY_GONE : st.lastError,
    queue: (st.queue ?? []).map((q) => ({ ...q, attachments: q.attachments.map(thumb) })),
    queueHeld: !!st.queueHeld,
    job: st.job ? { id: st.job.id, kind: st.job.kind, message: 'Working on it', pct: 0, overall: 0, secondsLeft: null, overdue: false, thinking: false, waiting: false, waitingForRender: false } : null,
    aiEdited: !!st.aiEdited,
    plan: st.plan ?? null,
    proposal: st.proposal ?? null
  }
}

/** A file attached while a job ran stays in staging until its note runs (attachments.ts). */
function attachmentThumb(slug: string, a: NoteAttachment): NoteAttachment {
  const t = chatThumb(projectDir(slug), a)
  return t.thumbUrl ? t : chatThumb(noteStagingDir(projectDir(slug)), a)
}

const ATTACHED_CLIP = /^work\/assets\/(attach-[a-f0-9]{8}-[a-z0-9-]+)\.(mp4|mov|m4v|webm)$/
const FROZEN_CLIP = /^work\/assets\/frozen\/video\/[0-9a-f]{64}\.[a-z0-9]+$/
const FROZEN_SONG = /^work\/assets\/frozen\/music\/[0-9a-f]{64}\.[a-z0-9]+$/

interface LedgerRecord {
  committedPath: string
  /** provenance.intent: the path (or request) the file was frozen from */
  intent: string
  title: string
}

/** The AI's asset ledger (work/assets/manifest.jsonl), one record per frozen file. Lines that do not
 * parse are skipped: a crash mid-append leaves a torn line. */
async function readLedger(dir: string): Promise<LedgerRecord[]> {
  const text = await fs.readFile(join(dir, 'work', 'assets', 'manifest.jsonl'), 'utf8').catch(() => '')
  const out: LedgerRecord[] = []
  for (const line of text.split('\n')) {
    let r: { committedPath?: unknown; title?: unknown; provenance?: { intent?: unknown } }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof r?.committedPath !== 'string') continue
    out.push({
      committedPath: r.committedPath,
      intent: typeof r.provenance?.intent === 'string' ? r.provenance.intent : '',
      title: typeof r.title === 'string' ? r.title : ''
    })
  }
  return out
}

/**
 * Who each picture is credited to: the person's own (Library, a note's attachment), or the line the engine
 * recorded when it fetched or captured it (credits.json beside the file, or the asset ledger,
 * work/assets/manifest.jsonl). Pictures Reel Studio drew itself (animations, text) have none.
 */
async function creditsFor(dir: string, broll: NonNullable<ProjectJson['broll']>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const books = new Map<string, Record<string, { attribution?: unknown }>>()
  let ledger: { committedPath?: unknown; attribution?: unknown; title?: unknown; creator?: unknown }[] | null = null
  for (const b of broll) {
    const a = typeof b.asset === 'string' ? b.asset : ''
    if (!a || /\.(mov|webm)$/i.test(a)) continue
    if (a.startsWith('Library/')) {
      out[b.id] = 'Yours, from your Library'
      continue
    }
    if (/^work\/assets\/attach-/.test(a)) {
      out[b.id] = 'Yours, attached to a note'
      continue
    }
    const folder = dirname(a)
    if (!books.has(folder)) books.set(folder, await readJson(join(dir, ...folder.split('/'), 'credits.json'), {}))
    const entry = books.get(folder)?.[basename(a)]
    if (typeof entry?.attribution === 'string' && entry.attribution) {
      out[b.id] = entry.attribution
      continue
    }
    ledger ??= (await fs.readFile(join(dir, 'work', 'assets', 'manifest.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return {}
        }
      })
    const known = ledger!.find((x) => x.committedPath === a)
    const line = typeof known?.attribution === 'string' && known.attribution ? known.attribution : [known?.title, known?.creator].filter((x) => typeof x === 'string' && x).join(', by ')
    if (line) out[b.id] = line
  }
  return out
}

/** A song the AI committed from somewhere other than the Library keeps its frozen path in music.track
 * (a Library song keeps its Library path); the checklist names it by its ledger title, not the hash. */
function songTitle(ledger: LedgerRecord[], track: string): string | undefined {
  if (!FROZEN_SONG.test(track)) return undefined
  return ledger.filter((r) => r.committedPath === track && r.title.trim()).at(-1)?.title
}

function chatThumb(dir: string, a: NoteAttachment): NoteAttachment {
  const { thumbUrl: _old, ...rest } = a
  if (typeof a.thumb !== 'string' || !/^work\/thumbs\/attach-[a-z0-9-]+\.jpg$/.test(a.thumb)) return rest
  const p = join(dir, ...a.thumb.split('/'))
  return existsSync(p) ? { ...rest, thumbUrl: mediaUrl(p) } : rest
}

/** Library paths in project.json are relative to the Reel Studio root (docs/architecture.md section 3). */
export function rootRelative(path: string): string {
  const rel = relative(reelStudioRoot(), path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path
  return rel.split('\\').join('/')
}

export function resolveRootPath(path: string): string {
  return isAbsolute(path) ? path : join(reelStudioRoot(), ...path.split('/'))
}

export { libraryDir }
