// Checks on an INSTALLED (packaged) app: REELSTUDIO_E2E_EXE=<the app binary>. There is one build for everyone.
// REELSTUDIO_E2E_AI=package without an EXE runs the same checks on the unpackaged app with the real AI package.
// Proves it offers "Claude (your Claude Code app)" in whatever state this computer is in (ready / not signed in /
// found but broken / not installed), never picks it on its own, never shows the Claude account, and never calls
// Reel Studio "Claude Code". It never clicks "Sign in to your Claude Code app" (that opens a real terminal).
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_CODE_LABEL, CLAUDE_CODE_MISNAMED, SHOTS, USE_CLAUDE_CODE, launch, passFirstRun, shot } from './helpers'

const EXE = !!process.env.REELSTUDIO_E2E_EXE
test.skip(!EXE && process.env.REELSTUDIO_E2E_AI !== 'package', 'set REELSTUDIO_E2E_EXE (or REELSTUDIO_E2E_AI=package)')

test('installed app: the Claude choice, in this computer\'s real state', async () => {
  mkdirSync(join(SHOTS, 'installed'), { recursive: true })
  const { app, page } = await launch({ REELSTUDIO_MOCK_AI: '0' })
  try {
    await passFirstRun(page) // a fresh profile: nothing chosen yet
    const info = await page.evaluate(() => (window as any).reel.app.info())
    console.log('app info ' + JSON.stringify(info))
    if (EXE) expect(info.engine.mode).toBe('real')
    expect(info.ai).toBe('package')
    // one build: no flavour field, just these
    expect(Object.keys(info).sort()).toEqual(['ai', 'dev', 'engine', 'firstRunDone', 'platform', 'root', 'rootDisplay', 'test', 'version'])

    const providers = (await page.evaluate(() => (window as any).reel.ai.providers())) as { id: string; label: string; detail?: string }[]
    expect(providers.map((p) => p.id)).toEqual(['claude', 'claude-cli', 'codex-cli', 'none'])
    const cc = providers.find((p) => p.id === 'claude-cli')!
    expect(cc.label).toBe(CLAUDE_CODE_LABEL)
    const st = (await page.evaluate(() => (window as any).reel.ai.claudeCodeStatus())) as Record<string, unknown>
    console.log('claude code ' + JSON.stringify(st))
    expect(['missing', 'broken', 'signed_out', 'ready']).toContain(st.state)
    for (const k of Object.keys(st)) expect(['state', 'version', 'plan', 'reason']).toContain(k)
    expect(JSON.stringify([st, providers])).not.toMatch(/\w@\w/) // no e-mail address reaches the page
    expect((await page.evaluate(() => (window as any).reel.ai.active())).id).toBe('none') // never picked on its own

    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('vendor-claude')).not.toHaveAttribute('data-step', 'loading')
    await expect(page.getByTestId('claude-key-toggle')).toBeVisible()
    const panel = page.locator('.panel').first()
    if (st.state === 'ready') {
      // what the person already has comes first
      await expect(page.getByTestId('use-claude-code')).toHaveText(USE_CLAUDE_CODE)
      await expect(panel.locator('button.btn.big').first()).toHaveAttribute('data-testid', 'use-claude-code')
    } else {
      // Claude first: one button that installs (missing, broken) or signs in (signed out)
      await expect(panel.locator('button.btn.big').first()).toHaveAttribute('data-testid', 'connect-claude')
      await expect(page.getByTestId('connect-claude')).toHaveClass(/primary/)
    }
    await expect(page.getByTestId('vendor-chatgpt')).toBeVisible()
    if (st.state === 'ready') await expect(panel).toContainText('your own Claude plan and its usage limits')
    else await expect(panel).toContainText('Needs Claude Pro or Max.')
    expect(await page.locator('body').innerText()).not.toMatch(CLAUDE_CODE_MISNAMED)
    await shot(page, `installed/connect-${st.state}`)

    if (st.state === 'ready') {
      await page.getByTestId('use-claude-code').click()
      await expect(page.getByTestId('ai-connected')).toHaveText('Using Claude through your Claude Code app.')
      await page.getByTestId('nav-home').click() // the sidebar re-reads the AI editor on every screen change
    await expect(page.getByTestId('ai-status')).toContainText(`AI editor: ${CLAUDE_CODE_LABEL}`)
      expect(await page.locator('body').innerText()).not.toMatch(CLAUDE_CODE_MISNAMED)
      await shot(page, 'installed/connect-using-claude')
    }
  } finally {
    await app.close()
  }
})
