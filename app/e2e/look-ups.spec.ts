// Settings > "Look things up in parallel": the switch a person turns on so a note can hand searches to a second AI.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { BASE, launch, openSettings, passFirstRun, shot } from './helpers'

test('fails if Look things up in parallel cannot be found in Settings, starts on, or forgets being turned on', async () => {
  const dirs = { REELSTUDIO_USER_DATA: join(BASE, 'look-ups', 'data'), REELSTUDIO_ROOT: join(BASE, 'look-ups', 'Reel Studio') }
  let { app, page } = await launch(dirs)
  try {
    await passFirstRun(page)
    await openSettings(page)
    const row = page.locator('[data-setting="look-ups"]')
    await row.scrollIntoViewIfNeeded()
    await expect(page.getByTestId('look-ups')).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('look-ups').click()
    await expect(page.getByTestId('look-ups')).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'look-ups-01-on')
    await app.close()
    ;({ app, page } = await launch(dirs))
    expect(await page.evaluate(() => window.reel.ai.lookUps())).toBe(true)
  } finally {
    await app.close()
  }
})
