import type { ChatMessage, ProjectJson, VersionInfo } from './api'

/**
 * One line per version saying what changed, for the version menu: the note that made it, in the
 * person's own words ("“music too loud”"), or the change made by hand ("New cover").
 *
 * A line is only taken from a record written once the final render had made that version, so at or
 * after its export.mp4 (`createdAt`). Numbers alone prove nothing: a note whose final render failed
 * still records the number its edit would have got (docs/versions.md), and a reply that changed
 * nothing carries the current version. Two records qualify:
 * - a project.json note that changed something, saved by the AI editor after the final render;
 * - the main process's own "Version 3: new cover." chat message (describe.ts versionMessage),
 *   written only after a change made by hand rendered.
 * Without one, Version 1 is the first edit and any other version says so plainly.
 */
export function versionChanges(versions: VersionInfo[], chat: ChatMessage[], notes: ProjectJson['notes'] = []): Map<number, string> {
  const out = new Map<number, string>()
  for (const v of versions) {
    const made = Date.parse(v.createdAt)
    const after = (iso: string): number | null => {
      const t = Date.parse(iso)
      return t >= made ? t : null
    }
    const records: { t: number; line: string }[] = []
    for (const n of notes) {
      const t = n.version === v.n && n.applied.length ? after(n.at) : null
      if (t !== null) records.push({ t, line: n.text.trim() ? `“${n.text.trim()}”` : 'Your note with attached files' })
    }
    for (const m of chat) {
      const line = m.from === 'editor' && m.version === v.n ? byHand(m.text, v.n) : null
      const t = line ? after(m.at) : null
      if (t !== null && line) records.push({ t, line })
    }
    records.sort((a, b) => a.t - b.t)
    out.set(v.n, records[0]?.line ?? (v.n === 1 ? 'First edit' : 'Changes not recorded'))
  }
  return out
}

/** "New cover" from "Version 3: new cover."; null for anything else, including "Version 3 is ready." (no change named). */
function byHand(text: string, v: number): string | null {
  const m = new RegExp(`^Version ${v}: (.+?)\\.?$`, 's').exec(text.trim())
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : null
}
