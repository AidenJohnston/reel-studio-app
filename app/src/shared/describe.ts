// "Version 3: bigger yellow subtitles, moved up." Says in plain words what an "Edit it myself"
// change did, so the chat and the version buttons mean something. Keep free of Node and DOM imports.
import type { DropResult, EditFact, ProjectJson, Word } from './api'
import { keptIds } from './cut'
import { isMirrored } from './mirror'

type Style = Record<string, unknown>

const size = (s: Style): number => Number(s.size ?? 105)
const pos = (s: Style): number => Number(s.position ?? 0.75)
const look = (s: Style): string => (s.box ? 'box' : String(s.color ?? '#FFFFFF').toUpperCase() === '#FFFFFF' ? 'white' : 'yellow')
const name = (p: string | null | undefined): string =>
  (p ?? '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ?? ''

function subtitles(before: ProjectJson['captions'], after: ProjectJson['captions']): string[] {
  if (!after) return []
  if (before?.enabled !== false && after.enabled === false) return ['no subtitles']
  if (before?.enabled === false && after.enabled !== false) return ['subtitles back on']
  const a = (before?.style ?? {}) as Style
  const b = (after.style ?? {}) as Style
  const words: string[] = []
  if (size(b) > size(a)) words.push('bigger')
  if (size(b) < size(a)) words.push('smaller')
  const lb = look(b)
  if (lb !== look(a)) words.push(lb === 'box' ? 'boxed' : lb)
  const out: string[] = []
  if (words.length) out.push(`${words.join(' ')} subtitles`)
  if (pos(b) < pos(a) - 0.01) out.push(out.length ? 'moved up' : 'subtitles moved up')
  if (pos(b) > pos(a) + 0.01) out.push(out.length ? 'moved down' : 'subtitles moved down')
  const fixes = (after.corrections?.length ?? 0) - (before?.corrections?.length ?? 0)
  if (fixes > 0) out.push(fixes === 1 ? 'fixed a word' : `fixed ${fixes} words`)
  return out
}

/** A short lower-case phrase, or '' if nothing visible changed. `cutDelta` = words brought back (+) or cut (-). */
export function describeChange(before: ProjectJson, patch: Partial<ProjectJson>, cutDelta = 0): string {
  const parts: string[] = []
  if (patch.sources && isMirrored({ sources: patch.sources }) !== isMirrored(before)) {
    parts.push(isMirrored({ sources: patch.sources }) ? 'flipped the picture' : 'picture back the way you filmed it')
  }
  if (cutDelta > 0) parts.push(cutDelta === 1 ? 'brought back a word' : `brought back ${cutDelta} words`)
  if (cutDelta < 0) parts.push(cutDelta === -1 ? 'cut a word' : `cut ${-cutDelta} words`)
  if (patch.captions) parts.push(...subtitles(before.captions, patch.captions))
  if (patch.music) {
    const m = patch.music
    if (m.enabled === false || !m.track) {
      if (before.music?.enabled && before.music.track) parts.push('no music')
    } else if (m.track !== before.music?.track || before.music?.enabled === false) parts.push(`new song "${name(m.track)}"`)
    else if (m.level && m.level !== before.music?.level) parts.push(m.level === 'quiet' ? 'quieter music' : 'music volume changed')
  }
  if (patch.broll) {
    const n = patch.broll.length - (before.broll?.length ?? 0)
    if (n > 0) parts.push(n === 1 ? 'added a picture' : `added ${n} pictures`)
    if (n < 0) parts.push(n === -1 ? 'removed a picture' : `removed ${-n} pictures`)
  }
  if (patch.cover) {
    if ((patch.cover.text ?? null) !== (before.cover?.text ?? null)) parts.push(patch.cover.text ? 'new words on the cover' : 'no words on the cover')
    else if (patch.cover.atSourceTime !== before.cover?.atSourceTime) parts.push('new cover')
  }
  return parts.join(', ')
}

/** What a receipt's facts changed, by kind: the few words a version title uses, and the summary's words. */
type Group = 'flip' | 'cut' | 'pauses' | 'subtitles' | 'music' | 'pictures' | 'zooms' | 'cover' | 'post'
interface Change { group: Group; title: string; said: string }

const MUSIC_LEVELS = ['quiet', 'under-voice', 'loud-intro']

function changes(facts: EditFact[], words: Word[]): Change[] {
  // SAFETY: each fact's before/after is the project.json value at its `kind` (engine net_changes), so
  // the casts below name the schema's own types for cut.keep, captions.*, zooms and sources.
  const at = (kind: string): EditFact | undefined => facts.find((f) => f.kind === kind)
  const out: Change[] = []
  const mirrored = (s: unknown): boolean => (s as { mirror?: boolean } | null)?.mirror === true
  const flips = facts.filter((f) => f.kind === 'source' && mirrored(f.before) !== mirrored(f.after)).map((f) => mirrored(f.after))
  if (flips.length) {
    out.push(flips.every(Boolean)
      ? { group: 'flip', title: 'flipped video', said: 'flipped the picture' }
      : { group: 'flip', title: 'video as filmed', said: 'picture back the way you filmed it' })
  }
  const keep = at('cut.keep')
  if (keep) {
    const delta = keptIds(words, keep.after as Range[]).length - keptIds(words, keep.before as Range[]).length
    if (delta > 0) out.push({ group: 'cut', title: 'longer cut', said: delta === 1 ? 'brought back a word' : `brought back ${delta} words` })
    else if (delta < 0) out.push({ group: 'cut', title: 'shorter cut', said: delta === -1 ? 'cut a word' : `cut ${-delta} words` })
    else out.push({ group: 'cut', title: 'different takes', said: 'picked different takes' })
  }
  const gap = at('cut.gapCap')
  if (gap) {
    const w = Number(gap.after) < Number(gap.before) ? 'tighter pauses' : 'longer pauses'
    out.push({ group: 'pauses', title: w, said: w })
  }
  const caps = facts.filter((f) => f.kind.startsWith('captions.'))
  if (caps.length) {
    const side = (k: 'before' | 'after'): NonNullable<ProjectJson['captions']> => {
      const c: Record<string, unknown> = { style: {} }
      for (const f of caps) {
        if (f.kind === 'captions.style') (c.style as Style)[String(f.field)] = f[k]
        else c[f.kind.slice('captions.'.length)] = f[k]
      }
      return c as NonNullable<ProjectJson['captions']>
    }
    const said = subtitles(side('before'), side('after'))
    const first = said[0] ?? ''
    out.push({
      group: 'subtitles',
      title: first.includes('subtitles') ? first : said.length ? 'fixed subtitles' : 'new subtitle look',
      said: said.join(', ') || 'changed the subtitles'
    })
  }
  const music = facts.filter((f) => f.kind.startsWith('music.'))
  if (music.length) {
    const track = at('music.track')
    const level = at('music.level')
    const on = at('music.enabled')
    if (on?.after === false || (track && !track.after)) out.push({ group: 'music', title: 'no music', said: 'no music' })
    else if (track) out.push({ group: 'music', title: 'new song', said: `new song "${name(track.after as string)}"` })
    else if (on?.after === true) out.push({ group: 'music', title: 'music back on', said: 'music back on' })
    else if (level && MUSIC_LEVELS.includes(String(level.after)) && MUSIC_LEVELS.includes(String(level.before))) {
      const w = MUSIC_LEVELS.indexOf(String(level.after)) > MUSIC_LEVELS.indexOf(String(level.before)) ? 'louder music' : 'quieter music'
      out.push({ group: 'music', title: w, said: w })
    } else out.push({ group: 'music', title: 'music adjusted', said: 'music adjusted' })
  }
  const broll = facts.filter((f) => f.kind === 'broll')
  if (broll.length) {
    const n = broll.filter((f) => !f.before).length - broll.filter((f) => !f.after).length
    if (n > 0) out.push({ group: 'pictures', title: n === 1 ? 'a new picture' : `${n} new pictures`, said: n === 1 ? 'added a picture' : `added ${n} pictures` })
    else if (n < 0) out.push({ group: 'pictures', title: 'fewer pictures', said: n === -1 ? 'removed a picture' : `removed ${-n} pictures` })
    else out.push({ group: 'pictures', title: 'pictures changed', said: broll.length === 1 ? 'changed a picture' : `changed ${broll.length} pictures` })
  }
  const zooms = at('zooms')
  if (zooms) {
    const n = (zooms.after as unknown[]).length - (zooms.before as unknown[]).length
    const z = n > 0 ? 'more zoom-ins' : n < 0 ? ((zooms.after as unknown[]).length ? 'fewer zoom-ins' : 'no zoom-ins') : 'new zoom-ins'
    out.push({ group: 'zooms', title: z, said: z })
  }
  if (facts.some((f) => f.kind.startsWith('cover.'))) {
    const text = at('cover.text')
    if (text) out.push(text.after ? { group: 'cover', title: 'new cover words', said: 'new words on the cover' } : { group: 'cover', title: 'no cover words', said: 'no words on the cover' })
    else out.push({ group: 'cover', title: 'new cover', said: 'new cover' })
  }
  if (facts.some((f) => f.kind.startsWith('post.'))) out.push({ group: 'post', title: 'new post caption', said: 'new post caption' })
  return out
}

type Range = { from: string; to: string }

/** The same words for a version's receipt facts (engine project.net_changes), whoever made the change. */
export function describeFacts(facts: EditFact[], words: Word[]): string {
  return changes(facts, words).map((c) => c.said).join(', ')
}

/** "Tighter pauses, bigger subtitles": a version's short name, from its receipt facts. '' = nothing to name. */
export function versionTitle(facts: EditFact[], words: Word[]): string {
  const t = changes(facts, words).map((c) => c.title)
  const s = t.length > 2 ? `${t[0]}, ${t[1]} and more` : t.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Words that claim a kind of change. A phrase is removed once matched, so "post caption" is not also a
// subtitle and "flipped the picture" not also a picture. null = a kind the receipts never record.
const CLAIMS: [Group | null, RegExp][] = [
  ['post', /\b(post caption|hashtags?)\b/g],
  ['cover', /\b(cover|thumbnail)s?\b/g],
  ['flip', /\b(flip\w*|mirror\w*)( the)?( picture| video)?|\b(picture|video) (back )?(the way you filmed it|as filmed)/g],
  ['cut', /\b(cuts?|trim\w*|takes?|retakes?|brought back)\b/g],
  ['pauses', /\b(pauses?|gaps?|silences?|pace|pacing)\b/g],
  ['subtitles', /\b(subtitles?|captions?)\b/g],
  ['music', /\b(music|songs?|soundtrack|volume|audio)\b/g],
  ['pictures', /\b(pictures?|images?|photos?|b-? ?roll|visuals?|clips?|gifs?|animations?|graphics?)\b/g],
  ['zooms', /\bzoom/g],
  [null, /\b(transitions?|filters?|speed|slow[- ]?mo\w*|effects?|stickers?|emojis?|crop\w*|brightness)\b/g]
]

function claims(text: string): Set<Group | null> {
  let rest = text.toLowerCase()
  const found = new Set<Group | null>()
  for (const [group, re] of CLAIMS) {
    if (rest.search(re) < 0) continue
    found.add(group)
    rest = rest.replace(re, ' ')
  }
  return found
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
// Words that say which way or how much something changed. A rewording may only use the ones the app's own words use.
const AMOUNTS = new RegExp(`\\b(\\d+|${NUMBER_WORDS.join('|')}|bigger|larger|smaller|louder|quieter|softer|more|fewer|less|tighter|looser|longer|shorter|faster|slower|higher|lower|up|down|on|off|no|back)\\b`, 'g')
const amounts = (text: string): Set<string> =>
  new Set([...text.toLowerCase().matchAll(AMOUNTS)].map(([w]) => (NUMBER_WORDS.includes(w) ? String(NUMBER_WORDS.indexOf(w)) : w)))

/**
 * A small model's rewording of a version's title and summary, kept only when it names at least one
 * change, every change it names is in the receipt facts, every direction or number it states is one
 * the app's own words state, and it reads like a title. null = keep the app's own words.
 */
export function acceptRewrite(text: { title: string; summary: string }, facts: EditFact[], words: Word[]): { title: string; summary: string } | null {
  const own = changes(facts, words)
  const has = new Set<Group | null>(own.map((c) => c.group))
  const ownAmounts = amounts(own.map((c) => `${c.title} ${c.said}`).join(' '))
  const title = text.title.trim()
  const summary = text.summary.trim().replace(/\.$/, '')
  if (title.split(/\s+/).length > 6 || title.length > 48 || summary.length > 160 || /[\n—–:"“”]/.test(title + summary) || title.endsWith('.')) return null
  for (const t of [title, summary]) {
    const named = claims(t)
    if (!named.size || [...named].some((g) => !has.has(g)) || [...amounts(t)].some((a) => !ownAmounts.has(a))) return null
  }
  return { title, summary }
}

/** "Version 3: bigger yellow subtitles, moved up." */
export function versionMessage(version: number, change: string): string {
  return change ? `Version ${version}: ${change}.` : `Version ${version} is ready.`
}

// ---- what happened to files added to the Library ----------------------------------------------

const NOUN: Record<string, [string, string]> = {
  raw: ['video of you', 'videos of you'],
  broll: ['extra clip', 'extra clips'],
  music: ['song', 'songs'],
  images: ['picture', 'pictures'],
  exports: ['finished video', 'finished videos']
}

function why(r: DropResult): string {
  const reason = r.reason ?? ''
  if (/folder/i.test(reason)) return 'a folder'
  if (/find|open|read/i.test(reason) && !/video, song or picture/i.test(reason)) return "I couldn't open it"
  return 'not a video, song or picture'
}

function and(list: string[]): string {
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** "Added 1 song and 1 picture. Skipped notes.txt (not a video, song or picture)." */
export function describeSorted(results: DropResult[]): string {
  const count = new Map<string, number>()
  const skipped: string[] = []
  for (const r of results) {
    if (r.bin) count.set(r.bin, (count.get(r.bin) ?? 0) + 1)
    else skipped.push(`${r.name} (${why(r)})`)
  }
  const added = [...count].map(([bin, n]) => {
    const [one, many] = NOUN[bin] ?? ['file', 'files']
    return `${n} ${n === 1 ? one : many}`
  })
  const out: string[] = []
  if (added.length) out.push(`Added ${and(added)} to your Library.`)
  if (skipped.length) out.push(`Skipped ${and(skipped)}.`)
  return out.join(' ')
}
