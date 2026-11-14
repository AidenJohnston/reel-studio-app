// Which model made a version, beside it (versions/vN/made-with.json, as title.json is): its line in the notes names it.
import { join } from 'node:path'
import type { AgentResult } from './ai-types'
import { writeJson } from './store'

/** Written only by the run that made the version: one numbered above `before`, the version the run started on. A run
 * that got a saved version back (a note that changed only the caption, which the engine renders as that version's
 * video) leaves its record alone, since a saved version is never rewritten (docs/versions.md); that run's model calls
 * are kept under work/ai-runs instead (ai provenance.ts writeKeptAiRun). A version a basic edit made has no model, and
 * no file. */
export async function recordMadeWith(dir: string, r: Pick<AgentResult, 'model' | 'version'>, before: number): Promise<void> {
  if (!r.model || r.version === undefined || r.version <= before) return
  await writeJson(join(dir, 'versions', `v${r.version}`, 'made-with.json'), { model: r.model })
}
