// The person's own Claude Code app and Codex app as rows of the editor picker: a signed-in app connects with one
// click, a signed-out one opens its maker's own sign-in page, and a missing one links to its install page. Reel Studio
// installs neither. The mock AI plays every state (REELSTUDIO_MOCK_CLAUDE / REELSTUDIO_MOCK_CODEX, see main/ai-mock.ts);
// no browser opens. Each vendor is a row of Settings › Editor; a sign-in's steps open under its row.
//
// Run: `npx playwright test e2e/connect.spec.ts` after `electron-vite build` (unset ELECTRON_RUN_AS_NODE first).
import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, CLAUDE_CODE_MISNAMED, USE_CLAUDE_CODE, launch, openSettings, passFirstRun, shot } from './helpers'

async function connectScreen(claude: string, codex = 'missing') {
  const mine = mkdtempSync(join(BASE, `connect-${claude}-${codex}-`))
  const userData = join(mine, 'user data')
  const { app, page } = await launch({
    REELSTUDIO_MOCK_CLAUDE: claude,
    REELSTUDIO_MOCK_CODEX: codex,
    REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio'),
    REELSTUDIO_USER_DATA: userData
  })
  await passFirstRun(page)
  const info = await page.evaluate(() => window.reel.app.info())
  await openSettings(page)
  const panel = page.locator('#sec-editor')
  for (const v of ['claude', 'chatgpt']) await expect(page.getByTestId(`vendor-${v}`)).not.toHaveAttribute('data-step', 'loading')
  return { app, page, info, userData, panel, claude: page.getByTestId('vendor-claude'), chatgpt: page.getByTestId('vendor-chatgpt') }
}

/** Nothing on screen may call Reel Studio "Claude Code", and no em dashes. */
async function plainWords(page: import('@playwright/test').Page): Promise<void> {
  const text = await page.locator('body').innerText()
  expect(text).not.toMatch(CLAUDE_CODE_MISNAMED)
  expect(text).not.toContain('—')
}

test('nothing on this computer: each row says so and links to its maker\'s install page; nothing installs', async () => {
  const { app, page, info, panel, claude, chatgpt } = await connectScreen('missing', 'missing')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  // with nothing else ready, CLIProxyAPI is the first row, saying it isn't running here, with an outlined Check again
  await expect(page.getByTestId('ai-picker').locator(':scope > *').first()).toHaveAttribute('data-testid', 'hub-row')
  await expect(page.getByTestId('hub-row')).toHaveAttribute('data-state', 'none')
  await expect(page.getByTestId('hub-row')).toContainText('Not running on this computer')
  await expect(page.getByTestId('hub-look')).not.toHaveClass(/\bprimary\b/)
  await expect(page.getByTestId('hub-about')).toHaveAttribute('href', 'https://github.com/router-for-me/CLIProxyAPI')
  await expect(claude).toHaveAttribute('data-state', 'missing')
  await expect(chatgpt).toHaveAttribute('data-state', 'missing')
  await expect(claude).toContainText('Not on this Mac.')
  await expect(page.getByTestId('vendor-install-page-claude')).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup')
  await expect(page.getByTestId('vendor-install-page-chatgpt')).toHaveAttribute('href', 'https://learn.chatgpt.com/docs/codex/cli')
  await expect(page.getByTestId('connect-claude')).toHaveCount(0) // no button that would install
  await expect(panel.locator('.btn.primary')).toHaveCount(0)
  await expect(page.getByTestId('ai-advanced')).toBeVisible() // your own server or an API key still connects
  await expect(page.getByTestId('without-ai')).toBeVisible()
  await plainWords(page)
  await shot(page, 'connect-01-nothing-here')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none')
  await app.close()
})

test('signed out: Sign in opens Anthropic\'s own page, then the Claude Code app connects', async () => {
  const { app, page, info, panel, claude } = await connectScreen('signed_out', 'signed_out')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await expect(panel.locator('[data-testid="vendor-claude"], [data-testid="vendor-chatgpt"]').locator('.pv-main > button').first()).toHaveAttribute('data-testid', 'connect-claude')
  await expect(page.getByTestId('connect-claude')).toHaveClass(/primary/)
  await expect(page.getByTestId('connect-claude')).toHaveAccessibleName('Sign in to Claude Code app')
  await expect(page.getByTestId('connect-chatgpt')).not.toHaveClass(/primary/)
  await expect(claude).toContainText('Not signed in.')
  await page.getByTestId('connect-claude').click()
  await expect(claude).toHaveAttribute('data-step', 'signing_in')
  await expect(page.getByTestId('vendor-cancel-claude')).toBeFocused() // focus follows the pressed pill to Cancel
  await expect(claude).toContainText('Finish signing in on Anthropic’s page.')
  await expect(page.getByTestId('claude-free-hint')).toContainText('need Claude Pro or Max?')
  await expect(page.getByTestId('claude-window-fallback')).toBeVisible()
  await plainWords(page)
  await shot(page, 'connect-03-browser')
  await expect(page.getByTestId('ai-connected')).toHaveText('Connected', { timeout: 15_000 })
  await expect(page.locator('[data-provider="claude-cli"]')).toContainText('Connected')
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('ai-status')).toHaveText('Editor: Claude')
  await app.close()
})

