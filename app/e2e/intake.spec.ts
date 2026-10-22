import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_DIR, BASE, launch, makeMedia, passFirstRun } from './helpers'

const media = makeMedia()
function profile() {
  const dir = mkdtempSync(join(BASE, 'intake-'))
  return { REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'data') }
}

for (const source of ['paste', 'open-file before ready', 'second-instance argv']) {
  test(`fails if ${source} does not start a reel`, async () => {
    const env = profile()
    let opened
    if (source === 'open-file before ready') {
      const bootstrap = join(BASE, 'open-file.cjs')
      writeFileSync(bootstrap, `
        const { app } = require('electron')
        app.on('will-finish-launching', () => {
          if (app.isReady()) throw new Error('Expected open-file before ready')
          app.emit('open-file', { preventDefault() {} }, ${JSON.stringify(media.video)})
        })
      `)
      const launchEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) launchEnv[key] = value
      Object.assign(launchEnv, env, { REELSTUDIO_TEST: '1', REELSTUDIO_MOCK_AI: '1',
        REELSTUDIO_ENGINE_DIR: join(APP_DIR, 'dev', 'fake-engine'),
        REELSTUDIO_MODELS_DIR: join(BASE, 'models'), FAKE_ENGINE_SLOW: '3'
      })
      delete launchEnv.ELECTRON_RUN_AS_NODE
      const app = await electron.launch({ args: ['-r', bootstrap, APP_DIR], cwd: APP_DIR, env: launchEnv })
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1280, height: 820 })
      opened = { app, page }
    } else opened = await launch(env)
    const { app, page } = opened
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
