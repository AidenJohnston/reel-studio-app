import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

const media = makeMedia()
function profile() {
  const dir = mkdtempSync(join(BASE, 'intake-window-'))
  return { REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'data') }
}

test('fails if open-file after closing the macOS window does not reopen it and start a reel', async () => {
  test.skip(process.platform !== 'darwin', 'macOS keeps running after its last window closes')
  const { app, page } = await launch(profile())
  try {
    await passFirstRun(page)
    const original = await app.browserWindow(page)
    const originalId = await original.evaluate((win) => win.id)
    const closed = page.waitForEvent('close')
    await original.evaluate((win) => win.close())
    await closed
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.webContents.isOffscreen()).length)).toBe(0)

    const reopened = app.waitForEvent('window', { timeout: 8000 })
    await app.evaluate(({ app }, file) => { app.emit('open-file', { preventDefault() {} }, file) }, media.video)
    const nextPage = await reopened
    const nextWindow = await app.browserWindow(nextPage)
    expect(await nextWindow.evaluate((win) => win.id)).not.toBe(originalId)
    await expect(nextPage.getByTestId('player')).toBeVisible({ timeout: 8000 })
    const projects = await nextPage.evaluate(() => window.reel.projects.list())
    expect(projects).toHaveLength(1)
    expect(projects[0].title).toBe('My first take')
    expect(await nextPage.evaluate(() => window.reel.app.takeOpenFiles())).toEqual([])
  } finally {
    await app.close()
  }
})

test('fails if open-file does not request restore and focus for a minimized window', async () => {
  const { app, page } = await launch(profile())
  try {
    await passFirstRun(page)
    // Observe the window API requests without letting this test show or focus a native window.
    // This checks intake dispatch, not whether the operating system grants focus.
    const calls = await app.evaluate(({ app, BrowserWindow }, file) => {
      const win = BrowserWindow.getAllWindows().find((window) => !window.webContents.isOffscreen())!
      const calls: string[] = []
      win.isMinimized = () => true
      win.restore = () => { calls.push('restore') }
      win.show = () => { calls.push('show') }
      win.focus = () => { calls.push('focus') }
      app.emit('open-file', { preventDefault() {} }, file)
      return calls
    }, media.video)
    expect(calls).toContain('restore')
    expect(calls).toContain('focus')
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 8000 })
    const projects = await page.evaluate(() => window.reel.projects.list())
    expect(projects).toHaveLength(1)
    expect(projects[0].title).toBe('My first take')
  } finally {
    await app.close()
  }
})
