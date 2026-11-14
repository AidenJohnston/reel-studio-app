// The main-process side of the Plan document (@reelstudio/ai plan.ts, docs/plan.md): the plan:* IPC channels.
// A change is a held edit (jobs.hold), so nothing else writes the project meanwhile; the AI's proposal is a
// job like a note. The AI and the job manager come in from index.ts, so this file is tested without Electron
// (test/plan-ipc.test.ts).
import type { IpcMainInvokeEvent } from 'electron'
import type { AI } from './ai-types'
import type { Emit, JobFn } from './jobs'
import type { AppState } from './store'
import type { ProjectJson, ReelPlan } from '../shared/api'
import { planAsScript } from '../shared/plan'
import { PLAN_CHANGE_KINDS, type FirstEdit, type PlanChange } from '../shared/plan-doc'

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void

export interface PlanIpcDeps {
  handle: Handle
  ai: () => AI
  projectDir: (slug: string) => string
  hold: <T>(slug: string, fn: (owner: string) => Promise<T>) => Promise<T>
  start: (slug: string, kind: 'plan', fn: JobFn) => string
  /** the reel's first edit: running now, made a version, or its last try made none (main/index.ts) */
  firstEdit: (slug: string) => Promise<FirstEdit>
  /** the reel's app.json (main/store.ts readAppState) */
  appState: (slug: string) => Promise<Pick<AppState, 'planHeld'>>
  /** starts Version 1 (main/index.ts startFirstEdit): refused (BUSY) while a job runs on the reel; `record` goes
   * into app.json in the write that starts it */
  startFirstEdit: (slug: string, record: (s: AppState) => void) => string
}

const NOT_AVAILABLE = { code: 'PLAN_UNAVAILABLE', userMessage: 'This version of Reel Studio cannot plan videos yet.' }
const NOT_HELD = { code: 'NOT_HELD', userMessage: 'Version 1 is not waiting for this plan any more.' }

/**
 * The first edit of a planned reel whose Version 1 waits for the creator (app.json planHeld; main/index.ts runs this
 * in place of ai.firstEdit, after the copy and the listening model): the filming plan's hook and beats become the
 * Plan document's script draft, unless the document already has a script (a proposal tried again keeps the
 * creator's rewrite and lock), then the AI proposes the rest. Its summary is the reply; no version is made.
 */
export async function proposeFirstEdit(ai: AI, dir: string, filming: ReelPlan | undefined, emit: Emit, signal: AbortSignal, owner: string | null): Promise<{ summary: string }> {
  if (!ai.plan || !ai.proposePlan) throw NOT_AVAILABLE
  const script = (await ai.plan.get(dir)).plan?.script
  if (filming && !script?.locked && script?.draft == null && script?.rewrite == null) {
    const { hook, script: text } = planAsScript(filming)
    await ai.plan.change(dir, { kind: 'script', draft: { hook, script: text, onScreenText: [] } })
  }
  const r = await ai.proposePlan(dir, (e) => emit(e), signal, owner ? { owner } : undefined)
  return { summary: r.summary }
}

function checkedChange(c: unknown): PlanChange {
  const kind = (c as { kind?: unknown } | null)?.kind
  if (!PLAN_CHANGE_KINDS.includes(kind as PlanChange['kind'])) throw { code: 'BAD_PLAN_CHANGE', userMessage: 'Something went wrong saving your plan. Try again.' }
  return c as PlanChange
}

/**
 * A hand edit (projects:update from the Pictures tab, "Edit it myself", the timeline) of `broll` or `cut`, before
 * it is saved: in a planned project the plan's rows follow it in the same write, so an added picture is an
 * approved row, a moved one keeps its new words, and a removed one is rejected and never comes back.
 */
export async function withPlanFollowing(ai: AI, projectDir: string, p: ProjectJson, changed: string[]): Promise<ProjectJson> {
  if (!p.plan?.broll.length || !changed.some((k) => k === 'broll' || k === 'cut')) return p
  if (!ai.plan) throw NOT_AVAILABLE
  return ai.plan.followHandEdit(projectDir, p)
}

export function registerPlanIpc(d: PlanIpcDeps): void {
  const plan = () => d.ai().plan ?? (() => { throw NOT_AVAILABLE })()
  d.handle('plan:get', async (_e, slug: string) => plan().get(d.projectDir(slug), await d.firstEdit(slug)))
  d.handle('plan:markdown', (_e, slug: string) => plan().markdown(d.projectDir(slug)))
  // the script, lock, a row's status, a row, the beats, music and cover, or a markdown import
  d.handle('plan:change', (_e, slug: string, change: unknown) => {
    const c = checkedChange(change)
    const dir = d.projectDir(slug)
    return d.hold(slug, () => plan().change(dir, c))
  })
  d.handle('plan:propose', (_e, slug: string) => {
    const ai = d.ai()
    if (!ai.proposePlan) throw NOT_AVAILABLE
    const dir = d.projectDir(slug)
    const jobId = d.start(slug, 'plan', async (emit, signal, { owner }) => {
      const r = await ai.proposePlan!(dir, (e) => emit(e), signal, owner ? { owner } : undefined)
      return { summary: r.summary }
    })
    return { jobId }
  })
  // Make Version 1 on a reel that waits for its plan: the hold goes in the write that starts the first edit, so a
  // start refused because a job runs (a second press, the proposal itself) leaves the reel waiting. project.json
  // exists, so it skips the copy; it builds only the rows approved by then (ai plan.ts prepareFirstEdit).
  d.handle('plan:makeVersion1', async (_e, slug: string) => {
    if (!(await d.appState(slug)).planHeld) throw NOT_HELD
    return { jobId: d.startFirstEdit(slug, (s) => void delete s.planHeld) }
  })
}
