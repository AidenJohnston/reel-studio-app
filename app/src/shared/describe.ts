// "Version 3: bigger yellow subtitles, moved up." Says in plain words what an "Edit it myself"
// change did, so the chat and the version buttons mean something. Keep free of Node and DOM imports.
import type { ChatMessage, DropResult, EditFact, ProjectJson, VersionInfo, Word } from './api'
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
    if (delta > 0) out.push({ group: 'cut', title: 'more words back', said: delta === 1 ? 'brought back a word' : `brought back ${delta} words` })
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

// What each kind of change can say, as words after tokens(): `markers` name the kind on their own,
// `nouns` may appear without meaning anything more, and `dirs` map a word to the direction it claims.
// "cut" always means fewer words, so a restore is titled "more words back", never "longer cut".
// The order decides a part that has markers of two kinds ("post caption" is the post, not subtitles).
interface Lexicon { markers: string[]; nouns: string[]; dirs: Record<string, string> }
const LEXICON: [Group, Lexicon][] = [
  ['post', { markers: ['post', 'hashtag'], nouns: ['post', 'subtitle', 'hashtag'], dirs: { new: 'new', changed: 'new' } }],
  // "words" is a claim of its own here (the cover's text), so "new cover words" needs a text fact
  ['cover', { markers: ['cover', 'thumbnail'], nouns: ['cover', 'thumbnail', 'on'], dirs: { new: 'new', no: 'none', word: 'words' } }],
  ['flip', {
    markers: ['flip', 'flipped', 'mirror', 'mirrored', 'filmed'],
    nouns: ['picture', 'video', 'way', 'you', 'it'],
    dirs: { flip: 'flipped', flipped: 'flipped', mirror: 'flipped', mirrored: 'flipped', filmed: 'as-filmed', back: 'as-filmed', as: 'as-filmed' }
  }],
  ['pauses', {
    markers: ['pause', 'gap', 'silence'],
    nouns: ['pause', 'gap', 'silence'],
    dirs: { tighter: 'shorter', shorter: 'shorter', longer: 'longer', more: 'longer', room: 'longer' }
  }],
  ['subtitles', {
    markers: ['subtitle'],
    nouns: ['subtitle', 'word', 'look', 'moved'],
    dirs: {
      bigger: 'bigger', smaller: 'smaller', yellow: 'yellow', white: 'white', boxed: 'boxed', up: 'up', down: 'down',
      no: 'off', off: 'off', back: 'on', on: 'on', fixed: 'fixed', corrected: 'fixed', new: 'changed', changed: 'changed'
    }
  }],
  ['music', {
    markers: ['music', 'song', 'soundtrack', 'volume'],
    nouns: ['music', 'song', 'soundtrack', 'volume'],
    dirs: { no: 'none', off: 'none', new: 'new', different: 'new', back: 'on', on: 'on', louder: 'louder', quieter: 'quieter', adjusted: 'adjusted', changed: 'adjusted' }
  }],
  ['pictures', {
    markers: ['picture', 'b-roll', 'clip', 'gif', 'animation'],
    nouns: ['picture', 'b-roll', 'clip', 'gif', 'animation'],
    dirs: { new: 'more', added: 'more', more: 'more', fewer: 'fewer', removed: 'fewer', changed: 'changed' }
  }],
  ['zooms', {
    markers: ['zoom', 'zoom-in'],
    nouns: ['zoom', 'zoom-in'],
    dirs: { more: 'more', added: 'more', fewer: 'fewer', no: 'none', new: 'changed', changed: 'changed' }
  }],
  ['cut', {
    markers: ['cut', 'trim', 'trimmed', 'take', 'retake'],
    // words and takes are claims too: "Cut 2 takes" is not "cut 2 words"
    nouns: [],
    dirs: {
      cut: 'fewer', trimmed: 'fewer', trim: 'fewer', shorter: 'fewer', more: 'more', back: 'more', brought: 'more', different: 'swapped', picked: 'swapped',
      word: 'words', take: 'takes', retake: 'takes'
    }
  }]
]

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const SYNONYMS: Record<string, string> = { caption: 'subtitle', image: 'picture', photo: 'picture', larger: 'bigger', softer: 'quieter' }
// Words that say nothing about the change. "a" and "an" are not here: they mean one.
const GLUE = new Set(['the', 'your', 'of', 'in', 'to', 'now', 'made'])
// A song's name, which the app writes in quotes: it is a name, not a claim, and is left out of every check.
const QUOTED = /"[^"]*"/g

/** Lower-case words, with number words as digits, plurals as singular and the few synonyms as the app's word. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(QUOTED, ' ').split(/[^a-z0-9-]+/).filter(Boolean).map((w) => {
    const n = NUMBER_WORDS.indexOf(w)
    const one = n >= 0 ? String(n) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
    return SYNONYMS[one] ?? one
  })
}

/** What one part of a sentence claims: a kind of change, its directions and the number it gives. */
interface Claim { group: Group; dirs: string[]; count?: number }

