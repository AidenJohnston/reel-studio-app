import type { ReleaseNotes } from '../shared/update'

const MAX_ITEMS = 6
const MAX_ITEM_LENGTH = 140

const HEADING = /^#{1,6}\s+(.*)$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const WHATS_NEW = /^what'?s\s+(new|changed)\b|^changes\b|^new\b/i

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
      open += ' ' + line.trim()
    } else {
      close()
    }
  }
  close()
  return out
}

export function releaseNotesFrom(raw: string | null, version: string): ReleaseNotes | null {
  if (!raw?.trim() || raw.trim() === 'No content.') return null
  const text = raw
  const all = sections(text)
  const chosen = all.find((s) => s.heading && WHATS_NEW.test(s.heading) && s.items.length) ?? all.find((s) => s.items.length)
  if (!chosen) return null
  const items = chosen.items.map(itemText).filter(Boolean)
  if (!items.length) return null
  return { version, items: items.slice(0, MAX_ITEMS), totalItems: items.length }
}
