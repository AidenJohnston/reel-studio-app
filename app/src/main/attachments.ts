// Pictures, GIFs and short clips attached to a note (0.1.2 F2), main-process side.
//
// The page hands over file paths (drop, file picker, a copied file) or raw bytes (a pasted screenshot, a
// picture copied from a browser). Each goes through the engine's `attach` command, which checks it again,
// converts it if needed and writes it into <project>/work/assets/attach-* with a sidecar. Nothing the page
// says about an attachment is trusted later: a note's refs are re-read from this project's own sidecars.
//
// No `electron` import here (dialog and clipboard are passed in), so the logic is unit-tested in Node.
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { AttachResult, NoteAttachment, ProjectJson } from '../shared/api'
import { ATTACH_EXTS, CLIP_MAX_BYTES, MAX_ATTACHMENTS_PER_NOTE, MSG, classify, isAttachmentRef, nameWithExt } from '../shared/attachments'
import { mediaUrl } from './media-url'
import type { RunEngine } from './engine'

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void

const THUMB_REF = /^work\/thumbs\/attach-[a-z0-9-]+\.jpg$/
const MISSING = { code: 'BAD_ATTACHMENT', userMessage: 'One of your attached files is missing. Attach it again.' }

function real(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/** The sidecar of one attachment ref of THIS project, as a NoteAttachment, or null for anything else. */
export async function readSidecar(dir: string, ref: unknown): Promise<NoteAttachment | null> {
  if (typeof ref !== 'string') return null
  const clean = ref.replace(/\\/g, '/')
  if (!isAttachmentRef(clean)) return null
  const assets = real(join(dir, 'work', 'assets'))
  const file = real(join(dir, ...clean.split('/')))
  const side = real(join(dir, ...clean.split('/')) + '.attach.json')
  if (!assets || !file || !side || dirname(file) !== assets || dirname(side) !== assets) return null
  let j: any
  try {
    j = JSON.parse(await fs.readFile(side, 'utf8'))
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || j.asset !== clean || (j.kind !== 'image' && j.kind !== 'video')) return null
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const out: NoteAttachment = {
    asset: clean,
    name: typeof j.name === 'string' && j.name.trim() ? j.name.slice(0, 120) : basename(clean),
    kind: j.kind,
    bytes: num(j.bytes) ?? 0
  }
  for (const k of ['width', 'height', 'duration'] as const) if (num(j[k]) !== undefined) out[k] = num(j[k])
  if (typeof j.hasAudio === 'boolean') out.hasAudio = j.hasAudio
  if (j.fromGif === true) out.fromGif = true
  if (typeof j.thumb === 'string' && THUMB_REF.test(j.thumb)) out.thumb = j.thumb
  return out
}

/** The same attachment with a reel-media URL for its still (for the page). Never trusts a stored URL. */
export function withThumbUrl(dir: string, a: NoteAttachment): NoteAttachment {
  const { thumbUrl: _old, ...rest } = a
  if (!a.thumb || !THUMB_REF.test(a.thumb)) return rest
  const p = join(dir, ...a.thumb.split('/'))
  return existsSync(p) ? { ...rest, thumbUrl: mediaUrl(p) } : rest
}

/** What is stored on a chat message: the sidecar facts, no URL (the root folder can move). */
export function forChat(a: NoteAttachment): NoteAttachment {
  const { thumbUrl: _u, ...rest } = a
  return rest
}

/** A note's refs, checked against this project's sidecars: at most four, no repeats, each real. */
export async function checkNoteAttachments(dir: string, refs: unknown): Promise<NoteAttachment[]> {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) throw MISSING
  const uniq = [...new Set(refs.map((r) => (typeof r === 'string' ? r.replace(/\\/g, '/') : r)))]
  if (uniq.length > MAX_ATTACHMENTS_PER_NOTE) throw { code: 'TOO_MANY', userMessage: MSG.tooMany }
  const out: NoteAttachment[] = []
  for (const r of uniq) {
    const a = await readSidecar(dir, r)
    if (!a) throw MISSING
    out.push(a)
  }
  return out
}

