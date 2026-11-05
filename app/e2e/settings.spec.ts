// Settings search: every setting is found by its label or a synonym (test/settings-search.test.ts); this checks the
// page shows only what was found, under its section, and that Esc brings everything back.
import { test, expect } from '@playwright/test'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, openSettings, passFirstRun, shot, userData } from './helpers'

test('fails if a Settings search shows rows it did not find, hides a match, or Esc does not clear it', async () => {
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await openSettings(page)
    await expect(page.getByTestId('titlebar-title')).toHaveText('Settings')
    const search = page.getByTestId('settings-search')
    await expect(search).toBeFocused()

    await search.fill('telemetry')
    await expect(page.locator('[data-setting="sharing"]')).toBeVisible()
    await expect(page.getByTestId('share-on')).toBeVisible()
    await expect(page.getByTestId('settings-privacy')).toBeVisible()
    await expect(page.getByTestId('settings-editor')).toBeHidden()
    await expect(page.locator('[data-setting="library-folder"]')).toHaveCount(0)

    await search.fill('folder')
    await expect(page.locator('[data-setting]:visible')).toHaveCount(1)
    await expect(page.getByTestId('root-display')).toBeVisible()

    // your own server is part of the editor (r12): a search for it opens the editor's Advanced
    await search.fill('server')
    await expect(page.getByTestId('own-server-toggle')).toBeVisible()
    await expect(page.getByTestId('settings-editor')).toBeVisible()

    await search.fill('qwertyuiop')
    await expect(page.getByTestId('settings-no-match')).toHaveText(/No settings match “qwertyuiop”\./)
    await expect(page.locator('[data-setting]:visible')).toHaveCount(0)

    await search.press('Escape')
    await expect(search).toHaveValue('')
    await expect(page.locator('[data-setting="library-folder"]')).toBeVisible()
    await expect(page.getByTestId('settings-editor')).toBeVisible()
    await expect(page.getByTestId('settings-advanced')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('fails if Settings › Advanced cannot find, size and clear the cache, show the logs, or reset the first run', async () => {
  // the isolated engine cache (main/paths.ts engineCacheDir), as the engine leaves it, and a file that isn't its own
  const cache = join(userData(), 'engine cache')
  mkdirSync(join(cache, 'music-analysis'), { recursive: true })
  writeFileSync(join(cache, 'simple-icons.json'), Buffer.alloc(2_000_000))
  writeFileSync(join(cache, 'music-analysis', '0123456789abcdef0123456789abcdef.json'), Buffer.alloc(1_000_000))
  writeFileSync(join(cache, 'keep me.txt'), 'not the engine’s')

  let { app, page } = await launch()
  try {
    await passFirstRun(page)
    await openSettings(page)
    const search = page.getByRole('searchbox', { name: 'Search settings' })

    // Cmd+F (Ctrl+F) brings the search back from anywhere on the page
    await page.getByRole('heading', { name: 'About and updates' }).click()
    await expect(search).not.toBeFocused()
    await page.keyboard.press('ControlOrMeta+f')
    await expect(search).toBeFocused()

    await search.fill('cache')
    const row = page.locator('[data-setting="engine-cache"]')
    await expect(page.locator('[data-setting]:visible')).toHaveCount(1)
    await expect(row.locator('mark')).toHaveText(['Cache'])
    await expect(row.getByTestId('cache-size')).toHaveText('3 MB')
    await expect(row.getByTestId('cache-path')).toHaveText(/engine cache$/)

    await row.getByRole('button', { name: 'Clear cache' }).click()
    const confirm = page.getByRole('dialog', { name: 'Clear the cache?' })
    await expect(confirm).toContainText('3 MB')
    await confirm.getByRole('button', { name: 'Clear cache' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(row.getByTestId('cache-size')).toHaveText('Empty')
    await expect(row.getByRole('button', { name: 'Clear cache' })).toBeDisabled()
    expect(readdirSync(cache, { recursive: true }).map(String).sort()).toEqual(['keep me.txt', 'music-analysis']) // the engine's files go; the folders stay

    await search.press('Escape')
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { __opened: opened })
      shell.openPath = async (p: string) => (opened.push(p), '')
    })
    await page.getByRole('button', { name: 'Show logs' }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([join(userData(), 'logs')])

    await page.getByRole('button', { name: 'Reset…' }).click()
    await page.getByRole('dialog', { name: 'Reset the first run?' }).getByRole('button', { name: 'Reset first run' }).click()
    await expect(page.getByTestId('first-run-line')).toHaveText('The welcome and the sample show the next time Reel Studio opens.')
    await expect(page.getByTestId('titlebar-title')).toHaveText('Settings') // not in the middle of this launch
  } finally {
    await app.close()
  }

  ;({ app, page } = await launch())
  try {
    await expect(page.getByTestId('get-started')).toBeVisible()
    await passFirstRun(page)
    expect((await page.evaluate(() => window.reel.app.info())).firstRunAgain).toBe(false)
    // a second reset in the launch that showed it still waits for the next launch
    await openSettings(page)
    await page.getByRole('button', { name: 'Reset…' }).click()
    await page.getByRole('dialog', { name: 'Reset the first run?' }).getByRole('button', { name: 'Reset first run' }).click()
    await expect(page.getByTestId('first-run-line')).toHaveText('The welcome and the sample show the next time Reel Studio opens.')
    await expect(page.getByTestId('titlebar-title')).toHaveText('Settings')
  } finally {
    await app.close()
  }
})

// stock-search: Pexels and Pixabay keys sit in Advanced beside the Anthropic key. The stand-in AI keeps no keys,
// so saving one is refused, and the row must say so rather than claim it was saved.
test('fails if the stock photo keys cannot be found, opened, or a refused save looks saved', async () => {
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('settings-search').fill('pexels')
    const row = page.locator('[data-provider="pexels"]')
    await expect(row).toContainText('No key, so your editor skips it.')
    await expect(page.locator('[data-provider="pixabay"]')).toBeVisible()
    await page.getByTestId('stock-add-pexels').click()
    await page.getByTestId('stock-key-pexels').fill('not-a-real-key')
    await page.getByTestId('stock-save-pexels').click()
    await expect(row.getByRole('alert')).toContainText('Stock API keys need the AI package.')
    await expect(row).not.toContainText('Key saved')
    await shot(page, 'settings-stock-keys')
  } finally {
    await app.close()
  }
})
