// What a version changed, as before → after rows, read from the project.json each version saved
// (versions/vN/project.json, docs/versions.md) and each render's length. Keep free of Node and DOM imports.
import type { ProjectJson } from './api'
import { look, name, OTHER_COLOR, pos, size } from './describe'
import { clock } from './progress'
import { gainOf, gainText, levelOf, momentKey, musicFades, secondsText, SFX_LEVELS, sfxName } from './sfx'

export interface VersionRow {
  label: string
  /** '' for something the version added that had no "before" worth naming */
  before: string
  after: string
  /** the exact values behind words, for a tooltip ("0 dB → −9 dB") */
  title?: string
}

type Style = Record<string, unknown>
const SIZE = (s: Style): string => (size(s) < 95 ? 'Small' : size(s) > 115 ? 'Big' : 'Medium')
const POSITION = (s: Style): string => (pos(s) < 0.69 ? 'Higher' : 'Lower')
// the colour the words are drawn in, as colorName says it; white stays 'Plain', the look with nothing added
const LOOK = (l: string): string =>
  l === 'box' ? 'Black box' : l === 'white' ? 'Plain' : l === OTHER_COLOR ? 'Another colour' : l.charAt(0).toUpperCase() + l.slice(1)
const subtitlesOn = (p: ProjectJson | null): boolean => !!p && p.captions?.enabled !== false
const song = (p: ProjectJson | null): string => (p?.music?.enabled && p.music.track ? `“${name(p.music.track)}”` : 'None')
const count = (n: number, one: string, many: string): string => (n === 0 ? 'None' : n === 1 ? `1 ${one}` : `${n} ${many}`)
const coverFrame = (p: ProjectJson | null): string => (p?.cover ? `The ${clock(p.cover.atSourceTime)} frame` : 'None')
const levelWord = (db: number): string => SFX_LEVELS.find((l) => l.key === levelOf(db))!.label
/** A picture as the rows compare it: what it shows, where, and how. */
const pictureKey = (b: NonNullable<ProjectJson['broll']>[number]): string => JSON.stringify([b.asset, b.anchor.from, b.anchor.to, b.treatment])
const CAPTION_SHOWN = 40
/** A post caption's start, on one line, cut at a word. */
function captionStart(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= CAPTION_SHOWN ? `“${t}”` : `“${t.slice(0, CAPTION_SHOWN).replace(/\s+\S*$/, '')}…”`
}

/**
 * `before` null: the first version, compared with the raw video (`lengths.before` = its length).
 * Lengths are seconds from each render; null when one is not known.
 */
export function versionRows(before: ProjectJson | null, after: ProjectJson, lengths: { before: number | null; after: number | null }): VersionRow[] {
  const rows: VersionRow[] = []
  const add = (label: string, a: string, b: string) => {
    if (a !== b) rows.push({ label, before: a, after: b })
  }
  if (lengths.before !== null && lengths.after !== null && Math.abs(lengths.before - lengths.after) >= 0.5) add('Length', clock(lengths.before), clock(lengths.after))

  const on = [subtitlesOn(before), subtitlesOn(after)]
  if (on[0] !== on[1]) add('Subtitles', on[0] ? 'On' : 'None', on[1] ? 'On' : 'None')
  else if (on[1] && before) {
    const a = (before.captions?.style ?? {}) as Style
    const b = (after.captions?.style ?? {}) as Style
    add('Subtitle size', SIZE(a), SIZE(b))
    add('Subtitle position', POSITION(a), POSITION(b))
    add('Subtitle look', LOOK(look(a)), LOOK(look(b)))
    const fixed = (after.captions?.corrections?.length ?? 0) - (before.captions?.corrections?.length ?? 0)
    if (fixed > 0) rows.push({ label: 'Words fixed', before: '', after: String(fixed) })
  }

  add('Music', song(before), song(after))
  if (before && song(before) === song(after) && after.music?.enabled && before.music?.level !== after.music?.level) {
    add('Music volume', before.music?.level === 'quiet' ? 'Quiet' : 'Normal', after.music?.level === 'quiet' ? 'Quiet' : 'Normal')
  }
  if (before && song(before) === song(after) && after.music?.enabled) {
    const [a, b] = [musicFades(before.music), musicFades(after.music)]
    add('Music fade-in', secondsText(a.fadeIn), secondsText(b.fadeIn))
    add('Music fade-out', secondsText(a.fadeOut), secondsText(b.fadeOut))
  }
  add('Sound effects', count(before?.sfx?.length ?? 0, 'sound effect', 'sound effects'), count(after.sfx?.length ?? 0, 'sound effect', 'sound effects'))
  const was = new Map((before?.sfx ?? []).map((x) => [momentKey(x.at), x]))
  for (const x of after.sfx ?? []) {
    const a = was.get(momentKey(x.at))
    if (!a || a.sound !== x.sound || gainOf(a) === gainOf(x)) continue
    // in the Sound tab's words; a level between two words reads as the nearest, so a change within one word says which way
    const [from, to] = [levelWord(gainOf(a)), levelWord(gainOf(x))]
    const now = from !== to ? to : gainOf(x) < gainOf(a) ? 'A bit quieter' : 'A bit louder'
    rows.push({ label: `${sfxName(x.sound).kind} volume`, before: from, after: now, title: `${gainText(gainOf(a))} → ${gainText(gainOf(x))}` })
  }
  add('Pictures', count(before?.broll?.length ?? 0, 'picture', 'pictures'), count(after.broll?.length ?? 0, 'picture', 'pictures'))
  // the same number of pictures, some of them different: the count above can't say so
  if (before && (before.broll?.length ?? 0) === (after.broll?.length ?? 0)) {
    const had = new Set((before.broll ?? []).map(pictureKey))
    const swapped = (after.broll ?? []).filter((b) => !had.has(pictureKey(b))).length
    if (swapped) rows.push({ label: 'Pictures swapped', before: '', after: String(swapped) })
  }
  add('Zooms', count(before?.zooms?.length ?? 0, 'zoom', 'zooms'), count(after.zooms?.length ?? 0, 'zoom', 'zooms'))
  add('Cover', coverFrame(before), coverFrame(after))
  add('Cover words', before?.cover?.text ? `“${before.cover.text}”` : 'None', after.cover?.text ? `“${after.cover.text}”` : 'None')
  // Version 1 always writes one, so only a later version's caption is news
  const [said, says] = [(before?.post?.caption ?? '').trim(), (after.post?.caption ?? '').trim()]
  if (before && said !== says) rows.push({ label: 'Post caption', before: said ? '' : 'None', after: says ? captionStart(says) : 'None' })
  return rows
}