/** Assets the video uses (an attachment there must not be deleted). */
export function usedAssets(p: Pick<ProjectJson, 'broll'> | null): Set<string> {
  return new Set(((p?.broll ?? []) as { asset?: unknown }[]).map((b) => String(b?.asset ?? '').replace(/\\/g, '/')).filter(Boolean))
}

/** Which image type to take from a clipboard that offers several (PNG keeps a screenshot sharp). */
export function pickClipboardType(types: readonly string[]): string | null {
  const imgs = types.filter((t) => /^image\//i.test(t))
  for (const want of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']) {
    const hit = imgs.find((t) => t.toLowerCase() === want)
    if (hit) return hit
  }
  return imgs[0] ?? null
}

/** Deletes an attached file + its sidecar + its still, only when it is this project's attachment and
 * the video does not use it. */
export async function removeAttachment(dir: string, asset: unknown, project: Pick<ProjectJson, 'broll'> | null): Promise<void> {
  const a = await readSidecar(dir, asset)
  if (!a) return // already gone, or never one of ours: nothing to delete
  if (usedAssets(project).has(a.asset)) {
    throw { code: 'IN_USE', userMessage: 'That file is already in your video, so I kept it. Ask me to take it out instead.' }
  }
  const file = join(dir, ...a.asset.split('/'))
  await fs.rm(file + '.attach.json', { force: true })
  await fs.rm(file, { force: true })
  if (a.thumb) await fs.rm(join(dir, ...a.thumb.split('/')), { force: true })
}

export interface AttachDeps {
  runEngine: RunEngine
  log: (line: string) => void
  owner?: string
}

function friendly(e: unknown): string {
  const m = (e as { userMessage?: unknown })?.userMessage
  return typeof m === 'string' && m.trim() ? m : MSG.failed
}

/** Engine `attach` for each file, one at a time (the engine copies; big clips take a moment). */
export async function attachPaths(deps: AttachDeps, dir: string, files: { path: string; name?: string }[]): Promise<AttachResult> {
  const out: AttachResult = { attached: [], errors: [] }
  for (const f of files.slice(0, MAX_ATTACHMENTS_PER_NOTE)) {
    const name = f.name || basename(f.path)
    try {
      const r: any = await deps.runEngine('attach', ['--project', dir, f.path, '--name', name, ...(deps.owner ? ['--owner', deps.owner] : [])])
      const a = await readSidecar(dir, r?.asset)
      if (!a) throw { code: 'ATTACH_FAILED', userMessage: MSG.failed }
      out.attached.push(withThumbUrl(dir, a))
    } catch (e) {
      deps.log(`[attach] ${name}: ${(e as { code?: string })?.code ?? ''} ${(e as { message?: string })?.message ?? ''}`)
      if ((e as { code?: string })?.code === 'ENGINE_STUCK') throw e
      out.errors.push(friendly(e))
    }
  }
  if (files.length > MAX_ATTACHMENTS_PER_NOTE) out.errors.push(MSG.tooMany)
  return out
}

function toBuffer(bytes: unknown): Buffer | null {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes)
  return null
}

/** A temp-file name a user's paste can never turn into a path: letters, digits, spaces, dashes. */
function tempName(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? 'png'
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 60) || 'pasted'
  return `${stem}.${ext}`
}

/** Bytes with no file behind them (a pasted screenshot, a picture copied from a browser). The type and
 * size are checked BEFORE anything is written; the temp copy is always deleted afterwards. */
