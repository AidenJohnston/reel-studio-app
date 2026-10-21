// Pictures, GIFs and short clips attached to a note (0.1.2 F2): the pure rules shared by the page and
// the main process. No Node and no DOM imports here (it is unit-tested and runs on both sides).
//
// The engine (`attach`) is the real gate: it checks the type, size and length again, converts, and
// writes the sidecar the main process and the AI re-check. These rules only let the page say "no"
// early and in the same words, before a big file is read or copied.

export const MAX_ATTACHMENTS_PER_NOTE = 4

export const MB = 1024 * 1024
export const PICTURE_MAX_BYTES = 25 * MB
export const CLIP_MAX_BYTES = 200 * MB
export const CLIP_MAX_SECONDS = 60

export const PICTURE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp'] as const
export const CLIP_EXTS = ['mp4', 'mov', 'm4v', 'webm'] as const
/** For the file dialog. */
export const ATTACH_EXTS: string[] = [...PICTURE_EXTS, ...CLIP_EXTS]

export const MSG = {
  type: "That file type isn't supported. Use a picture (JPG, PNG, GIF, HEIC) or a short video (MP4, MOV).",
  pictureBig: 'That picture is too big. Use one under 25 MB.',
  clipBig: 'That file is too big. Use a clip or GIF under 200 MB.',
  clipLong: 'That clip is too long. Use one that is 1 minute or shorter.',
  tooMany: `You can attach up to ${MAX_ATTACHMENTS_PER_NOTE} files to one note.`,
  noPicture: 'There is no picture to paste. Copy a picture first, then paste it here.',
  fromWeb: 'Save that picture to your computer first, then drop it here.',
  failed: "I couldn't add that file. Try again."
} as const

/** What `engine attach` writes; anything else is never an attachment (main re-checks the sidecar). */
export const ATTACHMENT_REF = /^work\/assets\/attach-[a-f0-9]{8}-[a-z0-9-]{1,40}\.(png|jpg|mp4|mov|m4v|webm)$/

export function isAttachmentRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ATTACHMENT_REF.test(ref)
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm'
}

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? '').trim())
  return m ? m[1].toLowerCase() : ''
}

/** The extension to judge a file by: its name's, else its MIME type's (a pasted "image" has no name). */
export function effectiveExt(name: string, mime?: string): string {
  const e = extOf(name)
  if ((PICTURE_EXTS as readonly string[]).includes(e) || (CLIP_EXTS as readonly string[]).includes(e)) return e
  return MIME_EXT[String(mime ?? '').toLowerCase()] ?? e
}

/** A name with the right extension, for a pasted file with no name or the wrong one. */
export function nameWithExt(name: string, mime?: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop()?.trim() || 'Pasted picture'
  const ext = effectiveExt(base, mime)
  if (!ext) return base
  return extOf(base) === ext || (ext === 'jpg' && extOf(base) === 'jpeg') ? base : `${base.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.${ext}`
}

export type AttachKind = 'picture' | 'gif' | 'clip'
export type Classified = { ok: true; kind: AttachKind; ext: string } | { ok: false; message: string }

/** Type + size check (length is the engine's: only it can read a clip). */
export function classify(name: string, mime?: string, size?: number): Classified {
  const ext = effectiveExt(name, mime)
  let kind: AttachKind
  if (ext === 'gif') kind = 'gif'
  else if ((PICTURE_EXTS as readonly string[]).includes(ext)) kind = 'picture'
  else if ((CLIP_EXTS as readonly string[]).includes(ext)) kind = 'clip'
  else return { ok: false, message: MSG.type }
  if (typeof size === 'number' && Number.isFinite(size)) {
    if (kind === 'picture' && size > PICTURE_MAX_BYTES) return { ok: false, message: MSG.pictureBig }
    if (kind !== 'picture' && size > CLIP_MAX_BYTES) return { ok: false, message: MSG.clipBig }
  }
  return { ok: true, kind, ext }
}

// ---------------------------------------------------------------- paste and drop

