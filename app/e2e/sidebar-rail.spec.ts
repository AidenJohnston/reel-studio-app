// The sidebar by the window's width (Sidebar.tsx useRail): narrower than 1200 px it starts as its icon rail, wider it is
// open, until the person folds or opens it themselves; that choice then wins at every width and after a restart.
import { test, expect } from '@playwright/test'
import { launch, passFirstRun } from './helpers'

test('fails if a narrow window opens the full sidebar, the rail loses its names, or the person\'s own fold does not win', async () => {
  const { app, page } = await launch({}, { realViewport: true })
  const size = (w: number, h: number) =>
    app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h })
  try {
    await passFirstRun(page)
    const toggle = page.getByTestId('sidebar-toggle')

    await size(1100, 720)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // the first run ends on a New reel, which Recent does not list (and the rail hides Recent): Reels is the row marked
    await expect(page.getByTestId('nav-home')).toHaveAttribute('aria-current', 'page')
    // on the rail every screen keeps its accessible name, and the one on screen stays marked
    await page.getByRole('button', { name: 'Library' }).click()
    await expect(page.getByTestId('nav-library')).toHaveAttribute('aria-current', 'page')

    await size(1280, 820)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // folded by hand at a wide window: it stays folded wider and narrower, and after a reload
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await size(1100, 720)
    await size(1280, 820)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.reload()
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')

    // opened by hand at a narrow window: it stays open there
    await size(1100, 720)
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true')
    await size(1150, 740)
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await app.close()
  }
})
