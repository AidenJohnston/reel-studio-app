// The editor component end to end, with the real AI package and a fake CLIProxyAPI on a random port: found from its
// config, connected in one click, its accounts and limits read with the management key, Test, a limit with whose
// accounts and when they reset, the model picker, a stale key, and Settings › Editor drawing the same component.
// The person's own Claude Code and Codex apps see a throwaway home, so their real sign-ins are never touched.
// REELSTUDIO_EDITOR_SHOTS=<folder> also saves each state at the four window sizes.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeHub } from '../../ai/test/fakeHub'
import { BASE, launch, modelReady, toEditorStep } from './helpers'

const SIZES: [number, number][] = [[1100, 720], [1280, 820], [1512, 982], [1920, 1080]]
const SHOTS = process.env.REELSTUDIO_EDITOR_SHOTS

let hub: FakeHub
let configDir: string
let app: ElectronApplication
let page: Page

async function sized(name: string, ready: () => Promise<void> = async () => {}): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const [w, h] of SIZES) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([w, h])
    await ready()
    await page.waitForTimeout(250)
    // the sample's crossfade and any other finite animation finish first, so a shot never catches one mid-frame
    await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 2000))]))
    await page.screenshot({ path: join(SHOTS, `${name}@${w}x${h}.png`) })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 820))
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  hub = new FakeHub()
  await hub.start()
  configDir = mkdtempSync(join(BASE, 'hub-config-'))
  writeFileSync(join(configDir, 'config.yaml'), `host: ""\nport: ${hub.port}\napi-keys:\n  - "${hub.key}"\n`)
  // its own profile: a first run, whatever specs ran before it in this worker
  const mine = mkdtempSync(join(BASE, 'editor-hub-'))
  ;({ app, page } = await launch(
    {
      REELSTUDIO_MOCK_AI: '0',
      REELSTUDIO_TEST_VENDOR_HOME: join(mine, 'vendor home'),
      REELSTUDIO_TEST_HUB_CONFIG: configDir,
      REELSTUDIO_USER_DATA: join(mine, 'user data'),
      REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio')
    },
    { realViewport: true }
  ))
})

test.afterAll(async () => {
  await app?.close()
  await hub?.stop()
})

test('CLIProxyAPI is found from its config and is the recommended first row', async () => {
  test.setTimeout(120_000)
  await page.getByTestId('get-started').click()
  await page.getByTestId('demo-skip').click()
  await toEditorStep(page)
  const row = page.getByTestId('hub-row')
  await expect(row).toHaveAttribute('data-state', 'ready')
  await expect(row).toContainText('CLIProxyAPI')
  await expect(row).toContainText('Recommended')
  await expect(row).toContainText('5 models on this Mac')
  // where the key came from, in words; the path in its tooltip
  await expect(row).toContainText('Key read from its config')
  await expect(row.locator('.pv-src')).toHaveAttribute('title', `Key read from ${join(configDir, 'config.yaml')}`)
  // first in the picker, and its Use it is the screen's one filled button
  await expect(page.getByTestId('ai-picker').locator(':scope > *').first()).toHaveAttribute('data-testid', 'hub-row')
  await expect(page.getByTestId('ai-picker').locator('.btn.primary')).toHaveCount(1)
  await expect(page.getByTestId('hub-use')).toHaveClass(/primary/)
  // no in-app installer: a missing Claude Code links to Anthropic's page
  await expect(page.getByTestId('vendor-claude')).toHaveAttribute('data-state', 'missing')
  await expect(page.getByTestId('vendor-install-page-claude')).toHaveAttribute('href', /claude/)
  // the key never reached the page
  expect(await page.content()).not.toContain(hub.key)
  await sized('first-run-hub-found')
})

