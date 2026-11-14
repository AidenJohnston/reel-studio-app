// The subtitle looks in "Edit it myself": a Size the person picked survives every look, Karaoke shows both
// colour rows, colours the AI editor picked that match no option leave the rows unchecked but reachable by Tab, and
// each look's word fits its strip at the smallest window.
//
// Run: npx playwright test e2e/caption-looks.spec.ts (after npm run build). Same env as smoke.spec.ts.
import { test, expect } from '@playwright/test'
import { launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

test('caption looks: size through look switches, Karaoke rows, colours that match no option', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)

    // A reel the AI editor gave purple captions and a green spoken word (#34C759, not the row's #30D158). First, since
    // Edit it myself keeps its changes when it closes and would show those instead.
    const detail = await page.evaluate(async () => {
      const [p] = await window.reel.projects.list()
      return window.reel.projects.get(p.slug)
    })
    const withColor = (color: string) => ({
      ...detail,
      project: { ...detail.project, captions: { ...detail.project.captions, enabled: true, style: { ...detail.project.captions?.style, color, highlight: '#34C759' } } }
    })
    const openWith = async (d: ReturnType<typeof withColor>) => {
      await app.evaluate(({ ipcMain }, v) => {
        ipcMain.removeHandler('projects:get')
        ipcMain.handle('projects:get', () => ({ ok: true, value: v }))
      }, d)
      await page.getByTestId('nav-home').click()
      await page.getByTestId('project-card').click()
      await page.getByTestId('edit-myself').click()
      await page.getByTestId('tab-captions').click()
    }

    // fails if a red the editor picked (#FF0000 for "bright red", not the row's #FF3B30) shows as a second red beside
    // Red rather than as Red (the runner's Windows capture, 2026-11-14)
    await openWith(withColor('#FF0000'))
    await expect(page.getByTestId('cap-color-red')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('cap-color-current')).toHaveCount(0)
    await page.getByTestId('drawer-close').click()

    await openWith(withColor('#BF5AF2'))
    // fails if the Colour row shows no option checked while the reel has purple words (#53), or names it a colour
    // it is not
    await expect(page.getByTestId('cap-color-current')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('cap-color-current')).toHaveText('Purple')
    for (const id of ['cap-color-white', 'cap-color-yellow', 'cap-color-red', 'cap-highlight-yellow', 'cap-highlight-green'])
      await expect(page.getByTestId(id)).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('cap-pos-lower').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('cap-color-current')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('cap-highlight-yellow')).toBeFocused()
    await shot(page, 'looks-unmatched-colours')
    // Red is a choice by hand, and once picked the editor's colour is gone from the row
    await page.getByTestId('cap-color-red').click()
    await expect(page.getByTestId('cap-color-red')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('cap-color-current')).toHaveCount(0)

    // a Size the person picked survives every look; Karaoke shows both colour rows
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

    // fails if a look's word is cut off by its strip at the smallest window (Bold pop's ran off its tile at 1100), or
    // drawn on a card the export doesn't have (Bold pop's sat on the menu's white card, 12 px taller than its line)
    await page.setViewportSize({ width: 1100, height: 720 })
    const strips = page.locator('.look-strip')
    await expect(strips).toHaveCount(5)
    const spill = await strips.evaluateAll((els) =>
      els.flatMap((el) => {
        const s = el.getBoundingClientRect()
        const w = el.querySelector('.sub-sample')!.getBoundingClientRect()
        const out = Math.max(s.left - w.left, w.right - s.right, s.top - w.top, w.bottom - s.bottom)
        return out > 0 ? [`${el.closest('[data-key]')?.getAttribute('data-key')}: ${out.toFixed(1)} px out`] : []
      })
    )
    expect(spill).toEqual([])
  } finally {
    await app.close()
  }
})
