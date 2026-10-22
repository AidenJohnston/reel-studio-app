// Windows and Linux draw the strip behind the window buttons themselves (titleBarOverlay), outside the page, so the
// modal scrim cannot dim it. Opening a modal must recolour it to the scrim, and closing the last one must restore it.
import { test, expect } from '@playwright/test'
import { launch, makeMedia, passFirstRun } from './helpers'

test('fails if the title bar strip stays undimmed while a modal is open', async () => {
  test.skip(process.platform === 'darwin', 'macOS draws traffic lights over the page, not an overlay strip.')
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const set = w.setTitleBarOverlay.bind(w)
      const g = globalThis as { __overlay?: string[] }
      g.__overlay = []
      w.setTitleBarOverlay = (o) => {
        g.__overlay!.push(String(o.color))
        set(o)
      }
    })
    const overlay = () => app.evaluate(() => (globalThis as { __overlay?: string[] }).__overlay ?? [])
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles(media.video)
    await page.getByTestId('stop').click()
    await expect(page.getByTestId('confirm')).toBeVisible()
    await expect.poll(overlay).toEqual(['#b6b4b0'])
    await page.getByTestId('confirm-no').click()
    await expect(page.getByTestId('confirm')).toHaveCount(0)
    await expect.poll(overlay).toEqual(['#b6b4b0', '#f7f5f1'])
  } finally {
    await app.close()
  }
})
