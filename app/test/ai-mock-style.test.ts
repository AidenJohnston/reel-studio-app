import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockAI } from '../src/main/ai-mock'
import type { EngineHost } from '../src/main/ai-types'

// The stand-in AI is what the app runs when @reelstudio/ai fails to load, so it writes the real My style.json.
function standIn(): { ai: ReturnType<typeof createMockAI>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'rs-mock-style '))
  const unused = (): never => {
    throw new Error('not used by My style')
  }
  const host: EngineHost = { reelStudioRoot: () => root, runEngine: unused, renderAnimation: unused }
  return { ai: createMockAI({ host, settingsDir: root }), root }
}

describe('My style in the stand-in AI', () => {
  it('two rules saved at once keep both', async () => {
    const { ai } = standIn()
    await Promise.all([ai.addStyleRule!('Keep music quieter under talking.'), ai.addStyleRule!('Use big captions.')])
    expect((await ai.styleRules()).map((r) => r.text).sort()).toEqual(['Keep music quieter under talking.', 'Use big captions.'])
  })
})
