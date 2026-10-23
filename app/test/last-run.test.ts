import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { settleLastRun } from '../src/main/last-run'
import { createPidRegistry } from '../src/main/orphans'
import { OWNER_LOCK } from '../src/main/owner'
import { settingsDir } from '../src/main/paths'
import { killTree } from '../src/main/proctree'
import { saveSettings } from '../src/main/settings'
import { projectDir } from '../src/main/store'
import { APP_DIR, PYTHON, setupPaths } from './helpers'

describe('the start after a crash', () => {
  it('with a storage folder chosen in Settings and an engine list it cannot read, keeps that folder\'s video closed while an engine still works in it', async () => {
    const { home } = setupPaths()
    const chosen = join(home, '..', 'Elsewhere', 'Reel Studio')
    await saveSettings({ root: chosen })
    const bread = join(chosen, 'Projects', 'bread')
    mkdirSync(join(bread, 'work'), { recursive: true })
    const lock = join(bread, OWNER_LOCK)
    writeFileSync(lock, '{"app":"Reel Studio"}')
    // what an older version's crash in the middle of rewriting it left
    writeFileSync(join(settingsDir(), 'engines.json'), '[{"pid":4242,"proj')
    const engine = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep', '--project', bread], { cwd: join(APP_DIR, 'test', 'fixtures', 'sleeper'), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    try {
      await once(engine, 'spawn')
      const closed: string[] = []
      await settleLastRun(createPidRegistry(settingsDir()), (slug) => closed.push(slug), () => undefined)
      expect(closed).toEqual(['bread'])
      expect(existsSync(lock)).toBe(true)
    } finally {
      await killTree(engine.pid!)
    }
  }, 60000)

  it('an engine the last run left that would not stop keeps only its own video closed, and only until it exits', async () => {
    setupPaths()
    const [bread, cake] = ['bread', 'cake'].map((slug) => projectDir(slug))
    for (const p of [bread, cake]) mkdirSync(join(p, 'work'), { recursive: true })
    writeFileSync(join(bread, OWNER_LOCK), '{"app":"Reel Studio"}')
    const left = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep', '--project', bread], { cwd: join(APP_DIR, 'test', 'fixtures', 'sleeper'), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    try {
      await once(left, 'spawn')
      mkdirSync(settingsDir(), { recursive: true })
      createPidRegistry(settingsDir()).add(left.pid!, bread) // the crashed run's list
      const jobs = createJobManager(() => undefined, () => undefined)
      const note = async (): Promise<{ summary: string }> => ({ summary: 'ok' })
      await settleLastRun(createPidRegistry(settingsDir(), async () => false), (slug) => jobs.keepClosed(slug), () => undefined, (slug) => jobs.reopen(slug))
      expect(() => jobs.start('bread', 'note', note)).toThrow(expect.objectContaining({ code: 'ENGINE_STILL_RUNNING' }))
      jobs.start('cake', 'note', note)
      await jobs.forSlug('cake')?.done

      await killTree(left.pid!)
      for (let i = 0; i < 100 && existsSync(join(bread, OWNER_LOCK)); i++) await new Promise((r) => setTimeout(r, 100))
      expect(existsSync(join(bread, OWNER_LOCK))).toBe(false)
      jobs.start('bread', 'note', note)
      await jobs.forSlug('bread')?.done
    } finally {
      if (left.exitCode === null) await killTree(left.pid!)
    }
  }, 60000)

  it('a video kept closed because a running engine names it, while the engine list could not be read, opens once nothing does', async () => {
    setupPaths()
    const bread = projectDir('bread')
    mkdirSync(join(bread, 'work'), { recursive: true })
    mkdirSync(settingsDir(), { recursive: true })
    writeFileSync(join(settingsDir(), 'engines.json'), '[{"pid":4242,"proj') // what an older version's crash mid-write left
    const left = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep', '--project', bread], { cwd: join(APP_DIR, 'test', 'fixtures', 'sleeper'), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    try {
      await once(left, 'spawn')
      const jobs = createJobManager(() => undefined, () => undefined)
      let reopened = false
      await settleLastRun(createPidRegistry(settingsDir()), (slug) => jobs.keepClosed(slug), () => undefined, (slug) => {
        reopened = true
        jobs.reopen(slug)
      })
      expect(() => jobs.start('bread', 'note', async () => ({ summary: 'ok' }))).toThrow(expect.objectContaining({ code: 'ENGINE_STILL_RUNNING' }))

      await killTree(left.pid!)
      for (let i = 0; i < 100 && !reopened; i++) await new Promise((r) => setTimeout(r, 100))
      jobs.start('bread', 'note', async () => ({ summary: 'ok' }))
      await jobs.forSlug('bread')?.done
    } finally {
      if (left.exitCode === null) await killTree(left.pid!)
    }
  }, 60000)
})
