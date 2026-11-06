// Settings › Privacy: anonymous usage data is kept only once the person shares it, shown to them line by line, and
// deleted when they stop sharing (src/main/usage.ts).
import { test, expect, type Page } from '@playwright/test'
import { launch, makeMedia, makeReel, openSettings, passFirstRun, shot } from './helpers'

const kept = (page: Page) => page.evaluate(() => window.reel.app.usage())

test('usage data is kept only while shared, shown in plain words, and deleted when sharing stops', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    // off by default: a first edit leaves nothing behind
    await makeReel(page, media.video)
    expect(await kept(page)).toEqual([])

    await openSettings(page)
    await page.getByTestId('settings-search').fill('telemetry')
    await expect(page.locator('[data-setting="sharing-kept"]')).toHaveCount(0)
    await page.getByTestId('share-on').click()
    const row = page.locator('[data-setting="sharing-kept"]')
    await expect(row).toContainText('Nothing yet.')

    await makeReel(page, media.video)
    await expect.poll(async () => (await kept(page)).map((l) => `${l.name} ${'job' in l ? l.job : ''} ${'outcome' in l ? l.outcome : ''}`)).toEqual(['job first-edit done'])
    const [line] = await kept(page)
    expect(Object.keys(line).sort()).toEqual(['app', 'day', 'install', 'job', 'name', 'os', 'outcome', 'part', 'seconds'])

    await openSettings(page)
    await page.getByTestId('settings-search').fill('telemetry')
    await expect(row).toContainText('1 event waiting. None has been sent.')
    await page.getByTestId('usage-show').click()
    await expect(page.getByTestId('usage-lines')).toContainText(/First edit finished, \d+ s/)
    await shot(page, 'usage-kept')

    await page.getByTestId('share-on').click()
    await expect(row).toHaveCount(0)
    expect(await kept(page)).toEqual([])
    await shot(page, 'usage-off')
  } finally {
    await app.close()
  }
})
