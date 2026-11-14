// "Report a problem" (Settings > About, Help on a Mac, and the error screens): a short form that sends a bug report to
// Reel Studio's download server (POST dl.getreelstudio.com/v1/support), where it lands on an internal dashboard.
//
// What is sent is exactly what the person saw on the review step: `prepare()` builds the whole report and keeps it,
// the page shows that, and `send()` sends the kept report, nothing rebuilt in between. By default it holds only what
// they typed, the app version and the OS. Each of these goes in only when they tick it:
//   - the diagnostics text (the same redacted block as "Copy diagnostics", main/diagnostics.ts);
//   - a screenshot of the Reel Studio window, taken when the form opened (so it shows the problem, not the form);
//   - the download key (main/update-key.ts), so support can see which purchase it is. It names the purchase, not the
//     person, and is ticked by default when the app has one, because it is how support finds a buyer's purchase
//     without asking for an email.
// No email address is filled in for them.
//
// The address can be moved for testing: REELSTUDIO_SUPPORT_URL=https://dl-staging.getreelstudio.com/v1/support (or
// http on this computer). This file never imports electron: index.ts wires it, tests drive it with fakes.
import type { SupportDraft, SupportPreview, SupportSent, UserError } from '../shared/api'
import { SUPPORT_EMAIL } from '../shared/config'

export const SUPPORT_REPORT_URL = 'https://dl.getreelstudio.com/v1/support'
/** What the server takes (the site repo's worker/src/support.ts). The page caps its fields the same way. */
export const SUPPORT_CAPS = { what: 5000, expected: 3000, email: 254, diagnostics: 200_000 } as const
export const MAX_SCREENSHOT = 2 * 1024 * 1024
const TIMEOUT_MS = 30_000

/** The parts of Electron's NativeImage the screenshot needs. */
export interface ImageLike {
  getSize(): { width: number; height: number }
  toPNG(): Uint8Array
  toJPEG(quality: number): Uint8Array
  resize(opts: { width: number }): ImageLike
  isEmpty(): boolean
}

export interface Screenshot {
  bytes: Uint8Array
  type: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** The window as PNG, or as JPEG, made smaller until it fits the server's 2 MB. null if it cannot fit (or is blank). */
export function encodeScreenshot(img: ImageLike, max = MAX_SCREENSHOT): Screenshot | null {
  if (img.isEmpty()) return null
  const png = img.toPNG()
  const size = img.getSize()
  if (png.byteLength <= max) return { bytes: png, type: 'image/png', ...size }
  let cur = img
  for (let i = 0; i < 6; i++) {
    const jpeg = cur.toJPEG(85)
    const s = cur.getSize()
    if (jpeg.byteLength <= max) return { bytes: jpeg, type: 'image/jpeg', ...s }
    if (s.width < 400) break
    cur = cur.resize({ width: Math.round(s.width * 0.7) })
  }
  return null
}

/** The address from REELSTUDIO_SUPPORT_URL, if it is https (or http on this computer); else the real one. */
export function supportUrl(env: Record<string, string | undefined>, log: (line: string) => void): string {
  const raw = env.REELSTUDIO_SUPPORT_URL?.trim()
  if (!raw) return SUPPORT_REPORT_URL
  try {
    const u = new URL(raw)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    if (!u.username && !u.password && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && local))) return u.href
  } catch {
    /* falls through */
  }
  log('[support] REELSTUDIO_SUPPORT_URL is not a usable address; reports go to the real server')
  return SUPPORT_REPORT_URL
}

export interface SupportDeps {
  url: string
  appVersion: string
  /** "Windows 10.0.26200 x64", "macOS 15.1.0 arm64" */
  os: string
  fetch: typeof fetch
  /** The download key, or null. */
  getKey(): Promise<string | null>
  /** The redacted diagnostics text (main/diagnostics.ts). */
  diagnostics(): Promise<string>
  /** A screenshot of the app window, or null. */
  capture(): Promise<Screenshot | null>
  log(line: string): void
}

