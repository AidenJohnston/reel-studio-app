// Project store: folders on disk under <Reel Studio>/Projects (docs/architecture.md section 3).
// project.json belongs to the engine and the AI. The app keeps its own small state
// (chat history, running job, last error) in app.json next to it.
import { recoverNoteStaging } from './ai'
import { existsSync, promises as fs } from 'node:fs'
import { join, basename, extname, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BIN_FOLDERS, binDir, projectsDir, libraryDir, reelStudioRoot } from './paths'
import type {
  ChatMessage,
  ChecklistItem,
  NoteAttachment,
  ProjectDetail,
  ProjectJson,
  ProjectSummary,
  ScreenStatus,
  VersionInfo,
  Word,
  JobKind
} from '../shared/api'
import { mediaUrl } from './media-url'
import { keptIds } from '../shared/cut'
export { keptIds, rangesFromKept, rangesKeepingOrder } from '../shared/cut'

export interface AppState {
  chat: ChatMessage[]
  job: { id: string; kind: JobKind; startedAt: string; note?: string } | null
  status: ScreenStatus
  lastError: { code: string; userMessage: string } | null
  /** Title chosen at creation, shown until project.json exists. */
  title?: string
  /** An AI editor made the first edit (false/absent = the simple no-AI edit). */
  aiEdited?: boolean
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
  if (!t) t = 'My video'
  if (t.length > 48) t = t.slice(0, 48).replace(/\s+\S*$/, '').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return s || 'video'
}

export async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title)
  let slug = base
  for (let i = 2; existsSync(join(projectsDir(), slug)); i++) slug = `${base}-${i}`
  return slug
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
export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await renameWithRetry(tmp, path)
}

