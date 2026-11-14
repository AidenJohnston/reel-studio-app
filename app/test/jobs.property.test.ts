// One writer per project, as the job lane (main/jobs.ts) keeps it: random starts of jobs and manual edits on two
// reels, each ending done, failed or with an engine that would not stop, checked against a model after every step.
// Fails if the lane lets two writers into one project, admits work on a project it keeps closed, or lets the
// owner lock (work/.owner.lock, which tools run by hand obey) go while a writer or a stuck engine may still write.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { OWNER_LOCK } from '../src/main/owner'
import { projectDir } from '../src/main/store'
import { setupPaths } from './helpers'

const STUCK = { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop." }
type End = 'done' | 'failed' | 'stuck'
/** What the lane should say about a reel: free, written by one job or manual edit, or kept closed. */
type State = { kind: 'free' } | { kind: 'job' | 'hold'; end: (how: End) => Promise<void> } | { kind: 'stuck' | 'left-running' }

/** Deterministic pseudo-random numbers (mulberry32), so a failing seed replays exactly. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function run(seed: number, steps: number): Promise<void> {
  setupPaths()
  const slugs = ['bread', 'cake']
  for (const slug of slugs) {
    mkdirSync(join(projectDir(slug), 'work'), { recursive: true })
    writeFileSync(join(projectDir(slug), 'project.json'), JSON.stringify({ broll: [] }))
  }
  const jobs = createJobManager(() => undefined, () => undefined)
  const state = new Map<string, State>(slugs.map((s) => [s, { kind: 'free' }]))
  // writers whose work is running right now, per reel, counted by the work itself
  const inside = new Map<string, number>(slugs.map((s) => [s, 0]))
  // what the work saw go wrong: kept here, since a job turns anything its work throws into a failed job
  const violations: string[] = []
  const lockOf = (slug: string): { token?: string } | null => {
    const f = join(projectDir(slug), OWNER_LOCK)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
  }

  /** The work a writer does: it records that it runs, checks the lock is its own, and ends when told. */
  function work(slug: string, owner: string | null): { body: Promise<void>; entered: Promise<void>; end: (how: End) => void } {
    let enter!: () => void
    let finish!: (how: End) => void
    const entered = new Promise<void>((r) => (enter = r))
    const ended = new Promise<End>((r) => (finish = r))
    const body = (async () => {
      inside.set(slug, inside.get(slug)! + 1)
      if (inside.get(slug) !== 1) violations.push(`two writers in ${slug}`)
      if (lockOf(slug)?.token !== owner) violations.push(`${slug}'s lock is not its writer's`)
      enter()
      const how = await ended
      inside.set(slug, inside.get(slug)! - 1)
      if (how === 'failed') throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' }
      if (how === 'stuck') throw STUCK
    })()
    return { body, entered, end: finish }
  }

  const pick = rng(seed)
  for (let step = 0; step < steps; step++) {
    const slug = slugs[Math.floor(pick() * slugs.length)]
    const s = state.get(slug)!
    const op = pick()
    const where = `seed ${seed}, step ${step}, ${slug} (${s.kind})`
    if (op < 0.3) {
      // a job: admitted only on a free reel, refused at once otherwise
      const at: { w?: ReturnType<typeof work> } = {}
      let started!: () => void
      const inWork = new Promise<void>((r) => (started = r))
      let id: string | null = null
      let refused: { code?: string } | null = null
      try {
        id = jobs.start(slug, 'rerender', async (_emit, _signal, { owner }) => {
          at.w = work(slug, owner)
          started()
          await at.w.body
          return { summary: 'ok' }
        })
      } catch (e) {
        refused = e as { code?: string }
      }
      if (id) {
        expect(s.kind, `${where}: a job was admitted`).toBe('free')
        const job = jobs.get(id)!
        // a job that ended before its work began (it could not take the project) would leave nothing to end
        await Promise.race([inWork, job.done])
        expect(at.w, `${where}: an admitted job never reached its work`).toBeDefined()
        await at.w!.entered
        state.set(slug, { kind: 'job', end: async (how) => { at.w!.end(how); await job.done } })
      } else {
        expect(s.kind, `${where}: a job was refused`).not.toBe('free')
        expect(refused?.code, where).toBe(s.kind === 'stuck' ? 'ENGINE_STUCK' : s.kind === 'left-running' ? 'ENGINE_STILL_RUNNING' : 'BUSY')
      }
    } else if (op < 0.55) {
      // a manual edit: the same rule
      const at: { w?: ReturnType<typeof work> } = {}
      let entered!: () => void
      const ready = new Promise<void>((r) => (entered = r))
      const held = jobs.hold(slug, async (owner) => {
        at.w = work(slug, owner)
        entered()
        await at.w.body
      })
      const refused = await Promise.race([ready.then(() => null), held.then(() => null, (e) => e)])
      if (refused) {
        expect(s.kind, `${where}: an edit was refused`).not.toBe('free')
        expect(refused.code, where).toBe(s.kind === 'stuck' ? 'ENGINE_STUCK' : s.kind === 'left-running' ? 'ENGINE_STILL_RUNNING' : 'BUSY')
      } else {
        expect(s.kind, `${where}: an edit was admitted`).toBe('free')
        await at.w!.entered
        state.set(slug, { kind: 'hold', end: async (how) => { at.w!.end(how); await held.catch(() => undefined) } })
      }
    } else if (op < 0.9) {
      // the running writer ends
      if (s.kind !== 'job' && s.kind !== 'hold') continue
      const how: End = pick() < 0.2 ? 'stuck' : pick() < 0.5 ? 'failed' : 'done'
      await s.end(how)
      state.set(slug, { kind: how === 'stuck' ? 'stuck' : 'free' })
    } else if (s.kind === 'free') {
      // at startup: an engine of the last run still works in this reel
      jobs.keepClosed(slug)
      state.set(slug, { kind: 'left-running' })
    } else if (s.kind === 'left-running') {
      jobs.reopen(slug)
      state.set(slug, { kind: 'free' })
    }

    expect(violations, `seed ${seed}, step ${step}`).toEqual([])
    for (const r of slugs) {
      const k = state.get(r)!.kind
      const at = `seed ${seed}, after step ${step}, ${r} (${k})`
      expect(inside.get(r), at).toBe(k === 'job' || k === 'hold' ? 1 : 0)
      // a stuck engine may still be writing: its lock stays so tools run by hand keep out too
      expect(!!lockOf(r), `${at}: owner lock`).toBe(k === 'job' || k === 'hold' || k === 'stuck')
      expect(jobs.isClosed(r), `${at}: closed`).toBe(k === 'job' || k === 'stuck' || k === 'left-running')
      if (k === 'free') expect(() => jobs.refuseIfBusy(r), at).not.toThrow()
      else expect(() => jobs.refuseIfBusy(r), at).toThrow()
    }
  }
  // let every writer still running finish, so no work outlives the test
  for (const s of state.values()) if (s.kind === 'job' || s.kind === 'hold') await s.end('done')
  expect(violations).toEqual([])
}

describe('one writer per project', () => {
  it.each([1, 2, 3, 4])('holds over random jobs, manual edits, failures and stuck engines on two reels (seed %i)', async (seed) => {
    await run(seed, 60)
  }, 60_000)
})