export async function attachBytes(deps: AttachDeps, dir: string, file: { name?: unknown; mime?: unknown; bytes?: unknown }): Promise<AttachResult> {
  const buf = toBuffer(file?.bytes)
  const mime = typeof file?.mime === 'string' ? file.mime : ''
  const name = nameWithExt(typeof file?.name === 'string' ? file.name : '', mime)
  if (!buf || !buf.length) return { attached: [], errors: [MSG.failed] }
  if (buf.length > CLIP_MAX_BYTES) return { attached: [], errors: [MSG.clipBig] }
  const c = classify(name, mime, buf.length)
  if (!c.ok) return { attached: [], errors: [c.message] }
  const tmp = join(tmpdir(), `reelstudio-attach-${randomUUID()}`)
  try {
    await fs.mkdir(tmp, { recursive: true })
    const p = join(tmp, tempName(name))
    await fs.writeFile(p, buf)
    return await attachPaths(deps, dir, [{ path: p, name }])
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface AttachIpcDeps extends AttachDeps {
  handle: Handle
  projectDir: (slug: string) => string
  readProject: (slug: string) => Promise<ProjectJson>
  /** Reserve the project in the job lane and provide its owner token to engine work. */
  reserve: <T>(slug: string, fn: (owner: string) => Promise<T>) => Promise<T>
  /** the picture on the system clipboard (null = none) */
  clipboardImage: () => Promise<{ mime: string; bytes: Uint8Array } | null>
  /** Electron's file dialog (null = cancelled) */
  choose: (filters: { name: string; extensions: string[] }[]) => Promise<string[] | null>
}

/** The project folder. The caller reserves it before any attachment write. */
async function projectOf(deps: AttachIpcDeps, slug: unknown): Promise<string> {
  if (typeof slug !== 'string' || !slug) throw { code: 'NOT_FOUND', userMessage: 'I could not find that video.' }
  const dir = deps.projectDir(slug)
  if (!existsSync(join(dir, 'project.json'))) throw { code: 'NOT_FOUND', userMessage: 'I could not find that video. It may have been moved or deleted.' }
  return dir
}

function withOwner(deps: AttachIpcDeps, owner: string): AttachDeps {
  return { runEngine: deps.runEngine, log: deps.log, owner }
}

export function registerAttachmentIpc(deps: AttachIpcDeps): void {
  deps.handle('notes:attachFiles', async (_e, slug: unknown, paths: unknown) => {
    const dir = await projectOf(deps, slug)
    return deps.reserve(slug as string, (owner) => {
      const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && !!p) : []
      return attachPaths(withOwner(deps, owner), dir, list.map((p) => ({ path: p })))
    })
  })
  deps.handle('notes:attachData', async (_e, slug: unknown, file: unknown) => {
    const dir = await projectOf(deps, slug)
    return deps.reserve(slug as string, (owner) => attachBytes(withOwner(deps, owner), dir, (file ?? {}) as { name?: unknown; mime?: unknown; bytes?: unknown }))
  })
  deps.handle('notes:attachClipboard', async (_e, slug: unknown) => {
    const dir = await projectOf(deps, slug)
    return deps.reserve(slug as string, async (owner) => {
      const img = await deps.clipboardImage().catch(() => null)
      if (!img?.bytes?.length) return { attached: [], errors: [MSG.noPicture] }
      return attachBytes(withOwner(deps, owner), dir, { name: 'Pasted picture', mime: img.mime, bytes: img.bytes })
    })
  })
  deps.handle('notes:chooseAttachment', async (_e, slug: unknown) => {
    const dir = await projectOf(deps, slug)
    return deps.reserve(slug as string, async (owner) => {
      const picked = await deps.choose([{ name: 'Pictures and videos', extensions: ATTACH_EXTS }])
      if (!picked?.length) return { attached: [], errors: [] }
      return attachPaths(withOwner(deps, owner), dir, picked.map((p) => ({ path: p })))
    })
  })
  deps.handle('notes:removeAttachment', async (_e, slug: unknown, asset: unknown) => {
    const dir = await projectOf(deps, slug)
    await deps.reserve(slug as string, async () => {
      await removeAttachment(dir, asset, await deps.readProject(slug as string).catch(() => null))
    })
  })
}
