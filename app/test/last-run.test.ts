import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settleLastRun } from '../src/main/last-run'
import { createPidRegistry } from '../src/main/orphans'
import { OWNER_LOCK } from '../src/main/owner'
import { settingsDir } from '../src/main/paths'
import { killTree } from '../src/main/proctree'
import { saveSettings } from '../src/main/settings'
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
})
