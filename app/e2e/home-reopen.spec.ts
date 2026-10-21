import { test, expect } from '@playwright/test'
import { launch, makeMedia, passFirstRun, shot } from './helpers'

test('Home reopens a running note or rerender on the Reel screen', async () => {
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByTestId('player')).toBeVisible()
    const detail = await page.evaluate(async () => {
      const [p] = await window.reel.projects.list()
      return window.reel.projects.get(p.slug)
    })

    for (const kind of ['note', 'rerender'] as const) {
      // Hold the job snapshot steady while navigating away and back.
      const running = {
        ...detail, status: 'working' as const,
        job: { id: 'running-change', kind, message: 'Reading your note', pct: 10, overall: 10, secondsLeft: null, overdue: false, thinking: false }
      }
      await app.evaluate(({ ipcMain }, d) => {
        ipcMain.removeHandler('projects:list')
        ipcMain.handle('projects:list', () => ({ ok: true, value: [d] }))
        ipcMain.removeHandler('projects:get')
        ipcMain.handle('projects:get', () => ({ ok: true, value: d }))
      }, running)
      await page.getByTestId('nav-home').click()
      await expect(page.getByTestId('card-status')).toHaveText('Working on it')
      await page.getByTestId('project-card').focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Your videos')
      await shot(page, `home-reopen-${kind}`)
      await expect(page.getByTestId('note-progress')).toContainText('Reading your note')
      await expect(page.getByText('Making your reel', { exact: true })).toHaveCount(0)
    }

    await app.evaluate(({ ipcMain }, d) => {
      ipcMain.removeHandler('projects:get')
      ipcMain.handle('projects:get', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return { ok: true, value: d }
      })
    }, detail)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('project-card').click()
    await page.getByTestId('new-video').click()
    await page.waitForTimeout(750)
    await expect(page.getByTestId('drop-zone')).toBeVisible()
  } finally {
    await app.close()
  }
})
