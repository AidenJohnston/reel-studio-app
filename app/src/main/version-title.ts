// After a note makes a version, the creator's own AI connection may reword its title and summary
// with one small-model call. The app's own words (shared/describe.ts) stay unless the rewording names
// only changes in the version's receipts. Nothing waits for it: the version is already done.
import { join } from 'node:path'
import type { EditFact } from '../shared/api'
import { acceptRewrite, describeFacts, versionTitle } from '../shared/describe'
import type { AI } from './ai-types'
import { projectDir, readJson, readProject, readWords, writeJson } from './store'

export async function titleVersion(slug: string, n: number, reword: NonNullable<AI['rewordVersion']>, signal?: AbortSignal): Promise<void> {
  const vdir = join(projectDir(slug), 'versions', `v${n}`)
  const receipts = await readJson<{ renderId: string; facts: EditFact[] }[]>(join(vdir, 'receipts.json'), [])
  const facts = receipts.flatMap((r) => r.facts)
  if (!facts.length) return
  const words = await readWords(projectDir(slug), await readProject(slug))
  const title = versionTitle(facts, words)
  const out = await reword({ title, summary: describeFacts(facts, words) }, signal)
  const ok = out && acceptRewrite(out, facts, words)
  if (ok) await writeJson(join(vdir, 'title.json'), { renderId: receipts.at(-1)!.renderId, ...ok })
}
