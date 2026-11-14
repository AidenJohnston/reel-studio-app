// The plan:* channels (main/plan-ipc.ts): a change is a held edit of that project, a proposal is a 'plan' job that
// joins the job's ownership, a change the page should never send is refused, an AI package without the Plan
// document says so plainly, and a hand edit of a planned project's pictures or cut goes through the plan. A planned
// reel's first edit proposes the plan and holds Version 1 until Make Version 1.
import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { proposeFirstEdit, registerPlanIpc, withPlanFollowing, type PlanIpcDeps } from '../src/main/plan-ipc'
import type { AI } from '../src/main/ai-types'
import { createJobManager, type JobFn } from '../src/main/jobs'
import { projectDir, readAppState, updateAppState } from '../src/main/store'
import type { ProjectJson, ReelPlan } from '../src/shared/api'
import type { PlanChange, PlanView } from '../src/shared/plan-doc'
import { setupPaths } from './helpers'

const VIEW: PlanView = { plan: { script: { draft: null, rewrite: null, locked: false }, beats: [], broll: [] }, unbuilt: [] }

function setup(ai: Partial<AI>, more: Partial<PlanIpcDeps> = {}) {
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
    },
    firstEdit: async () => 'none',
    appState: async () => ({}),
    startFirstEdit: () => {
      throw new Error('no first edit in this test')
    },
    ...more
  }
  registerPlanIpc(deps)
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => channels.get(channel)!(...args))
  return { channels, invoke, log, jobs }
}

