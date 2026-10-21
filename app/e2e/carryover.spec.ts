// 0.1.2 carry-over, with the REAL AI package and this computer's own Claude Code app: an install of the old
// local-Claude-Code build (settings.json `aiAutoPicked`, no saved AI choice) opens already using Claude, once;
// an old public install opens with no AI. Skipped when the Claude Code app is not signed in here.
// Run: npm run build && REELSTUDIO_E2E_AI=package npx playwright test e2e/carryover.spec.ts
import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch } from './helpers'

test.skip(process.env.REELSTUDIO_E2E_AI !== 'package', 'set REELSTUDIO_E2E_AI=package (uses the real Claude Code app)')

async function openWith(name: string, settings: Record<string, unknown>) {
  const userData = join(BASE, `carry ${name}`)
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  const { app, page } = await launch({ REELSTUDIO_MOCK_AI: '0', REELSTUDIO_USER_DATA: userData })
  const st = (await page.evaluate(() => (window as any).reel.ai.claudeCodeStatus())) as { state: string }
  const active = (await page.evaluate(() => (window as any).reel.ai.active())) as { id: string }
  const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  await app.close()
  return { st, active, saved }
}

test('old local-Claude-Code install keeps Claude; old public install stays at no AI', async () => {
  const old = await openWith('old local build', { firstRunDone: true, root: null, aiAutoPicked: true })
  test.skip(old.st.state !== 'ready', `Claude Code app here is "${old.st.state}"`)
  expect(old.active.id).toBe('claude-cli')
  expect(old.saved.aiCarriedOver).toBe(true)
  const pub = await openWith('old public build', { firstRunDone: true, root: null })
  expect(pub.active.id).toBe('none')
  expect(pub.saved.aiCarriedOver).toBeUndefined()
})
