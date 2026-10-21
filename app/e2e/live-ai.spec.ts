// Live AI run: real engine + a real AI provider through the whole UI. Skipped unless asked for:
//   REELSTUDIO_E2E_LIVE_AI=claude-cli (or codex-cli)  REELSTUDIO_ENGINE_DIR=<engine>
//   REELSTUDIO_E2E_VIDEO=<raw take>   [REELSTUDIO_MODELS_DIR, REELENGINE_MODEL]
// Uses the developer's own logged-in CLI, so it is never part of the normal test run.
import { test, expect } from '@playwright/test'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, makeMedia, passFirstRun, shot } from './helpers'

const PROVIDER = process.env.REELSTUDIO_E2E_LIVE_AI

test.skip(!PROVIDER, 'set REELSTUDIO_E2E_LIVE_AI to run')

test('first edit and a note with a live AI provider', async () => {
  test.setTimeout(60 * 60_000)
  mkdirSync(join(SHOTS, 'live'), { recursive: true })
  const media = makeMedia()
  const events = join(BASE, 'live-events.log')
  const { app, page } = await launch({ REELSTUDIO_DEV: '1', REELSTUDIO_MOCK_AI: '0' })
  await passFirstRun(page)
  await page.evaluate(() => window.reel.jobs.onEvent((e) => console.log('JOB ' + JSON.stringify(e))))
  page.on('console', (m) => {
    if (m.text().startsWith('JOB ')) appendFileSync(events, `${new Date().toISOString()} ${m.text().slice(4)}\n`)
  })

  await page.getByTestId('nav-settings').click()
  await page.getByTestId(`provider-${PROVIDER}`).click()
  await expect(page.getByTestId(`provider-${PROVIDER}`)).toHaveClass(/active/)
  await shot(page, 'live/01-settings-dev-provider')

  await page.getByTestId('nav-library').click()
  await page.getByTestId('file-input').setInputFiles([media.song])
  await page.getByTestId('nav-home').click()
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByText('Making your reel')).toBeVisible()
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(20_000)
    if (await page.getByTestId('player').isVisible()) break
    await shot(page, `live/02-working-${i}`)
  }
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 45 * 60_000 })
  await shot(page, 'live/03-reel')
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-broll').click()
  await shot(page, 'live/04-broll')
  await page.getByTestId('tab-post').click()
  await shot(page, 'live/05-post')
  await page.getByText('Close', { exact: true }).click()

  const replies = page.locator('.bubble.editor:not(.working):not(.reply-pending)')
  const bubbles = await replies.count()
  await page.getByTestId('note-input').fill('Make the music a bit quieter')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('note-progress')).toBeVisible()
  await shot(page, 'live/06-note-working')
  await expect(replies).toHaveCount(bubbles + 1, { timeout: 20 * 60_000 })
  await expect(page.getByTestId('note-progress')).toHaveCount(0)
  await shot(page, 'live/07-after-note')
  console.log(`events: ${events}`)
  await app.close()
})
