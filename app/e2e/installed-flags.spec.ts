// Checks on an INSTALLED (packaged) app: REELSTUDIO_E2E_EXE=<the app binary>, REELSTUDIO_E2E_EXPECT=local|public.
// Proves the build flag that was baked in: the local-Claude-Code build offers (and auto-picks) Claude Code on this
// computer; the public build offers only ChatGPT and a Claude key, and no environment variable can change that.
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SHOTS, launch, passFirstRun, shot } from './helpers'

const EXPECT = process.env.REELSTUDIO_E2E_EXPECT
test.skip(!process.env.REELSTUDIO_E2E_EXE || !EXPECT, 'set REELSTUDIO_E2E_EXE and REELSTUDIO_E2E_EXPECT=local|public')

test(`installed ${EXPECT} build: Connect screen`, async () => {
  mkdirSync(join(SHOTS, 'installed'), { recursive: true })
  // A public build must ignore the run-time local-Claude-Code variable (build-flags.ts).
  const { app, page } = await launch({ REELSTUDIO_MOCK_AI: '0', REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD: '1' })
  try {
    await passFirstRun(page)
    const info = await page.evaluate(() => (window as any).reel.app.info())
    console.log('app info ' + JSON.stringify(info))
    expect(info.engine.mode).toBe('real')
    expect(info.ai).toBe('package')
    const ids = ((await page.evaluate(() => (window as any).reel.ai.providers())) as { id: string }[]).map((p) => p.id)
    console.log('providers ' + ids.join(','))
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('signin-chatgpt')).toBeVisible()
    await expect(page.getByTestId('claude-key-toggle')).toBeVisible()
    if (EXPECT === 'local') {
      expect(info.localClaudeCode).toBe(true)
      expect(ids).toContain('claude-cli')
      await expect(page.getByTestId('ai-connected')).toHaveText(/Using Claude Code on this computer/, { timeout: 20_000 })
    } else {
      expect(info.localClaudeCode).toBe(false)
      expect(ids).not.toContain('claude-cli')
      expect(ids.sort()).toEqual(['chatgpt', 'claude', 'none'])
      await expect(page.getByTestId('use-local-claude')).toHaveCount(0)
      await expect(page.getByText('Claude Code')).toHaveCount(0)
      await expect(page.getByTestId('ai-connected')).toHaveCount(0)
    }
    await shot(page, `installed/${EXPECT}-connect`)
  } finally {
    await app.close()
  }
})
