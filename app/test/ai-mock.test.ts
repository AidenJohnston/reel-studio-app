// The app with no AI package (ai-mock.ts) still saves a note the way the app recovers it.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMockAI } from '../src/main/ai-mock'
import type { EngineHost } from '../src/main/ai-types'
import { reelStudioRoot } from '../src/main/paths'
import { ensureRoot, projectDir, readAppState, recoverInterrupted, updateAppState } from '../src/main/store'
import { setupPaths } from './helpers'

const host: EngineHost = {
  reelStudioRoot,
  runEngine: async (command) => { throw new Error(`a note without an AI runs no engine command (${command})`) },
  renderAnimation: async () => { throw new Error('no animations') }
}

describe('a note without an AI', () => {
  it('saved just before a crash, it gets its reply and question at the next start, and My style waits for a yes', async () => {
    setupPaths()
    await ensureRoot()
    const dir = projectDir('bread')
    mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
    writeFileSync(join(dir, 'versions', 'v1', 'export.mp4'), 'x')
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ title: 'Bread', slug: 'bread', version: 1, notes: [] }))
    await updateAppState('bread', (s) => {
      s.job = { id: 'job-7', kind: 'note', startedAt: new Date().toISOString() }
    })

    const ai = createMockAI({ host, settingsDir: join(reelStudioRoot(), '..', 'settings') })
    const r = await ai.applyNote(dir, 'from now on use warmer music', () => undefined, undefined, { id: 'job-7', saveStyleRules: false })
    expect(r.styleSuggestions).toEqual(['from now on use warmer music'])
    // the app quits before it posts the reply
    await recoverInterrupted()

    expect((await readAppState('bread')).chat.map((m) => m.text)).toEqual([
      r.summary,
      'Remember this for next time? "from now on use warmer music"'
    ])
    expect(await ai.styleRules()).toEqual([])
    expect(existsSync(join(reelStudioRoot(), 'My style.json'))).toBe(false)
  })
})