/** `words` read as a claim about `group`, or null when a word means nothing to that kind of change. */
function claimAbout(group: Group, words: string[]): Claim | null {
  const lex = LEXICON.find(([g]) => g === group)![1]
  const dirs = new Set<string>()
  let count: number | undefined
  for (const w of words) {
    if (GLUE.has(w)) continue
    const n = /^\d+$/.test(w) ? Number(w) : w === 'a' || w === 'an' ? 1 : undefined
    if (n !== undefined) {
      if (count !== undefined) return null
      count = n
    } else if (lex.dirs[w]) dirs.add(lex.dirs[w])
    else if (!lex.nouns.includes(w)) return null
  }
  return dirs.size ? { group, dirs: [...dirs], count } : null
}

const splitParts = (t: string): string[] => t.replace(QUOTED, ' ').split(/,|\band\b/i).map((p) => p.trim()).filter(Boolean)

/** What the app's own title and summary for a change claim: each direction, with the number the app gives it. */
function ownClaims(c: Change): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>()
  for (const part of [...splitParts(c.title), ...splitParts(c.said)]) {
    const claim = claimAbout(c.group, tokens(part))
    for (const d of claim?.dirs ?? []) out.set(d, out.get(d) ?? claim!.count)
  }
  return out
}

/**
 * A small model's rewording of a version's title and summary. Kept only when it reads like a title and
 * every part (between commas or "and") means something the receipt says: each part is read as a claim
 * (kind of change, direction, number) in that kind's own words, and the receipt's change of that kind
 * must make the same claim. A number must be the app's own; "a" counts as one. In the summary, a
 * direction the app gives a number to must keep that number. A part that names no kind continues the
 * kind before it, or is any kind it is true of; a last "more" stands for changes not named.
 * A quoted name must be the song's own. null = keep the app's own words.
 */
export function acceptRewrite(text: { title: string; summary: string }, facts: EditFact[], words: Word[]): { title: string; summary: string } | null {
  const own = changes(facts, words)
  const songs = new Set(own.flatMap((c) => c.said.match(QUOTED) ?? []))
  const straight = (s: string): string => s.replace(/[“”]/g, '"')
  const title = text.title.trim()
  const summary = text.summary.trim().replace(/\.$/, '')
  if (title.split(/\s+/).length > 7 || title.length > 48 || summary.length > 160 || /[\n—–:]/.test(title + summary) || title.endsWith('.')) return null
  const meant = new Map(own.map((c) => [c.group, ownClaims(c)]))
  const holds = (c: Claim, inSummary: boolean): boolean => {
    const mine = meant.get(c.group)
    if (!mine || !c.dirs.every((d) => mine.has(d))) return false
    const counts = c.dirs.map((d) => mine.get(d)).filter((n): n is number => n !== undefined)
    if (c.count !== undefined) return counts.length > 0 && counts.every((n) => n === c.count)
    return !inSummary || !counts.length
  }
  for (const [t, inSummary] of [[straight(title), false], [straight(summary), true]] as const) {
    if ((t.match(QUOTED) ?? []).some((q) => !songs.has(q))) return null
    const parts = splitParts(t)
    const named = new Set<Group>()
    let group: Group | null = null
    for (const [i, part] of parts.entries()) {
      if (i > 0 && i === parts.length - 1 && part.toLowerCase() === 'more') {
        if (own.every((c) => named.has(c.group))) return null
        continue
      }
      const w = tokens(part)
      const marked = LEXICON.find(([, lex]) => w.some((x) => lex.markers.includes(x)))?.[0]
      // A part that reads as the kind before it is about that kind, true or not: "subtitles off and back
      // on" may not borrow "back on" from the music.
      const before = !marked && group ? claimAbout(group, w) : null
      const candidates: Group[] = marked ? [marked] : before ? [before.group] : own.map((c) => c.group)
      const claim: Claim | undefined = candidates.map((g) => claimAbout(g, w)).find((c): c is Claim => !!c && holds(c, inSummary))
      if (!claim) return null
      group = claim.group
      named.add(claim.group)
    }
    if (!named.size) return null
  }
  return { title, summary }
}

/** A version button's tooltip: what its receipt says it changed. A version rendered before receipts existed
 * keeps the editor's chat reply that carried its number, as it did then; a newer one never falls back to it. */
export function versionTooltip(v: Pick<VersionInfo, 'n' | 'facts' | 'beforeReceipts' | 'wording'>, chat: ChatMessage[], words: Word[]): string | undefined {
  if (v.facts) return versionMessage(v.n, v.wording?.summary ?? describeFacts(v.facts, words))
  if (!v.beforeReceipts) return undefined
  let reply: string | undefined
  for (const m of chat) if (m.from === 'editor' && m.version === v.n) reply = m.text
  return reply
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