const SIZE_ORDER = ['Small', 'Medium', 'Big']
const seconds = (c: string): number => c.split(':').reduce((t, n) => t * 60 + Number(n), 0)
// The line under a version names at most this many changes; What changed lists them all.
const FACTS_SHOWN = 3

/**
 * A version's line in the notes: a short fact made from its before → after rows, such as "Song, 1 sound effect,
 * 1 picture" or "Bigger yellow subtitles". '' when no row changed.
 */
export function versionFact(rows: VersionRow[]): string {
  const facts: string[] = []
  // a subtitle's size, look and place read as one change, where its first row was
  const sub = { at: -1, size: '', look: '', place: '' }
  for (const r of rows) {
    if (r.label.startsWith('Subtitle ') && sub.at < 0) sub.at = facts.length
    if (r.label === 'Length') facts.push(seconds(r.after) < seconds(r.before) ? 'shorter' : 'longer')
    else if (r.label === 'Subtitles') facts.push(r.after === 'None' ? 'no subtitles' : 'subtitles')
    else if (r.label === 'Subtitle size') sub.size = SIZE_ORDER.indexOf(r.after) > SIZE_ORDER.indexOf(r.before) ? 'bigger' : 'smaller'
    else if (r.label === 'Subtitle look') sub.look = r.after === 'Black box' ? 'boxed' : r.after === 'Another colour' ? 'recoloured' : r.after.toLowerCase()
    else if (r.label === 'Subtitle position') sub.place = r.after === 'Higher' ? 'higher' : 'lower'
    else if (r.label === 'Words fixed') facts.push(r.after === '1' ? '1 word fixed' : `${r.after} words fixed`)
    else if (r.label === 'Music') facts.push(r.after === 'None' ? 'no song' : r.before === 'None' ? 'song' : 'new song')
    else if (r.label === 'Music volume') facts.push(r.after === 'Quiet' ? 'quieter song' : 'louder song')
    else if (r.label === 'Music fade-in' || r.label === 'Music fade-out') {
      if (!facts.includes('song fades')) facts.push('song fades')
    } else if (r.label === 'Sound effects') facts.push(r.after === 'None' ? 'no sound effects' : r.after)
    else if (r.label === 'Pictures') facts.push(r.after === 'None' ? 'no pictures' : r.after)
    else if (r.label === 'Pictures swapped') facts.push(r.after === '1' ? '1 picture swapped' : `${r.after} pictures swapped`)
    else if (r.label === 'Post caption') facts.push(r.after === 'None' ? 'no post caption' : r.before === 'None' ? 'post caption' : 'new post caption')
    else if (r.label === 'Zooms') facts.push(r.after === 'None' ? 'no zooms' : r.after)
    else if (r.label === 'Cover') facts.push(r.before === 'None' ? 'cover' : 'new cover')
    else if (r.label === 'Cover words') facts.push(r.after === 'None' ? 'no cover words' : 'cover words')
    // one sound effect's level ("Whoosh volume")
    else if (!facts.includes('sound effect levels')) facts.push('sound effect levels')
  }
  // "bigger yellow subtitles"; a move on its own says where they went
  const looks = [sub.size, sub.look].filter(Boolean).join(' ')
  if (sub.at >= 0) facts.splice(sub.at, 0, looks ? `${looks} subtitles` : `${sub.place} subtitles`)
  const text = facts.length > FACTS_SHOWN + 1 ? `${facts.slice(0, FACTS_SHOWN).join(', ')} and ${facts.length - FACTS_SHOWN} more` : facts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
