// The transitions of a project's one-writer lock (docs/ownership.md), from the app's side: what a job's claim, the
// start after a crash and the app's own commands outside a job do with a lock another writer left or still holds.
import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { settleLastRun } from '../src/main/last-run'
import { createPidRegistry } from '../src/main/orphans'
import { claimProject, clearStaleLocks, OWNER_LOCK } from '../src/main/owner'
import { settingsDir } from '../src/main/paths'
import { killTree } from '../src/main/proctree'
import { saveSettings } from '../src/main/settings'
import { projectDir, readAppState, updateAppState } from '../src/main/store'
import { APP_DIR, PYTHON, setupPaths } from './helpers'

const note = async (): Promise<{ summary: string }> => ({ summary: 'ok' })
/** A pid no process has any more. */
const exited = (): number => spawnSync(process.execPath, ['-e', '']).pid!
/** When this process started, as a claim records it. */
const startedNow = (): number => Math.round(Date.now() - process.uptime() * 1000)

function project(slug: string): { dir: string; lock: string } {
  const dir = projectDir(slug)
  mkdirSync(join(dir, 'work'), { recursive: true })
  return { dir, lock: join(dir, OWNER_LOCK) }
}

/** The start after a crash, as index.ts runs it. */
async function restart(): Promise<void> {
  mkdirSync(settingsDir(), { recursive: true })
  await settleLastRun(createPidRegistry(settingsDir()), () => undefined, () => undefined)
}

describe('a lock another writer left', () => {
  it('fails if a lock that cannot be read yet, as one being created on a disk without hard links, is removed or taken', async () => {
    setupPaths()
    await saveSettings({ firstRunDone: true })
    const { lock } = project('bread')
    writeFileSync(lock, '')
    await clearStaleLocks([])
    expect(existsSync(lock)).toBe(true)
    await expect(createJobManager(() => undefined, () => undefined).hold('bread', note)).rejects.toMatchObject({ code: 'PROJECT_IN_USE' })
    expect(readFileSync(lock, 'utf8')).toBe('')
  })

  it("fails if a dead tool's claim is taken over while an engine it started, or one naming the video, still runs", async () => {
    setupPaths()
    await saveSettings({ firstRunDone: true })
    const { dir, lock } = project('bread')
    const jobs = createJobManager(() => undefined, () => undefined)
    // a dev CLI killed during a render: its engine, which here names no folder, is known only from the claim
    const engine = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    await once(engine, 'spawn')
    const claim = JSON.stringify({ app: 'reelstudio-ai', pid: exited(), started: Date.now() - 5000, token: 'by-hand', engines: [{ pid: engine.pid, started: Date.now() }] })
    writeFileSync(lock, claim)
    try {
      await expect(jobs.hold('bread', note)).rejects.toMatchObject({ code: 'PROJECT_IN_USE' })
      await clearStaleLocks([])
      expect(readFileSync(lock, 'utf8')).toBe(claim)
    } finally {
      engine.kill()
    }
    await once(engine, 'exit')
    // an engine run by hand was killed, and what it started still works in the video: found by its command line
    const left = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep', '--project', dir], { cwd: join(APP_DIR, 'test', 'fixtures', 'sleeper'), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    try {
      await once(left, 'spawn')
      await expect(jobs.hold('bread', note)).rejects.toMatchObject({ code: 'PROJECT_IN_USE' })
    } finally {
      await killTree(left.pid!)
    }
    // all of it has exited: the next job takes the project, and lets go of it after
    let held = ''
    await jobs.hold('bread', async (token) => {
      held = JSON.parse(readFileSync(lock, 'utf8')).token
      expect(held).toBe(token)
    })
    expect(held).toBeTruthy()
    expect(existsSync(lock)).toBe(false)
  }, 60000)

  it('fails if a claim whose pid another process now has keeps the video closed', async () => {
    setupPaths()
    await saveSettings({ firstRunDone: true })
    const { lock } = project('bread')
    // this test's own pid, with the start time of a process an hour older: the engine that claimed it has exited
    writeFileSync(lock, JSON.stringify({ app: 'reelengine', pid: process.pid, started: Date.now() - 3_600_000, token: 'by-hand' }))
    await clearStaleLocks([])
    expect(existsSync(lock)).toBe(false)
    writeFileSync(lock, JSON.stringify({ app: 'reelengine', pid: process.pid, started: Date.now() - 3_600_000, token: 'by-hand' }))
    await createJobManager(() => undefined, () => undefined).hold('bread', async (token) => {
      expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(token)
    })
  })

  it('fails if the start after a crash cleans a video that a live tool run by hand holds', async () => {
    setupPaths()
    await saveSettings({ firstRunDone: true })
    const { dir, lock } = project('bread')
    // an earlier job could not finish cleaning up; then a dev CLI note took the video and waits on its model
    await updateAppState('bread', (s) => void (s.cleanupOwed = true))
    const scratch = join(dir, 'work', 'notes', 'cli-note', 'edit.json')
    mkdirSync(join(scratch, '..'), { recursive: true })
    writeFileSync(scratch, '{}')
    const claim = JSON.stringify({ app: 'reelstudio-ai', pid: process.pid, started: startedNow(), token: 'cli', engines: [] })
    writeFileSync(lock, claim)
    await restart()
    expect(existsSync(scratch)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe(claim)
    expect((await readAppState('bread')).cleanupOwed).toBe(true)
    // once it has let go, the next start cleans up
    writeFileSync(lock, JSON.stringify({ app: 'reelstudio-ai', pid: exited(), started: startedNow(), token: 'cli', engines: [] }))
    await restart()
    expect(existsSync(scratch)).toBe(false)
    expect((await readAppState('bread')).cleanupOwed).toBeUndefined()
    expect(existsSync(lock)).toBe(false)
  }, 60000)

  it('fails if a claim that has been taken over is removed by the writer that lost it', async () => {
    setupPaths()
    const { dir, lock } = project('bread')
    const first = await claimProject(dir)
    const next = JSON.stringify({ app: 'Reel Studio', pid: process.pid, started: startedNow(), token: 'the next claim' })
    writeFileSync(lock, next)
    await first.release()
    expect(readFileSync(lock, 'utf8')).toBe(next)
  })
})