test('Use it connects with the config’s key; accounts, plans and limits need the management key', async () => {
  test.setTimeout(120_000)
  await page.getByTestId('hub-use').click()
  await expect(page.getByTestId('hub-row')).toHaveAttribute('data-state', 'connected')
  await expect(page.getByTestId('editor-continue')).toBeVisible()
  await expect(page.getByTestId('hub-management')).toBeVisible()
  await page.getByTestId('hub-management-key').fill('wrong-key')
  await page.getByTestId('hub-management-add').click()
  await expect(page.getByTestId('hub-management')).toContainText('did not accept that management key')
  await page.getByTestId('hub-management-key').fill(hub.managementKey)
  await page.getByTestId('hub-management-add').click()
  const accounts = page.getByTestId('editor-account')
  await expect(accounts).toHaveCount(3)
  await expect(accounts.nth(0)).toContainText('maya@example.com')
  await expect(accounts.nth(1).locator('.ed-lw').first()).toHaveAttribute('aria-label', /^5-hour: 0% left, resets today at .+ \(in 4\d minutes\)$/)
  await expect(accounts.nth(2)).toContainText('ChatGPT · Pro')
  // each bar says it is what's left, and when it resets
  await expect(accounts.nth(0).locator('.ed-lw').first()).toHaveText(/^5-hour62% left · resets /)
  await expect(accounts.nth(1).locator('.ed-lw').first()).toContainText('0% left · resets in 4')
  // the person's own apps wait behind one quiet line while CLIProxyAPI is the editor
  await expect(page.getByTestId('other-editors')).toHaveText(/Other editors\s*Claude Code app, Codex app/)
  await expect(page.getByTestId('vendor-claude')).toBeHidden()
  // the models section names what each stage runs: Auto, and what Auto is right now
  await expect(page.getByTestId('stage-models-toggle')).toContainText('Claude Sonnet 5.5')
  // naming versions runs no model on this editor, so the summary leaves it out
  await expect(page.getByTestId('stage-models-toggle')).not.toContainText('Reel Studio')
  await expect(page.getByTestId('stage-models-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('stage-editor')).toBeHidden()
  expect(await page.content()).not.toContain(hub.managementKey)
  await sized('first-run-hub-accounts')
})

test('Test says what answered, with which model, and how long it took', async () => {
  await page.getByTestId('editor-test').click()
  await expect(page.getByTestId('editor-test-result')).toHaveText(/^“OK” from Claude Sonnet 5\.5 in \d+(\.\d s| ms)$/)
  expect(hub.requests.filter((r) => r.path === '/v1/messages').at(-1)).toMatchObject({ key: 'client', model: 'claude-sonnet-5-5' })
})

test('a limit names whose accounts hit it and when they reset, and offers the other family’s model', async () => {
  test.setTimeout(120_000)
  hub.limited = { family: 'claude', resetSeconds: 2 * 3600 + 14 * 60 }
  await page.getByTestId('editor-test').click()
  // the bars' own terms: which account is at which limit until when, which one has room, by display name
  await expect(page.getByTestId('editor-test-result')).toContainText('studio@example.com is at its 5-hour limit until')
  await expect(page.getByTestId('editor-test-result')).toContainText('Claude Sonnet 5.5 can still use maya@example.com. Try again in a minute.')
  await expect(page.getByTestId('editor-test-result')).not.toContainText('claude-sonnet-5-5')
  await expect(page.getByTestId('editor-use-other')).toHaveText('Try GPT 6.1 Sol for Edits')
  await sized('first-run-hub-limit')
  await page.getByTestId('editor-use-other').click()
  await page.getByTestId('stage-models-toggle').click()
  await expect(page.getByTestId('model-checker')).toHaveText(/^Auto · Claude Sonnet 5\.5/)
  await expect(page.getByTestId('model-editor')).toContainText('GPT 6.1 Sol')
  hub.limited = null
  await page.getByTestId('editor-test').click()
  await expect(page.getByTestId('editor-test-result')).toHaveText(/^“OK” from GPT 6\.1 Sol in /)
  // the accounts are read again after each Test, so look at the last model call
  expect(hub.requests.filter((r) => r.path === '/v1/chat/completions' || r.path === '/v1/messages').at(-1)).toMatchObject({ path: '/v1/chat/completions', header: 'bearer', model: 'gpt-6.1-sol' })
})

test('each stage has a searchable picker grouped by provider, with the model’s reasoning levels', async () => {
  test.setTimeout(120_000)
  await page.getByTestId('model-checker').click()
  const picker = page.getByTestId('model-picker')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('group', { name: 'Claude' })).toBeVisible()
  await expect(picker.getByRole('group', { name: 'ChatGPT' })).toBeVisible()
  await expect(picker.getByText('GPT Image 2')).toHaveCount(0)
  await expect(picker.getByTestId('model-opt-auto')).toContainText('Now Claude Sonnet 5.5')
  await sized('first-run-model-picker', async () => {
    if (!(await picker.isVisible())) await page.getByTestId('model-checker').click()
    // inside the window at every size
    const box = (await picker.boundingBox())!
    const [w, h] = await page.evaluate(() => [innerWidth, innerHeight])
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(w)
    expect(box.y + box.height).toBeLessThanOrEqual(h)
  })
  if (!(await picker.isVisible())) await page.getByTestId('model-checker').click()
  await page.getByTestId('model-search').fill('opus')
  await expect(picker.locator('[data-opt]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)
  await expect(page.getByTestId('model-checker')).toContainText('Claude Opus 5.5')
  await page.getByTestId('model-checker').click()
  await page.getByTestId('effort-high').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('model-checker')).toContainText('Claude Opus 5.5 · High')
  expect((await page.evaluate(() => window.reel.app.info())).models).toMatchObject({ editor: 'gpt-6.1-sol', checker: 'claude-opus-5-5(high)', planner: 'auto' })
})

test('a family whose accounts are all at a limit stays offered, last, saying when it is free again', async () => {
  test.setTimeout(120_000)
  const before = hub.accounts
  hub.accounts = before.map((a) => (a.provider === 'claude' ? { ...a, used: [100, a.used[1]] as [number, number] } : a))
  // the accounts are read again after each Test
  await page.getByTestId('editor-test').click()
  await expect(page.getByTestId('editor-test-result')).toHaveText(/^“OK” from /)
  await expect(page.getByTestId('editor-account').nth(0).locator('.ed-lw').first()).toContainText('0% left')
  await page.getByTestId('model-checker').click()
  const picker = page.getByTestId('model-picker')
  const groups = picker.getByRole('group')
  await expect(groups.last()).toHaveAccessibleName('Claude')
  await expect(groups.first()).toHaveAccessibleName('ChatGPT')
  await expect(groups.last()).toContainText(/at its limit until ([A-Z][a-z]{2} )?\d{1,2}(:\d{2})? [AP]M/)
  await expect(picker.locator('.mopt.spent').first()).toBeEnabled()
  await sized('first-run-model-picker-limit', async () => {
    if (!(await picker.isVisible())) await page.getByTestId('model-checker').click()
  })
  await page.keyboard.press('Escape')
  hub.accounts = before
  await page.getByTestId('editor-test').click()
  await expect(page.getByTestId('editor-account').nth(0).locator('.ed-lw').first()).toContainText('62% left')
})

test('a key the hub refuses: the same row asks for one, and a typed key says so in the row', async () => {
  test.setTimeout(120_000)
  await page.getByTestId('use-no-ai').first().click()
  hub.rejectKey = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const row = page.getByTestId('hub-row')
  await expect(row).toHaveAttribute('data-state', 'needs-key')
  await expect(row).toContainText('It refused the keys in its config.')
  await sized('first-run-hub-key-needed')
  hub.rejectKey = false
  await page.getByTestId('hub-key').fill(hub.key)
  await page.getByTestId('hub-use-key').click()
  await expect(row).toHaveAttribute('data-state', 'connected')
  const [c] = await page.evaluate(() => window.reel.ai.connections())
  expect(c).toMatchObject({ kind: 'cliproxy', keySource: 'typed', hasKey: true, hasManagementKey: true })
})

test('Settings › Editor draws the same component, with every stage open', async () => {
  test.setTimeout(240_000)
  await modelReady(page)
  await page.getByTestId('editor-continue').click()
  await expect(page.getByTestId('planned-stage')).toBeVisible()
  // a stage left on a model this editor doesn't offer shows Auto, which is what runs (ai index.ts modelForRole)
  const info = await page.evaluate(() => window.reel.app.info())
  await page.evaluate((m) => window.reel.app.setModels(m), { ...info.models, writer: 'gpt-retired(high)' })
  await page.getByTestId('account').click()
  const settings = page.getByTestId('settings-editor')
  await expect(settings.getByTestId('model-writer')).toHaveText('Auto · Claude Sonnet 5.5')
  await expect(settings.getByTestId('stage-writer')).toContainText('Your editor doesn’t offer GPT Retired now, so Auto is used.')
  await expect(settings.getByTestId('editor-setup')).toBeVisible()
  await expect(settings.getByTestId('hub-row')).toHaveAttribute('data-state', 'connected')
  await expect(settings.getByTestId('editor-account')).toHaveCount(3)
  await expect(settings.locator('.mrow')).toHaveCount(7)
  await expect(settings.getByTestId('stage-planner')).toContainText('Plans reels')
  await expect(settings.getByTestId('model-namer')).toHaveText('Auto · Reel Studio’s own titles')
  await sized('settings-editor')
  await settings.getByTestId('ai-advanced').click()
  await settings.getByTestId('own-server-toggle').click()
  await expect(settings.getByTestId('connection-address')).toBeVisible()
  await sized('settings-editor-own-server')
})
