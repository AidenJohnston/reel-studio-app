// The plan:* channels (main/plan-ipc.ts): a change is a held edit of that project, a proposal is a 'plan' job that
// joins the job's ownership, a change the page should never send is refused, and an AI package without the
// Plan document says so plainly.
import { describe, expect, it } from 'vitest'
import { registerPlanIpc, type PlanIpcDeps } from '../src/main/plan-ipc'
import type { AI } from '../src/main/ai-types'
import type { JobFn } from '../src/main/jobs'
import type { PlanChange, PlanView } from '../src/shared/plan'

const VIEW: PlanView = { plan: { script: { draft: null, rewrite: null, locked: false }, beats: [], broll: [] }, unbuilt: [] }

function setup(ai: Partial<AI>) {
  const channels = new Map<string, (...args: any[]) => unknown>()
  const log: string[] = []
  const jobs: { slug: string; kind: string; fn: JobFn }[] = []
  const deps: PlanIpcDeps = {
    handle: (channel, fn) => channels.set(channel, (...args) => fn({} as never, ...args)),
    ai: () => ai as AI,
    projectDir: (slug) => `/projects/${slug}`,
    hold: async (slug, fn) => {
      log.push(`hold ${slug}`)
      try {
        return await fn('owner-token')
      } finally {
        log.push(`release ${slug}`)
      }
    },
    start: (slug, kind, fn) => {
      jobs.push({ slug, kind, fn })
      return 'job-1'
    }
  }
  registerPlanIpc(deps)
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => channels.get(channel)!(...args))
  return { channels, invoke, log, jobs }
}

describe('plan IPC', () => {
  it('registers the channels the page calls', () => {
    expect([...setup({}).channels.keys()].sort()).toEqual(['plan:change', 'plan:get', 'plan:markdown', 'plan:propose'])
  })

  it('a change runs while the project is held, on that project', async () => {
    const changes: [string, PlanChange][] = []
    const { invoke, log } = setup({
      plan: {
        get: async () => VIEW,
        markdown: async () => '# Plan',
        change: async (dir, c) => {
          log.push('change')
          changes.push([dir, c])
          return VIEW
        }
      }
    })
    expect(await invoke('plan:change', 'bread', { kind: 'rowStatus', id: 'p1', status: 'approved' })).toEqual(VIEW)
    expect(changes).toEqual([['/projects/bread', { kind: 'rowStatus', id: 'p1', status: 'approved' }]])
    expect(log).toEqual(['hold bread', 'change', 'release bread'])
    expect(await invoke('plan:markdown', 'bread')).toBe('# Plan')
  })

  it('refuses a change of a kind it does not know, without holding the project', async () => {
    const { invoke, log } = setup({ plan: { get: async () => VIEW, markdown: async () => '', change: async () => VIEW } })
    await expect(invoke('plan:change', 'bread', { kind: 'delete-everything' })).rejects.toMatchObject({ code: 'BAD_PLAN_CHANGE' })
    await expect(invoke('plan:change', 'bread', null)).rejects.toMatchObject({ code: 'BAD_PLAN_CHANGE' })
    expect(log).toEqual([])
  })

  it('a proposal is a plan job that passes on its owner token, and its summary is the reply', async () => {
    const calls: unknown[] = []
    const { invoke, jobs } = setup({
      proposePlan: async (dir, _onEvent, _signal, opts) => {
        calls.push([dir, opts])
        return { summary: 'Here is a plan.', plan: VIEW.plan! }
      }
    })
    expect(await invoke('plan:propose', 'bread')).toEqual({ jobId: 'job-1' })
    expect(jobs.map((j) => [j.slug, j.kind])).toEqual([['bread', 'plan']])
    const r = await jobs[0].fn(() => undefined, new AbortController().signal, { id: 'job-1', owner: 'tok' })
    expect(r).toEqual({ summary: 'Here is a plan.' })
    expect(calls).toEqual([['/projects/bread', { owner: 'tok' }]])
  })

  it('an AI package without the Plan document says so', async () => {
    const { invoke, jobs } = setup({})
    await expect(invoke('plan:get', 'bread')).rejects.toMatchObject({ code: 'PLAN_UNAVAILABLE' })
    await expect(invoke('plan:propose', 'bread')).rejects.toMatchObject({ code: 'PLAN_UNAVAILABLE' })
    expect(jobs).toEqual([])
  })
})