interface Prepared {
  id: string
  fields: { what: string; expected: string; email: string; appVersion: string; os: string }
  diagnostics: string | null
  screenshot: Screenshot | null
  key: string | null
}

const fail = (code: string, userMessage: string, field?: SupportPreviewField): UserError & { field?: SupportPreviewField } => ({ code, userMessage, ...(field ? { field } : {}) })
type SupportPreviewField = 'what' | 'expected' | 'email'

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

/** Trimmed, CRLF as LF, control characters other than newline and tab gone (the server does the same). */
export function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim() : ''
}

const toB64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')

export function createSupport(d: SupportDeps) {
  let shot: Screenshot | null = null
  let prepared: Prepared | null = null
  let seq = 0
  // One per form: opening (capture) and closing (discard) bump it. An await that started under an older generation
  // keeps nothing when it resumes, so a form closed while its screenshot or diagnostics were still being gathered
  // leaves no report, text or key behind in memory.
  let generation = 0

  return {
    /** When the form opens, before it is drawn: the window as it was. Kept in memory until sent or discarded. */
    async capture(): Promise<{ available: boolean; hasKey: boolean }> {
      const gen = ++generation
      prepared = null
      shot = null
      let taken: Screenshot | null = null
      try {
        taken = await d.capture()
      } catch (e) {
        d.log(`[support] screenshot failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      }
      const hasKey = !!(await d.getKey().catch(() => null))
      if (gen !== generation) return { available: false, hasKey }
      shot = taken
      return { available: !!shot, hasKey }
    },

    /** What the review step shows, built once. `send()` sends exactly this. */
    async prepare(draft: SupportDraft): Promise<SupportPreview> {
      const gen = generation
      const what = clean(draft?.what)
      const expected = clean(draft?.expected)
      const email = clean(draft?.email).toLowerCase()
      if (!what) throw fail('SUPPORT_FIELD', 'Say what happened first.', 'what')
      if (what.length > SUPPORT_CAPS.what) throw fail('SUPPORT_FIELD', `Please keep "What happened" under ${SUPPORT_CAPS.what} characters.`, 'what')
      if (expected.length > SUPPORT_CAPS.expected) throw fail('SUPPORT_FIELD', `Please keep "What you expected" under ${SUPPORT_CAPS.expected} characters.`, 'expected')
      if (email && (email.length > SUPPORT_CAPS.email || !EMAIL_RE.test(email))) throw fail('SUPPORT_FIELD', 'That email address does not look right. Leave it empty if you prefer.', 'email')
      let diagnostics: string | null = null
      if (draft.diagnostics === true) {
        const text = await d.diagnostics()
        // The newest lines matter most: a log longer than the server takes loses its start.
        diagnostics = text.length > SUPPORT_CAPS.diagnostics ? '[…]\n' + text.slice(text.length - SUPPORT_CAPS.diagnostics + 4) : text
      }
      const key = draft.key === true ? await d.getKey() : null
      // The form closed (or reopened) while this was gathering: keep nothing.
      if (gen !== generation) throw fail('SUPPORT_STALE', 'This report was closed before it was ready.')
      prepared = {
        id: `p${++seq}`,
        fields: { what, expected, email, appVersion: d.appVersion, os: d.os },
        diagnostics,
        screenshot: draft.screenshot === true ? shot : null,
        key
      }
      const s = prepared.screenshot
      return {
        id: prepared.id,
        server: new URL(d.url).host,
        what,
        expected,
        email: email || null,
        appVersion: d.appVersion,
        os: d.os,
        diagnostics,
        screenshot: s ? { dataUrl: `data:${s.type};base64,${toB64(s.bytes)}`, bytes: s.bytes.byteLength, width: s.width, height: s.height } : null,
        key: !!key
      }
    },

    /** Sends the report `prepare()` made. Throws a UserError the page shows, next to the email-us way out. */
    async send(id: unknown): Promise<SupportSent> {
      const p = prepared
      if (!p || p.id !== id) throw fail('SUPPORT_STALE', 'Something changed since you reviewed this report. Go back and review it again.')
      const form = new FormData()
      form.append('what', p.fields.what)
      if (p.fields.expected) form.append('expected', p.fields.expected)
      if (p.fields.email) form.append('email', p.fields.email)
      form.append('appVersion', p.fields.appVersion)
      form.append('os', p.fields.os)
      if (p.diagnostics) form.append('diagnostics', p.diagnostics)
      if (p.screenshot) form.append('screenshot', new Blob([Buffer.from(p.screenshot.bytes)], { type: p.screenshot.type }), p.screenshot.type === 'image/png' ? 'window.png' : 'window.jpg')
      const headers: Record<string, string> = { 'User-Agent': `ReelStudio/${d.appVersion}`, Accept: 'application/json' }
      if (p.key) headers.Authorization = `Bearer ${p.key}`
      let res: Response
      try {
        res = await d.fetch(d.url, { method: 'POST', body: form, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (e) {
        d.log(`[support] send failed: ${(e as Error)?.name === 'TimeoutError' ? 'timeout' : String((e as Error)?.message ?? e).slice(0, 200)}`)
        throw fail('SUPPORT_OFFLINE', "Couldn't reach Reel Studio. Check your internet connection and try again.")
      }
      let body: { id?: unknown; error?: unknown; field?: unknown } = {}
      try {
        body = (await res.json()) as typeof body
      } catch {
        /* an odd answer is handled below */
      }
      if (res.status === 201 && typeof body.id === 'string' && /^RS-[0-9A-Z]{8}$/.test(body.id)) {
        d.log(`[support] sent ${body.id}${p.diagnostics ? ' +diagnostics' : ''}${p.screenshot ? ' +screenshot' : ''}${p.key ? ' +key' : ''}`)
        prepared = null
        shot = null
        return { id: body.id }
      }
      d.log(`[support] server answered ${res.status} ${typeof body.error === 'string' ? body.error.slice(0, 120) : ''}`)
      if (res.status === 429) throw fail('SUPPORT_BUSY', 'Too many reports from this computer in the last hour. Try again later.')
      if (res.status === 413) throw fail('SUPPORT_TOO_BIG', 'This report is too large to send. Untick the screenshot or the diagnostics and try again.')
      if (res.status === 400 && typeof body.error === 'string') {
        const field = body.field === 'what' || body.field === 'expected' || body.field === 'email' ? body.field : undefined
        throw fail('SUPPORT_FIELD', `Reel Studio couldn't take this report (${body.field ? `${String(body.field)}: ` : ''}${body.error.slice(0, 120)}).`, field)
      }
      throw fail('SUPPORT_FAILED', "Reel Studio couldn't take the report just now. Try again in a few minutes.")
    },

    /** The form closed without sending: drop the screenshot and the prepared report. */
    discard(): void {
      generation++
      shot = null
      prepared = null
    },

    /** The report as plain text, to paste into an email when sending fails ("Copy the report"). */
    asText(id: unknown): string {
      const p = prepared
      if (!p || p.id !== id) return ''
      return reportText(p)
    },

    /** A mailto: link to support with what they typed, for when sending fails. Diagnostics stay out (a mailto: link
     * must stay short); "Copy the report" has them. */
    mailto(id: unknown): string {
      const p = prepared && prepared.id === id ? prepared : null
      const body = p ? reportText({ ...p, diagnostics: null }).slice(0, 1500) : ''
      return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Problem report from Reel Studio')}&body=${encodeURIComponent(body)}`
    }
  }
}

function reportText(p: Prepared): string {
  const lines = [`Reel Studio ${p.fields.appVersion} on ${p.fields.os}`, '', 'What happened:', p.fields.what]
  if (p.fields.expected) lines.push('', 'What I expected:', p.fields.expected)
  if (p.diagnostics) lines.push('', p.diagnostics)
  return lines.join('\n') + '\n'
}

export type SupportService = ReturnType<typeof createSupport>