test('Codex app signed out: its own sign-in, then "ChatGPT (your Codex app)" edits', async () => {
  const { app, page, info, chatgpt } = await connectScreen('missing', 'signed_out')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-chatgpt').click()
  await expect(chatgpt).toHaveAttribute('data-step', 'signing_in')
  await expect(chatgpt).toContainText('Finish signing in on OpenAI’s page.')
  await expect(page.getByTestId('claude-free-hint')).toHaveCount(0)
  await expect(page.getByTestId('claude-window-fallback')).toHaveCount(0)
  await expect(page.locator('[data-provider="codex-cli"]')).toContainText('Connected', { timeout: 15_000 })
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('ai-status')).toHaveText('Editor: ChatGPT')
  await plainWords(page)
  await app.close()
})

test('already signed in: "Use Claude (your Claude Code app)" comes first, and only the click turns it on', async () => {
  const { app, page, info, panel } = await connectScreen('ready')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await expect(page.getByTestId('use-claude-code')).toHaveAccessibleName(USE_CLAUDE_CODE)
  await expect(panel.locator('[data-testid="vendor-claude"], [data-testid="vendor-chatgpt"]').locator('.pv-main > button').first()).toHaveAttribute('data-testid', 'use-claude-code')
  await expect(page.getByTestId('use-claude-code')).toHaveClass(/primary/)
  // CLIProxyAPI, not running here, follows the app that is ready instead of sitting above it
  const rows = page.getByTestId('ai-picker').locator(':scope > [data-testid]')
  await expect(rows.first()).not.toHaveAttribute('data-testid', 'hub-row')
  await expect(rows.last()).toHaveAttribute('data-testid', 'hub-row')
  // the plan the app reports, beside its name
  await expect(page.getByTestId('vendor-plan-claude')).toHaveText('Max')
  await expect(panel).toContainText('Signed in. It uses your Claude plan’s limits.')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none') // never picked on its own
  await page.getByTestId('use-claude-code').click()
  await expect(page.getByTestId('ai-connected')).toHaveText('Connected')
  await plainWords(page)
  await app.close()
})

test('only ChatGPT is ready: "Use ChatGPT (your Codex app)" goes first', async () => {
  const { app, page, info, panel } = await connectScreen('missing', 'ready')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await expect(panel.locator('[data-testid="vendor-claude"], [data-testid="vendor-chatgpt"]').locator('.pv-main > button').first()).toHaveAttribute('data-testid', 'use-codex')
  await expect(page.getByTestId('use-codex')).toHaveAccessibleName('Use ChatGPT (your Codex app)')
  await expect(page.getByTestId('use-codex')).toHaveClass(/primary/)
  await shot(page, 'connect-08-chatgpt-ready')
  await app.close()
})

test('waiting on the sign-in page: Cancel goes back to the button', async () => {
  const { app, page, info, claude } = await connectScreen('browser')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-claude').click()
  await expect(claude).toHaveAttribute('data-step', 'signing_in')
  await page.getByTestId('vendor-cancel-claude').click()
  await expect(page.getByTestId('connect-claude')).toBeVisible()
  await expect(page.getByTestId('connect-claude')).toBeFocused()
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none')
  await app.close()
})

test('the browser page never comes back: Open it again, the window fallback, and choosing ChatGPT instead', async () => {
  const { app, page, info, userData, claude } = await connectScreen('browser', 'signed_out')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-claude').click()
  await expect(claude).toHaveAttribute('data-step', 'signing_in')
  await page.getByTestId('vendor-again-claude').click()
  await expect(claude).toHaveAttribute('data-step', 'signing_in')
  // "The page shows a code?": today's terminal window, where the code goes into Anthropic's own app
  await page.getByTestId('claude-window-fallback').click()
  const launcher = join(userData, 'claude-sign-in', process.platform === 'win32' ? 'Sign in to Claude.cmd' : 'Sign in to Claude.command')
  await expect.poll(() => { try { return readFileSync(launcher, 'utf8') } catch { return '' } }).toContain('auth login --claudeai')
  // a free Claude plan: switch to ChatGPT from the hint; the waiting Claude sign-in stops
  await page.getByTestId('claude-free-switch').click()
  await expect(page.locator('[data-provider="codex-cli"]')).toContainText('Connected', { timeout: 15_000 })
  await expect(claude).toHaveAttribute('data-step', 'idle')
  await page.getByTestId('use-no-ai').click()
  await expect(page.getByTestId('connect-claude')).toBeVisible()
  await app.close()
})

