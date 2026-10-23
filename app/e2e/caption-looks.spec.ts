// The subtitle looks in "Edit it myself": a Size the person picked survives every look, Karaoke shows both
// colour rows, and colours the AI editor picked that match no option leave the rows unchecked but reachable by Tab.
//
// Run: npx playwright test e2e/caption-looks.spec.ts (after npm run build). Same env as smoke.spec.ts.
import { test, expect } from '@playwright/test'
import { launch, makeMedia, passFirstRun, shot } from './helpers'

test('caption looks: size through look switches, Karaoke rows, colours that match no option', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 5 * 60_000 })

    await page.getByTestId('edit-myself').click()
    await page.getByTestId('tab-captions').click()
    await page.getByTestId('cap-size-big').click()
    await page.getByTestId('cap-look-bold-pop').click()
    await expect(page.getByTestId('cap-size-big')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('cap-look-minimal').click()
    await expect(page.getByTestId('cap-look-minimal')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('cap-size-big')).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('cap-size-medium').click()
    await page.getByTestId('cap-look-karaoke').click()
    await expect(page.getByTestId('cap-color-white')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('cap-highlight-yellow')).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'looks-karaoke-rows')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('drawer')).toHaveCount(0)

    // A reel the AI editor gave red captions and a green spoken word (#34C759, not the row's #30D158).
    const detail = await page.evaluate(async () => {
      const [p] = await window.reel.projects.list()
      return window.reel.projects.get(p.slug)
    })
    const styled = {
      ...detail,
      project: { ...detail.project, captions: { ...detail.project.captions, enabled: true, style: { ...detail.project.captions?.style, color: '#FF3B30', highlight: '#34C759' } } }
    }
    await app.evaluate(({ ipcMain }, d) => {
      ipcMain.removeHandler('projects:get')
      ipcMain.handle('projects:get', () => ({ ok: true, value: d }))
    }, styled)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('project-card').click()
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('tab-captions').click()
    for (const id of ['cap-color-white', 'cap-color-yellow', 'cap-highlight-yellow', 'cap-highlight-green'])
      await expect(page.getByTestId(id)).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('cap-pos-lower').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('cap-color-white')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('cap-highlight-yellow')).toBeFocused()
    await shot(page, 'looks-unmatched-colours')
  } finally {
    await app.close()
  }
})
