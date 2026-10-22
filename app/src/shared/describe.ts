// "Version 3: bigger yellow subtitles, moved up." Says in plain words what an "Edit it myself"
// change did, so the chat and the version buttons mean something. Keep free of Node and DOM imports.
import type { DropResult, ProjectJson } from './api'
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