test('a Claude plan the app reports as free: never chosen, with the way out', async () => {
  const { app, page, info, claude } = await connectScreen('free')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-claude').click()
  await expect(claude).toHaveAttribute('data-problem', 'free_plan', { timeout: 15_000 })
  await expect(page.getByTestId('vendor-message-claude')).toContainText('It needs Claude Pro or Max.')
  await expect(claude).toContainText('Or connect ChatGPT. Its free plan works, with limits.')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none')
  await plainWords(page)
  await shot(page, 'connect-07-free-plan')
  await app.close()
})

test('fails if a first look that went wrong leaves a row with nothing to press', async () => {
  const mine = mkdtempSync(join(BASE, 'connect-look-'))
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio'), REELSTUDIO_USER_DATA: join(mine, 'user data') })
  await passFirstRun(page)
  // the main process can't answer "is Claude's app here?" until the test lets it
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as { lookFails?: boolean }
    g.lookFails = true
    ipcMain.removeHandler('ai:vendorStatus')
    ipcMain.handle('ai:vendorStatus', async (_e, v: string) =>
      g.lookFails ? { ok: false, error: { code: 'LOOK', userMessage: 'no' } } : { ok: true, value: { vendor: v, state: 'signed_out', step: 'idle' } })
  })
  await openSettings(page)
  await expect(page.getByTestId('vendor-claude')).toContainText("Couldn’t look for Anthropic’s Claude Code app")
  await app.evaluate(() => void ((globalThis as { lookFails?: boolean }).lookFails = false))
  await page.getByTestId('vendor-look-claude').click()
  await expect(page.getByTestId('connect-claude')).toBeVisible()
  await app.close()
})

test('ChatGPT\'s sign-in port held by Windows: plain words, then one click signs in with a code instead', async () => {
  const { app, page, info, chatgpt } = await connectScreen('missing', 'port_reserved')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-chatgpt').click()
  await expect(chatgpt).toHaveAttribute('data-problem', 'port_busy')
  await expect(page.getByTestId('vendor-message-chatgpt')).toHaveText(/holding the port ChatGPT’s sign-in uses\.$/)
  await expect(page.getByTestId('vendor-retry-chatgpt')).toHaveText('Try again')
  const withCode = page.getByTestId('vendor-code-start-chatgpt')
  await expect(withCode).toHaveText('Sign in with a code instead')
  // reserved by Windows: Try again cannot work until the port is freed, so the code is the row's own action; like
  // every row action it is outlined (the panel's one filled button is the recommended one, or Continue)
  await expect(chatgpt.locator('.pv-main > button')).toHaveAttribute('data-testid', 'vendor-code-start-chatgpt')
  await expect(chatgpt.locator('.btn.primary')).toHaveCount(0)
  await expect(page.getByTestId('vendor-claude').locator('.btn.primary')).toHaveCount(0) // one filled button on the screen
  await plainWords(page)
  await shot(page, 'connect-12-port-reserved')
  // never on its own: nothing runs until the click
  await page.waitForTimeout(500)
  await expect(chatgpt).toHaveAttribute('data-step', 'failed')
  await withCode.click()
  await expect(chatgpt).toHaveAttribute('data-sign-in', 'code')
  const code = page.getByTestId('vendor-code-chatgpt')
  await expect(code).toHaveText('MOCK-26CODE')
  await expect(page.getByTestId('vendor-code-open-chatgpt')).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
  await expect(chatgpt).toContainText("ChatGPT’s security settings")
  await expect(page.getByTestId('vendor-again-chatgpt')).toHaveCount(0) // a new code each time: no "open again"
  await page.getByTestId('vendor-code-copy-chatgpt').click()
  await expect(page.getByTestId('vendor-code-copy-chatgpt')).toHaveText('Copied')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('MOCK-26CODE')
  await plainWords(page)
  await shot(page, 'connect-13-code')
  // the person enters the code on OpenAI's page; Codex says it worked; checked and chosen
  await expect(page.locator('[data-provider="codex-cli"]')).toContainText('Connected', { timeout: 15_000 })
  await app.close()
})