export async function renameWithRetry(from: string, to: string, tries = 40): Promise<void> {
  for (let i = 0; ; i++) {
    try {
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

export async function writeProject(slug: string, project: ProjectJson): Promise<void> {
  project.updatedAt = new Date().toISOString()
  const file = join(projectDir(slug), 'project.json')
  await serialized(file, () => writeJson(file, project))
}

async function readAppStateNow(file: string): Promise<AppState> {
  const s = await readJson<Partial<AppState>>(file, {})
  return { ...EMPTY_STATE, ...s, chat: s.chat ?? [] }
}

/** Reads go through the same per-file queue as writes, so our own reads never block a rename. */
export function readAppState(slug: string): Promise<AppState> {
  const file = join(projectDir(slug), 'app.json')
  return serialized(file, () => readAppStateNow(file))
}

export function updateAppState(slug: string, fn: (s: AppState) => void): Promise<AppState> {
  const file = join(projectDir(slug), 'app.json')
  return serialized(file, async () => {
    const s = await readAppStateNow(file)
    fn(s)
    await writeJson(file, s)
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
  attachments?: ChatMessage['attachments']
): Promise<void> {
  await updateAppState(slug, (s) => {
    s.chat.push({
      id: randomUUID(), from, text, at: new Date().toISOString(), version,
      ...(actions?.length ? { actions } : {}), ...(suggestion ? { suggestion } : {}), ...(attachments?.length ? { attachments } : {})
    })
  })
}

// ---- versions ---------------------------------------------------------------------------------

const VIDEO_NAMES = ['export.mp4', 'draft.mp4']

export async function listVersions(dir: string): Promise<VersionInfo[]> {
  const vdir = join(dir, 'versions')
  const published = await readJson<{ version?: number }>(join(dir, 'project.json'), {})
  const latest = Number(published.version ?? 0)
  let names: string[] = []
  try {
    names = await fs.readdir(vdir)
  } catch {
    return []
  }
  // docs/versions.md: a version is a `vN` folder with `export.mp4`. Drafts live in `versions/preview/`
  // and are overwritten; they only show (as n = 0, "Preview") when no final version exists yet,
  // e.g. when an AI run's final render failed.
  const out: VersionInfo[] = []
  const push = async (n: number, d: string, video: string): Promise<void> => {
    const st = await fs.stat(video)
    const cover = join(d, 'cover.png')
    out.push({
      n,
      video: mediaUrl(video, st.mtimeMs),
      videoPath: video,
      draft: basename(video) !== 'export.mp4',
      cover: existsSync(cover) ? mediaUrl(cover, st.mtimeMs) : null,
      createdAt: st.mtime.toISOString()
    })
  }
  for (const name of names) {
    const m = /^v(\d+)$/.exec(name)
    if (!m || Number(m[1]) > latest) continue
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
 * Removes versions that never finished (crash or quit mid-render) and stray temp files.
 * A finished version has a video file and no `.rendering` marker.
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
    const finished =
      /^v\d+$/.test(name) &&
      VIDEO_NAMES.some((v) => existsSync(join(d, v))) &&
      !existsSync(join(d, '.rendering'))
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

export const INTERRUPTED_CHANGE = 'Reel Studio closed before I finished that change. Send your note again and I will pick it up.'

/**
 * Called once at startup, before any job can run: a project whose app.json still says a job is
 * running was interrupted (quit, crash, power cut). Clean it up and mark it so the UI can offer
 * to pick up where it left off.
 */
export async function recoverInterrupted(): Promise<string[]> {
  const recovered: string[] = []
  let slugs: string[] = []
  try {
    slugs = await fs.readdir(projectsDir())
  } catch {
    return recovered
  }
  for (const slug of slugs) {
    let dir: string
    try {
      dir = projectDir(slug)
    } catch {
      continue
    }
    if (!(await fs.stat(dir)).isDirectory()) continue
    const staging = join(dir, '.staging')
    const entries = await fs.readdir(staging).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    if (entries.length) {
      const project = await readProject(slug)
      // Older staged notes committed txnId in the snapshot before appending it live.
      const snapshot = await readJson<{ notes?: { txnId?: string }[] }>(join(dir, 'versions', `v${project.version}`, 'project.json'), {})
      const published = new Set(snapshot.notes?.map((note) => note.txnId))
      const unfinished = entries.filter((id) => !published.has(id)).sort()
      if (unfinished.length) {
        // Persist all announced IDs before cleanup, even if a retry finds only some folders.
        await updateAppState(slug, (st) => {
          const announced = new Set(st.chat.flatMap((message) => message.id.startsWith('interrupted-note:')
            ? message.id.slice('interrupted-note:'.length).split(',') : []))
          const pending = unfinished.filter((id) => !announced.has(id))
          if (pending.length) {
            st.chat.push({ id: `interrupted-note:${pending.join(',')}`, from: 'editor', text: INTERRUPTED_CHANGE, at: new Date().toISOString() })
          }
          // Keep only the most recent 50 recovery IDs, without removing their chat messages.
          let remaining = 50
          for (const message of [...st.chat].reverse()) {
            if (!message.id.startsWith('interrupted-note:')) continue
            const ids = remaining ? message.id.slice('interrupted-note:'.length).split(',').slice(-remaining) : []
            message.id = ids.length ? `interrupted-note:${ids.join(',')}` : randomUUID()
            remaining -= ids.length
          }
          st.job = null
          st.status = 'ready'
        })
        recovered.push(slug)
      } else if (existsSync(join(dir, 'app.json'))) {
        await updateAppState(slug, (st) => {
          if (st.job?.kind === 'note') {
            st.job = null
            st.status = 'ready'
          }
        })
      }
    }
    await recoverNoteStaging(dir)
    if (!existsSync(join(dir, 'app.json'))) continue
    const s = await readAppState(slug)
    if (!s.job) continue
    await cleanPartialVersions(dir)
    await updateAppState(slug, (st) => {
      st.status = st.job?.kind === 'first-edit' || !existsSync(join(dir, 'versions')) ? 'interrupted' : 'ready'
      if (st.status === 'ready' && st.job?.kind !== 'export') {
        st.chat.push({
          id: randomUUID(),
          from: 'editor',
          text: INTERRUPTED_CHANGE,
          at: new Date().toISOString()
        })
      }
      st.job = null
    })
    recovered.push(slug)
  }
  return recovered
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
 */
export function checklist(p: ProjectJson, words: Word[], kept: string[], versions: VersionInfo[], aiEdited = false): ChecklistItem[] {
  const cutWords = words.length - kept.length
  const caption = (p.post?.caption ?? '').trim()
  const items: ChecklistItem[] = [
    {
      key: 'listen',
      label: 'Listened to your video',
      done: words.length > 0,
      detail: undefined
    },
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
      detail: p.music?.track ? niceName(p.music.track) : 'Add a song to your Library and I will use it'
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
      label: !caption ? 'Post caption: add your own' : aiEdited ? 'Wrote your post caption' : 'Your post caption',
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
    if (b.treatment === 'text-pop' && !b.asset) n.text++
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

export async function summary(slug: string): Promise<ProjectSummary | null> {
  const dir = projectDir(slug)
  let p: ProjectJson
  try {
    p = await readProject(slug)
  } catch {
    // A folder without a readable project.json is either being created or broken.
    const st = await readAppState(slug).catch(() => null)
    if (!st || !existsSync(join(dir, 'app.json'))) return null
    const now = new Date().toISOString()
    return {
      slug,
      dir,
      title: st.title ?? slug,
      createdAt: now,
      updatedAt: now,
      version: 0,
      thumbnail: null,
      status: st.job ? 'working' : st.status === 'ready' ? 'failed' : st.status
    }
  }
  const versions = await listVersions(dir)
  const st = await readAppState(slug)
  const last = versions[versions.length - 1]
  const status: ScreenStatus = st.job
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
    status
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

export async function detail(slug: string): Promise<ProjectDetail> {
  const dir = projectDir(slug)
  const s = await summary(slug)
  if (!s) throw { code: 'NOT_FOUND', userMessage: 'I could not find that video. It may have been moved or deleted.' }
  const project = await readProject(slug).catch(() => ({}) as ProjectJson)
  const versions = await listVersions(dir)
  const words = await readWords(dir, project)
  const kept = keptIds(words, project.cut?.keep)
  const st = await readAppState(slug)
  const brollThumbs: Record<string, string> = {}
  for (const b of project.broll ?? []) {
    const a = typeof b.asset === 'string' ? b.asset : ''
    // an attached clip or GIF (work/assets/attach-*.mp4) shows the still `engine attach` made of it
    const clip = /^work\/assets\/(attach-[a-f0-9]{8}-[a-z0-9-]+)\.(mp4|mov|m4v|webm)$/.exec(a)
    if (clip) {
      const t = join(dir, 'work', 'thumbs', `${clip[1]}.jpg`)
      if (existsSync(t)) brollThumbs[b.id] = mediaUrl(t)
      continue
    }
    if (!/\.(png|jpe?g|webp|gif)$/i.test(a)) continue
    const p = a.startsWith('Library/') || isAbsolute(a) ? resolveRootPath(a) : join(dir, ...a.split('/'))
    if (existsSync(p)) brollThumbs[b.id] = mediaUrl(p)
  }
  // The raw footage, for "hold for Original" and the Working screen's first frame.
  const src = project.sources?.[0]?.path
  const srcPath = src ? (isAbsolute(src) ? src : join(dir, ...src.split('/'))) : null
  return {
    ...s,
    sourceVideo: srcPath && existsSync(srcPath) ? mediaUrl(srcPath) : null,
    project,
    versions,
    words,
    keptIds: kept,
    brollThumbs,
    checklist: checklist(project, words, kept, versions, !!st.aiEdited),
    // a note's attached files get a URL for their still here (never stored: the root folder can move)
    chat: st.chat.map((m) => (m.attachments?.length ? { ...m, attachments: m.attachments.map((a) => chatThumb(dir, a)) } : m)),
    lastError: st.lastError,
    job: st.job ? { id: st.job.id, kind: st.job.kind, message: 'Working on it', pct: 0, overall: 0, secondsLeft: null, overdue: false, thinking: false } : null,
    aiEdited: !!st.aiEdited
  }
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
