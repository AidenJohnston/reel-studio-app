import type { ProjectJson, VersionInfo, VersionMade } from './api'

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
 * The record written when the version was made (`made`, main/jobs.ts) decides. Versions from before
 * those records fall back, best effort, to the project.json copies (versions/vN/project.json,
 * `copies[N]`): the note that made N is one tagged N, with changes, that N's own copy does not hold.
 * The engine takes that copy when N's final render starts and the AI editor saves the note after the
 * render, so a note tagged N that the copy does hold was saved before N existed (its final render
 * failed and it kept the number its edit would have got, docs/versions.md). An unchanged rerender
 * retakes the copy, so after one this fallback finds nothing. Chat text is never evidence: an AI reply
 * can say anything, including "Version 2: …".
 *
 * Without either, Version 1 is the first edit and any other version says the change was not recorded.
 */
export function versionChanges(
  versions: VersionInfo[],
  made: VersionMade[],
  notes: ProjectNote[],
  copies: Record<number, ProjectNote[]>
): Map<number, string> {
  const key = (e: ProjectNote): string => JSON.stringify([e.version, e.at, e.text])
  // every note saved so far: the project's own list, then any only a copy still holds
  const all = new Map<string, ProjectNote>()
  for (const e of [...notes, ...Object.values(copies).flat()]) if (!all.has(key(e))) all.set(key(e), e)
  const quoted = (text: string): string => (text.trim() ? `“${text.trim()}”` : 'Your note with attached files')
  const out = new Map<number, string>()
  for (const v of versions) {
    const record = made.find((r) => r.version === v.n)
    if (record) {
      const what = record.summary.trim()
      out.set(v.n, record.by === 'note' ? quoted(what) : what ? what.charAt(0).toUpperCase() + what.slice(1) : 'Changed by hand')
      continue
    }
    const copy = copies[v.n]
    const held = new Set(copy?.map(key))
    const note = copy && [...all.values()].find((e) => e.version === v.n && e.applied.length > 0 && !held.has(key(e)))
    out.set(v.n, note ? quoted(note.text) : v.n === 1 ? 'First edit' : 'Changes not recorded')
  }
  return out
}