test('sign-in with a code turned off for the account: says where to turn it on', async () => {
  const { app, page, info, chatgpt } = await connectScreen('missing', 'code_off')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-chatgpt').click()
  await page.getByTestId('vendor-code-start-chatgpt').click()
  await expect(chatgpt).toHaveAttribute('data-problem', 'device_code_off')
  await expect(page.getByTestId('vendor-message-chatgpt')).toContainText("ChatGPT’s security settings")
  await expect(page.getByTestId('vendor-code-start-chatgpt')).toBeVisible() // turned on, it can be tried again
  await plainWords(page)
  await shot(page, 'connect-14-code-off')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none')
  await app.close()
})

test('Cancel while the code is on screen: back to the button', async () => {
  const { app, page, info, chatgpt } = await connectScreen('missing', 'port_reserved')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-chatgpt').click()
  await page.getByTestId('vendor-code-start-chatgpt').click()
  await expect(page.getByTestId('vendor-code-chatgpt')).toBeVisible()
  await page.getByTestId('vendor-cancel-chatgpt').click()
  await expect(page.getByTestId('connect-chatgpt')).toBeVisible()
  await expect(chatgpt).not.toHaveAttribute('data-sign-in', 'code')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none')
  await app.close()
})

test('ChatGPT\'s sign-in port only in use by another program: Try again stays the filled pill, the code second', async () => {
  const { app, page, info, chatgpt } = await connectScreen('missing', 'port_in_use')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await page.getByTestId('connect-chatgpt').click()
  await expect(chatgpt).toHaveAttribute('data-problem', 'port_busy')
  await expect(page.getByTestId('vendor-message-chatgpt')).toHaveText(/holding the port ChatGPT’s sign-in uses\.$/)
  await expect(chatgpt.locator('.pv-main > button')).toHaveAttribute('data-testid', 'vendor-retry-chatgpt')
  await expect(chatgpt.locator('.btn.primary')).toHaveCount(0)
  await plainWords(page)
  await shot(page, 'connect-15-port-in-use')
  await app.close()
})

test('ChatGPT\'s status unknown: it says so, Check again only asks again, and only Sign in starts a sign-in', async () => {
  const { app, page, info, chatgpt } = await connectScreen('missing', 'status_unknown')
  test.skip(info.ai !== 'mock', 'the mock plays the vendor states')
  await expect(chatgpt).toHaveAttribute('data-problem', 'status_unknown')
  await expect(page.getByTestId('vendor-message-chatgpt')).toHaveText("Couldn’t tell whether ChatGPT is signed in.")
  await expect(page.getByTestId('connect-chatgpt')).toHaveCount(0) // no button that would start a sign-in by itself
  // the safe choice is the row's filled pill; Sign in waits under the row and says what it does
  await expect(chatgpt.locator('.pv-main > button')).toHaveAttribute('data-testid', 'vendor-check-chatgpt')
  // one action at a time: Check again, outlined; a new sign-in waits behind its own confirm
  await expect(page.getByTestId('vendor-check-chatgpt')).not.toHaveClass(/\bprimary\b/)
  await expect(page.getByTestId('vendor-signin-chatgpt')).toHaveCount(0)
  await expect(page.getByTestId('vendor-claude').locator('.btn.primary')).toHaveCount(0) // one filled button on the screen
  await page.getByTestId('vendor-signin-ask-chatgpt').click()
  await expect(chatgpt).toContainText('A new sign-in makes your Codex app forget the one it has.')
  await expect(page.getByTestId('vendor-check-chatgpt')).toHaveCount(0)
  await chatgpt.getByRole('button', { name: 'Cancel' }).click()
  await plainWords(page)
  await shot(page, 'connect-16-status-unknown')
  await page.getByTestId('vendor-check-chatgpt').click()
  await expect(page.getByTestId('vendor-check-chatgpt')).toHaveText('Check again')
  await expect(page.getByTestId('vendor-message-chatgpt')).toHaveText("Couldn’t tell whether ChatGPT is signed in.")
  await page.waitForTimeout(500)
  await expect(chatgpt).not.toHaveAttribute('data-step', 'signing_in')
  expect(await page.evaluate(() => window.reel.ai.vendorStatus('chatgpt'))).toMatchObject({ step: 'idle', problem: 'status_unknown' })
  await page.getByTestId('vendor-signin-ask-chatgpt').click()
  await page.getByTestId('vendor-signin-chatgpt').click()
  await expect(page.locator('[data-provider="codex-cli"]')).toContainText('Connected', { timeout: 15_000 })
  await app.close()
})
