import type { ReleaseEntry, ReleaseNotes } from '../shared/update'
import { isNewer, type FoundUpdate } from './update-check'

const MAX_ITEMS = 6
const MAX_ITEM_LENGTH = 140
const MAX_SUMMARY_LENGTH = 240
export const MAX_NOTES = 5
export const MAX_RELEASES = 20

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const WHATS_NEW = /^what'?s\s+(new|changed)\b|^changes\b|^new\b/i

function plain(t: string): string {
  return t
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](link)
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const clip = (t: string, max: number): string => (t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`)

function itemText(raw: string): string {
  const lead = /^\*\*([^*]+?[.!?])\*\*/.exec(raw.trim())
  return clip(plain(lead ? lead[1] : raw), MAX_ITEM_LENGTH)
}

interface Section {
  heading: string | null
  level: number
  items: string[]
  paragraphs: string[]
}

function sections(text: string): Section[] {
  const out: Section[] = [{ heading: null, level: 0, items: [], paragraphs: [] }]
  let open: string | null = null // the bullet being read: wrapped lines continue it
  let para: string | null = null
  const close = () => {
    const s = out[out.length - 1]
    if (open !== null) s.items.push(open)
    if (para !== null) s.paragraphs.push(para)
    open = null
    para = null
  }
  for (const line of text.split(/\r?\n/)) {
    const h = HEADING.exec(line.trim())
    if (h) {
      close()
      out.push({ heading: h[2].replace(/\*\*/g, '').trim(), level: h[1].length, items: [], paragraphs: [] })
      continue
    }
    const b = BULLET.exec(line)
    if (b) {
      close()
      open = b[1]
    } else if (open !== null && line.trim()) {
      open += ' ' + line.trim()
    } else if (line.trim()) {
      para = para === null ? line.trim() : `${para} ${line.trim()}`
    } else {
      close()
    }
  }
  close()
  return out
}

// Never another section: a release without "What's new" would show its install steps as its changes.
function changeItems(all: Section[]): string[] {
  const chosen = all.find((s) => s.heading && WHATS_NEW.test(s.heading) && s.items.length) ?? (all[0].items.length ? all[0] : null)
  return chosen ? chosen.items.map(itemText).filter(Boolean) : []
}

const usable = (raw: string | null): raw is string => !!raw?.trim() && raw.trim() !== 'No content.'

export function releaseNotesFrom(raw: string | null, version: string): ReleaseNotes | null {
  if (!usable(raw)) return null
  const items = changeItems(sections(raw))
  if (!items.length) return null
  return { version, items: items.slice(0, MAX_ITEMS), totalItems: items.length }
}

export function releaseSummary(raw: string | null): string | null {
  if (!usable(raw)) return null
  const all = sections(raw)
  const items = changeItems(all)
  if (items.length) return clip(items.map((i) => (/[.!?:]$/.test(i) ? i : `${i}.`)).join(' '), MAX_SUMMARY_LENGTH)
  const intro = all.find((s) => s.level <= 1 && s.paragraphs.length)?.paragraphs[0]
  if (!intro) return null
  const text = plain(intro)
  return clip(/^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text, MAX_SUMMARY_LENGTH)
}

export function notesSince(releases: FoundUpdate[], current: string): { notes: ReleaseNotes[]; older: number } {
  const newer = releases.filter((r) => isNewer(r.version, current))
  const notes = newer.slice(0, MAX_NOTES).flatMap((r) => releaseNotesFrom(r.notes, r.version) ?? [])
  return { notes, older: Math.max(0, newer.length - MAX_NOTES) }
}

export function releaseEntries(releases: FoundUpdate[]): ReleaseEntry[] {
  return releases.slice(0, MAX_RELEASES).map((r) => ({ version: r.version, date: r.publishedAt ?? null, summary: releaseSummary(r.notes), url: r.releaseUrl }))
}
