// The release-notes popover's list: the "What's new" bullets of a GitHub release, as short plain lines.
//
// Two inputs reach here. electron-updater's GitHub provider hands over the release body as GitHub renders it in
// the releases atom feed (HTML); the Windows page check reads the API's raw markdown. Both are turned into
// markdown-ish lines first, then the same reader picks the bullets. Reel Studio's release notes open with a
// product blurb and end with download, install and licence sections, so only the "What's new" (or "What's
// changed") section counts; a release without that heading falls back to its first bullet list.
import type { ReleaseNotes } from '../shared/update'

export const MAX_ITEMS = 6
export const MAX_ITEM_LENGTH = 140

const ENTITIES: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }

function decodeEntities(s: string): string {
  return s.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (whole, e: string) => {
    if (ENTITIES[e]) return ENTITIES[e]
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : e.startsWith('#') ? parseInt(e.slice(1), 10) : NaN
    // String.fromCodePoint throws outside the Unicode range (&#9999999999;)
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

const looksLikeHtml = (s: string): boolean => /<(h[1-6]|p|ul|ol|li|strong|br)\b/i.test(s)

/** GitHub's rendered HTML back to the markdown shapes the reader below understands. */
function htmlToLines(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ') // GitHub keeps the source's line wraps as <br>: inside a bullet they are spaces
      .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
      .replace(/<li\b[^>]*>/gi, '\n* ')
      .replace(/<\/?(strong|b)\b[^>]*>/gi, '**')
      .replace(/<\/(p|div|li|h[1-6]|ul|ol|blockquote)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
}

const HEADING = /^#{1,6}\s+(.*)$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const WHATS_NEW = /^what'?s\s+(new|changed)\b|^changes\b|^new\b/i

/** One bullet as a short plain line. A bold lead sentence ("**Use your own Claude.** Every installer ...") is
 * the line; a bold label ("**Fix:** a clip ...") keeps the text after it. */
function itemText(raw: string): string {
  const lead = /^\*\*([^*]+?[.!?])\*\*/.exec(raw.trim())
  let t = lead ? lead[1] : raw
  t = t
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](link)
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length <= MAX_ITEM_LENGTH ? t : `${t.slice(0, MAX_ITEM_LENGTH - 3).trimEnd()}...`
}

interface Section {
  heading: string | null
  items: string[]
}

function sections(text: string): Section[] {
  const out: Section[] = [{ heading: null, items: [] }]
  let open: string | null = null // the bullet being read: wrapped lines continue it
  const close = () => {
    if (open !== null) out[out.length - 1].items.push(open)
    open = null
  }
  for (const line of text.split(/\r?\n/)) {
    const h = HEADING.exec(line.trim())
    if (h) {
      close()
      out.push({ heading: h[1].replace(/\*\*/g, '').trim(), items: [] })
      continue
    }
    const b = BULLET.exec(line)
    if (b) {
      close()
      open = b[1]
    } else if (open !== null && line.trim()) {
      // a wrapped line (markdown indents it; the HTML form has no indentation) still belongs to the bullet
      open += ' ' + line.trim()
    } else {
      close()
    }
  }
  close()
  return out
}

/** The popover's list for `version`, or null when the notes have no list to show. Never throws on odd input. */
export function releaseNotesFrom(raw: unknown, version: string): ReleaseNotes | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  // electron-updater's fullChangelog form: [{version, note}], newest first. Only the newest is shown.
  else if (Array.isArray(raw)) {
    const first = raw.find((r) => r && typeof r === 'object' && typeof (r as { note?: unknown }).note === 'string') as { note: string } | undefined
    text = first?.note ?? null
  }
  if (!text || !text.trim() || text.trim() === 'No content.') return null
  if (looksLikeHtml(text)) text = htmlToLines(text)
  const all = sections(text)
  const chosen = all.find((s) => s.heading && WHATS_NEW.test(s.heading) && s.items.length) ?? all.find((s) => s.items.length)
  if (!chosen) return null
  const items = chosen.items.map(itemText).filter(Boolean)
  if (!items.length) return null
  return { version, items: items.slice(0, MAX_ITEMS), totalItems: items.length }
}
