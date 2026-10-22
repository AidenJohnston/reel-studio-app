import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

const media = makeMedia()
function profile() {
  const dir = mkdtempSync(join(BASE, 'intake-'))
  return { REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'data') }
}

for (const source of ['paste', 'open-file before ready', 'second-instance argv']) {
  test(`fails if ${source} does not start a reel`, async () => {
    const { app, page } = await launch({ ...profile(), ...(source === 'open-file before ready' ? { RS_E2E_OPEN_FILE: media.video } : {}) })
    try {
      if (source === 'open-file before ready') {
        await expect(page.getByTestId('get-started')).toBeVisible()
        expect(await page.evaluate(() => window.reel.projects.list())).toEqual([])
        await page.getByTestId('get-started').click()
        const next = page.getByTestId('model-next')
        await expect(next.or(page.getByTestId('download-model'))).toBeVisible()
        await ((await next.isVisible()) ? next : page.getByTestId('later')).click()
        await page.getByTestId('skip').click()
      } else await passFirstRun(page)
      if (source === 'paste') {
        await app.evaluate(async ({ clipboard, ClipboardItem }, url) => {
          const previous = await clipboard.read()
          globalThis.__intakeClipboard = await Promise.all(previous.map(async (item) => new ClipboardItem(Object.fromEntries(
            await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))
          ))))
          await clipboard.write([new ClipboardItem({ 'electron application/osclipboard;format="public.file-url"': new Blob([url]) })])
        }, pathToFileURL(media.video).href)
        await page.evaluate(() => window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true })))
      } else if (source === 'second-instance argv') {
        await app.evaluate(({ app }, file) => { app.emit('second-instance', {}, [process.execPath, '.', file], process.cwd()) }, media.video)
      }
      await expect(page.getByTestId('player')).toBeVisible({ timeout: 8000 })
      const projects = await page.evaluate(() => window.reel.projects.list())
      expect(projects).toHaveLength(1)
      expect(projects[0].title).toBe('My first take')
    } finally {
      const evidence = process.env.RS_INTAKE_EVIDENCE
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'))
        writeFileSync(join(evidence, `${source.replaceAll(' ', '-')}.png`), Buffer.from(png, 'base64'))
      }
      if (source === 'paste') await app.evaluate(async ({ clipboard }) => {
        if (globalThis.__intakeClipboard) await clipboard.write(globalThis.__intakeClipboard)
      })
      await app.close()
    }
  })
}

declare global {
  var __intakeClipboard: Electron.ClipboardItem[] | undefined
}
