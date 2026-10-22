import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settleLastRun } from '../src/main/last-run'
import { createPidRegistry } from '../src/main/orphans'
import { OWNER_LOCK } from '../src/main/owner'
import { settingsDir } from '../src/main/paths'
import { saveSettings } from '../src/main/settings'
import { setupPaths } from './helpers'

describe('the start after a crash', () => {
  it('with a storage folder chosen in Settings and an engine list it cannot read, keeps that folder\'s open videos closed', async () => {
    const { home } = setupPaths()
    const chosen = join(home, '..', 'Elsewhere', 'Reel Studio')
    await saveSettings({ root: chosen })
    const lock = join(chosen, 'Projects', 'bread', OWNER_LOCK)
    mkdirSync(join(lock, '..'), { recursive: true })
    writeFileSync(lock, '{"app":"Reel Studio"}')
    // what an older version's crash in the middle of rewriting it left
    writeFileSync(join(settingsDir(), 'engines.json'), '[{"pid":4242,"proj')

    const closed: string[] = []
    await settleLastRun(createPidRegistry(settingsDir()), (slug) => closed.push(slug), () => undefined)
    expect(closed).toEqual(['bread'])
    expect(existsSync(lock)).toBe(true)
  })
})
