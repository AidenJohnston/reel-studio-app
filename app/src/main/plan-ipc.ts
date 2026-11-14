// The main-process side of the Plan document (@reelstudio/ai plan.ts, docs/plan.md): the plan:* IPC channels.
// A change is a held edit (jobs.hold), so nothing else writes the project meanwhile; the AI's proposal is a
// job like a note. The AI and the job manager come in from index.ts, so this file is tested without Electron
// (test/plan-ipc.test.ts).
import type { IpcMainInvokeEvent } from 'electron'
import type { AI } from './ai-types'
import type { JobFn } from './jobs'
import type { ProjectJson } from '../shared/api'
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
}

const NOT_AVAILABLE = { code: 'PLAN_UNAVAILABLE', userMessage: 'This version of Reel Studio cannot plan videos yet.' }

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
}
