import type { VersionInfo, VersionMade } from './api'

/**
 * One line per version saying what changed, for the version menu: the note that made it, in the
 * person's own words ("“music too loud”"), or the change made by hand ("New cover").
 *
 * Only the record written when the version was made (`made`, main/jobs.ts) counts. Versions without
 * one, including every version made before those records existed, say the change was not recorded
 * (Version 1 is the first edit). Reconstructing it later from chat replies or project.json copies
 * credited the wrong note too often: AI replies are free text, a failed final render keeps the number
 * its edit would have got, and an unchanged rerender retakes the version's copy.
 */
export function versionChanges(versions: VersionInfo[], made: VersionMade[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const v of versions) {
    const record = made.find((r) => r.version === v.n)
    const what = record?.summary.trim() ?? ''
    if (!record) out.set(v.n, v.n === 1 ? 'First edit' : 'Changes not recorded')
    else if (record.by === 'note') out.set(v.n, what ? `“${what}”` : 'Your note with attached files')
    else out.set(v.n, what ? what.charAt(0).toUpperCase() + what.slice(1) : 'Changed by hand')
  }
  return out
}
