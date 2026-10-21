import type { ChatMessage, ProjectJson, VersionInfo } from './api'

export type ProjectNote = NonNullable<ProjectJson['notes']>[number]

const isNote = (e: unknown): e is ProjectNote =>
  typeof e === 'object' && e !== null && 'version' in e && typeof e.version === 'number' && 'text' in e && typeof e.text === 'string' &&
  'at' in e && typeof e.at === 'string' && 'applied' in e && Array.isArray(e.applied)

/** The notes list of a project.json: [] when it has none yet, null when the list is there but damaged. */
export function readNotes(raw: unknown): ProjectNote[] | null {
  if (raw === undefined) return []
  return Array.isArray(raw) && raw.every(isNote) ? raw : null
}

/**
 * One line per version saying what changed, for the version menu: the note that made it, in the
 * person's own words ("“music too loud”"), or the change made by hand ("New cover").
 *
 * The note that made version N is one tagged N, with changes, that N's own project.json copy
 * (versions/vN/project.json, `copies[N]`) does not hold. The engine takes that copy when N's final
 * render starts, and the AI editor saves the note after the render, so the copy never holds it.
 * A note tagged N that the copy does hold was saved before N existed: its own final render failed
 * and it kept the number its edit would have got (docs/versions.md).
 *
 * A change made by hand is the main process's own "Version N: …" message (describe.ts
 * versionMessage), which it writes only after that version's final render succeeded.
 *
 * Without either, Version 1 is the first edit and any other version says the change was not recorded.
 */
export function versionChanges(
  versions: VersionInfo[],
  chat: ChatMessage[],
  notes: ProjectNote[],
  copies: Record<number, ProjectNote[]>
): Map<number, string> {
  const key = (e: ProjectNote): string => JSON.stringify([e.version, e.at, e.text])
  // every note saved so far: the project's own list, then any only a copy still holds
  const all = new Map<string, ProjectNote>()
  for (const e of [...notes, ...Object.values(copies).flat()]) if (!all.has(key(e))) all.set(key(e), e)
  const out = new Map<number, string>()
  for (const v of versions) {
    const copy = copies[v.n]
    const held = new Set(copy?.map(key))
    const made = copy && [...all.values()].find((e) => e.version === v.n && e.applied.length > 0 && !held.has(key(e)))
    if (made) {
      out.set(v.n, made.text.trim() ? `“${made.text.trim()}”` : 'Your note with attached files')
      continue
    }
    let byHand: string | null = null
    for (const m of chat) if (!byHand && m.from === 'editor' && m.version === v.n) byHand = handChange(m.text, v.n)
    out.set(v.n, byHand ?? (v.n === 1 ? 'First edit' : 'Changes not recorded'))
  }
  return out
}

/** "New cover" from "Version 3: new cover."; null for anything else, including "Version 3 is ready." (no change named). */
function handChange(text: string, v: number): string | null {
  const m = new RegExp(`^Version ${v}: (.+?)\\.?$`, 's').exec(text.trim())
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : null
}