/** What the page knows about one File (the page fills `path` from webUtils.getPathForFile). */
export interface FileLike {
  name: string
  type: string
  size: number
  /** a real file on disk ('' or missing = only bytes, e.g. a screenshot or a picture copied from a browser) */
  path?: string
}

export interface ClipItem {
  kind: string
  type: string
}

export interface IncomingPlan {
  /** files with a real path: main copies them (notes:attachFiles) */
  paths: { path: string; name: string }[]
  /** files with only bytes: the page reads them and sends them (notes:attachData) */
  blobs: number[]
  /** read the picture from the system clipboard in main (notes:attachClipboard) */
  clipboard: boolean
  /** plain words for the files that cannot be attached (one per file) */
  errors: string[]
}

export type PastePlan = ({ handle: true } & IncomingPlan) | { handle: false }

const EMPTY: IncomingPlan = { paths: [], blobs: [], clipboard: false, errors: [] }

function planFiles(files: FileLike[]): IncomingPlan {
  const out: IncomingPlan = { paths: [], blobs: [], clipboard: false, errors: [] }
  files.forEach((f, i) => {
    const c = classify(f.name, f.type, f.size)
    if (!c.ok) {
      out.errors.push(c.message)
      return
    }
    if (f.path) out.paths.push({ path: f.path, name: f.name || nameWithExt('', f.type) })
    else if (f.size > 0) out.blobs.push(i)
    else out.errors.push(MSG.failed)
  })
  return out
}

/**
 * Ctrl/Cmd+V on the note box. Plain text must paste as normal, so the page only takes over when:
 * - a file with a real path was copied (Explorer, Finder): always, even if its name came along as text;
 * - a picture with only bytes (a screenshot, "Copy image" in a browser) and NO plain text: copying cells
 *   from a spreadsheet or a paragraph from a document also puts a picture of it on the clipboard, and
 *   that person meant the text;
 * - no File at all but an image type is listed: the main process reads the system clipboard.
 */
export function planPaste(input: { files: FileLike[]; items: ClipItem[]; text: string }): PastePlan {
  const hasText = !!input.text && input.text.trim().length > 0
  const withPath = input.files.filter((f) => !!f.path)
  if (withPath.length) return { handle: true, ...planFiles(withPath) }
  if (input.files.length) {
    if (hasText) return { handle: false }
    return { handle: true, ...planFiles(input.files) }
  }
  const imageItem = input.items.some((it) => /^image\//i.test(it.type))
  if (imageItem && !hasText) return { handle: true, ...EMPTY, clipboard: true }
  return { handle: false }
}

/** Files dropped on the note box. `uriOnly` = the drag carried only a link (an image dragged out of
 * some browsers): nothing to copy, so say how. */
export function planDrop(input: { files: FileLike[]; uriOnly?: boolean }): IncomingPlan {
  if (!input.files.length) return { ...EMPTY, errors: input.uriOnly ? [MSG.fromWeb] : [] }
  return planFiles(input.files)
}

// ---------------------------------------------------------------- the chips

export interface ChipLike {
  asset: string
}

/** Adds new chips after the ones already there: no repeats, at most four. `dropped` = how many did not fit. */
export function addChips<T extends ChipLike>(current: T[], incoming: T[]): { chips: T[]; dropped: number } {
  const chips = [...current]
  let dropped = 0
  for (const a of incoming) {
    if (chips.some((c) => c.asset === a.asset)) continue
    if (chips.length >= MAX_ATTACHMENTS_PER_NOTE) {
      dropped++
      continue
    }
    chips.push(a)
  }
  return { chips, dropped }
}

/** How many more files fit on this note (counting ones still being copied). */
export function slotsLeft(chips: number, busy = 0): number {
  return Math.max(0, MAX_ATTACHMENTS_PER_NOTE - chips - busy)
}

/** "0:07" */
export function clipLength(seconds: number | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The small badge on a chip: "GIF" for a GIF, the length for a clip, nothing for a picture. */
export function chipBadge(a: { kind: 'image' | 'video'; fromGif?: boolean; duration?: number }): string | null {
  if (a.fromGif) return 'GIF'
  if (a.kind === 'video') return clipLength(a.duration)
  return null
}
