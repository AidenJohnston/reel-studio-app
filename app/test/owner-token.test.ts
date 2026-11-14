// The cover picker's scan runs beside a job on the same project and joins it with the job's owner token
// (index.ts projects:coverCandidates): the token must be the one in the project's lock while it is held.
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coverScanOwner } from '../src/main/cover-scan'
import { createJobManager } from '../src/main/jobs'
import { clearStaleLocks, OWNER_LOCK } from '../src/main/owner'
import { projectDir } from '../src/main/store'
import { setupPaths } from './helpers'

it('fails if ownerToken is not the token in the lock while a project is held, or outlives it', async () => {
  setupPaths()
  const slug = 'scan-joins'
  mkdirSync(projectDir(slug), { recursive: true })
  const jobs = createJobManager(() => undefined, () => undefined)
  expect(jobs.ownerToken(slug)).toBeNull()
  let during: string | null = null
  let lock: { token?: string } = {}
  await jobs.hold(slug, async () => {
    during = jobs.ownerToken(slug)
    lock = JSON.parse(readFileSync(join(projectDir(slug), 'work', '.owner.lock'), 'utf8'))
  })
  expect(during).toBe(lock.token)
  expect(during).toBeTruthy()
  expect(jobs.ownerToken(slug)).toBeNull()
})

it('fails if the cover scan runs on a reel kept closed, which an engine may still be writing to', async () => {
  setupPaths()
  const slug = 'kept-closed'
  mkdirSync(projectDir(slug), { recursive: true })
  const jobs = createJobManager(() => undefined, () => undefined)
  expect(coverScanOwner(jobs, slug)).toBeNull()
  jobs.keepClosed(slug)
  expect(() => coverScanOwner(jobs, slug)).toThrow(expect.objectContaining({ code: 'ENGINE_STILL_RUNNING' }))
})


it('fails if a job claims a video a tool run by hand is working on, or stays out once that tool has exited', async () => {
  setupPaths()
  const slug = 'by-hand'
  mkdirSync(join(projectDir(slug), 'work'), { recursive: true })
  const lock = join(projectDir(slug), OWNER_LOCK)
  // what engine/reelengine/owner.py claim (and ai/src/owner.ts claimProject) writes, from a process still running
  const byHand = JSON.stringify({ app: 'reelengine', pid: process.pid, token: 'by-hand' })
  writeFileSync(lock, byHand)
  const jobs = createJobManager(() => undefined, () => undefined)
  let ran = false
  await expect(jobs.hold(slug, async () => void (ran = true))).rejects.toMatchObject({ code: 'PROJECT_IN_USE' })
  expect(ran).toBe(false)
  expect(readFileSync(lock, 'utf8')).toBe(byHand)
  // the start after a crash leaves it too
  await clearStaleLocks([])
  expect(readFileSync(lock, 'utf8')).toBe(byHand)

  // that tool has exited: a pid no process has any more
  const gone = spawnSync(process.execPath, ['-e', '']).pid
  writeFileSync(lock, JSON.stringify({ app: 'reelengine', pid: gone, token: 'by-hand' }))
  let token: string | null = null
  await jobs.hold(slug, async (owner) => {
    token = JSON.parse(readFileSync(lock, 'utf8')).token
    expect(token).toBe(owner)
  })
  expect(token).toBeTruthy()
  expect(existsSync(lock)).toBe(false)
})