describe('plan IPC', () => {
  it('registers the channels the page calls', () => {
    expect([...setup({}).channels.keys()].sort()).toEqual(['plan:change', 'plan:get', 'plan:makeVersion1', 'plan:markdown', 'plan:propose'])
  })

  it('a change runs while the project is held, on that project', async () => {
    const changes: [string, PlanChange][] = []
    const { invoke, log } = setup({
      plan: {
        get: async () => VIEW,
        markdown: async () => '# Plan',
        followHandEdit: async (_dir, p) => p,
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
    const { invoke, log } = setup({ plan: { get: async () => VIEW, markdown: async () => '', change: async () => VIEW, followHandEdit: async (_dir, p) => p } })
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

describe('a hand edit of a planned project (projects:update)', () => {
  const project = (rows: number): ProjectJson => ({
    schemaVersion: 1, id: 'x', title: 'Bread', slug: 'bread', createdAt: '', updatedAt: '', version: 1, broll: [],
    plan: { ...VIEW.plan!, broll: Array.from({ length: rows }, (_, i) => ({ id: `p${i + 1}`, visual: 'v', source: 'card' as const, status: 'approved' as const })) }
  })
  const followed: [string, ProjectJson][] = []
  const ai = { plan: { get: async () => VIEW, markdown: async () => '', change: async () => VIEW,
    followHandEdit: async (dir: string, p: ProjectJson) => { followed.push([dir, p]); return { ...p, title: 'followed' } } } } as unknown as AI

  it('lets the plan follow an edit of the pictures or the cut, before it is saved', async () => {
    followed.length = 0
    expect((await withPlanFollowing(ai, '/projects/bread', project(1), ['broll'])).title).toBe('followed')
    expect((await withPlanFollowing(ai, '/projects/bread', project(1), ['cut'])).title).toBe('followed')
    expect(followed.map(([d]) => d)).toEqual(['/projects/bread', '/projects/bread'])
  })

  it('leaves other edits, and projects without b-roll rows, as they are', async () => {
    followed.length = 0
    expect((await withPlanFollowing(ai, '/p', project(1), ['title', 'music'])).title).toBe('Bread')
    expect((await withPlanFollowing(ai, '/p', project(0), ['broll'])).title).toBe('Bread')
    expect(followed).toEqual([])
  })

  it('refuses rather than let the rows and the pictures drift apart when the AI package cannot follow the plan', async () => {
    await expect(withPlanFollowing({} as AI, '/p', project(1), ['broll'])).rejects.toMatchObject({ code: 'PLAN_UNAVAILABLE' })
  })
})

describe('a planned reel whose Version 1 waits for its plan', () => {
  const FILMING: ReelPlan = { topic: 'bread', hooks: ['Nobody tells you this.', 'Bread is easy.'], hook: 1, beats: [{ text: 'Flour, water, salt.' }, { text: 'Wait a day.', done: true }], shots: [{ text: 'the loaf' }] }
  const withScript = (script: Partial<NonNullable<PlanView['plan']>['script']>): PlanView => ({ ...VIEW, plan: { ...VIEW.plan!, script: { ...VIEW.plan!.script, ...script } } })

  function planningAI(view: PlanView, log: unknown[]): Partial<AI> {
    return {
      plan: {
        get: async () => view,
        markdown: async () => '',
        followHandEdit: async (_dir, p) => p,
        change: async (dir, c) => {
          log.push(['change', dir, c])
          return view
        }
      },
      proposePlan: async (dir, _onEvent, _signal, opts) => {
        log.push(['propose', dir, opts])
        return { summary: 'Here is a plan. Tick the pictures you want.', plan: view.plan! }
      }
    }
  }

  // fails if the filming plan's picked hook and beats never reach the Plan document's script (the subtitles and the
  // proposal read it there), if they land after the proposal, or if the proposal loses the job's owner token
  it('seeds the script draft from the filming plan, then proposes, and replies with the proposal', async () => {
    const log: unknown[] = []
    const r = await proposeFirstEdit(planningAI({ plan: null, unbuilt: [] }, log) as AI, '/projects/bread', FILMING, () => undefined, new AbortController().signal, 'tok')
    expect(log).toEqual([
      ['change', '/projects/bread', { kind: 'script', draft: { hook: 'Bread is easy.', script: 'Flour, water, salt.\nWait a day.', onScreenText: [] } }],
      ['propose', '/projects/bread', { owner: 'tok' }]
    ])
    expect(r).toEqual({ summary: 'Here is a plan. Tick the pictures you want.' })
  })

  // fails if a proposal tried again (Try again, or a quit's continuation) overwrites the draft, or the creator's rewrite
  it('leaves a script the Plan document already has', async () => {
    for (const script of [{ draft: 'the draft' }, { rewrite: 'my words' }]) {
      const log: unknown[] = []
      await proposeFirstEdit(planningAI(withScript(script), log) as AI, '/projects/bread', FILMING, () => undefined, new AbortController().signal, null)
      expect(log).toEqual([['propose', '/projects/bread', undefined]])
    }
  })

  // fails if Make Version 1 leaves the reel held (so its notes never run and the card keeps waiting), starts two
  // Version 1s on a double press, or drops the hold when the start is refused
  it('Make Version 1 clears the hold in the write that starts Version 1, and starts it once', async () => {
    setupPaths()
    const slug = 'held-reel'
    mkdirSync(projectDir(slug), { recursive: true })
    await updateAppState(slug, (s) => {
      s.status = 'ready'
      s.planHeld = true
    })
    const jobs = createJobManager(() => undefined, () => undefined)
    let finish!: () => void
    const finished = new Promise<void>((go) => (finish = go))
    const ran: (boolean | undefined)[] = []
    const { invoke } = setup({}, {
      appState: readAppState,
      startFirstEdit: (s, record) =>
        jobs.start(s, 'first-edit', async () => {
          ran.push((await readAppState(s)).planHeld)
          await finished
          return { summary: 'Version 1 is ready.', version: 1 }
        }, { record })
    })
    // pressed while the proposal still runs: refused, and the reel still waits
    let proposed!: () => void
    const proposalDone = new Promise<{ summary: string }>((go) => (proposed = () => go({ summary: 'Here is a plan.' })))
    const proposal = jobs.start(slug, 'first-edit', () => proposalDone)
    await expect(invoke('plan:makeVersion1', slug)).rejects.toMatchObject({ code: 'BUSY' })
    proposed()
    await jobs.get(proposal)?.done
    expect((await readAppState(slug)).planHeld).toBe(true)

    const presses = await Promise.allSettled([invoke('plan:makeVersion1', slug), invoke('plan:makeVersion1', slug)])
    const started = presses.flatMap((p) => (p.status === 'fulfilled' ? [p.value as { jobId: string }] : []))
    expect(started).toHaveLength(1)
    expect(presses.find((p) => p.status === 'rejected')).toMatchObject({ reason: { code: 'BUSY' } })
    for (let i = 0; i < 2000 && !ran.length; i++) await new Promise((r) => setTimeout(r, 1))
    // the job's own start wrote it: Version 1 runs with nothing held
    expect(ran).toEqual([undefined])
    finish()
    await jobs.get(started[0].jobId)?.done
    expect(ran).toHaveLength(1)
  })

  // fails if Make Version 1 can start a first edit on a reel that is not waiting for its plan (one already made, or
  // never planned), where it would make a version nobody asked for
  it('Make Version 1 refuses a reel whose Version 1 is not waiting', async () => {
    let starts = 0
    const { invoke } = setup({}, {
      appState: async () => ({}),
      startFirstEdit: () => String(++starts)
    })
    await expect(invoke('plan:makeVersion1', 'bread')).rejects.toMatchObject({ code: 'NOT_HELD' })
    expect(starts).toBe(0)
  })
})
