import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_DIR, BASE, ROOT, launch } from './helpers'

test('fails if another window can delete a project or malformed arguments can change it', async () => {
  const { app, page } = await launch({ REELENGINE_CACHE: join(BASE, 'engine-cache') })
  const dir = join(ROOT, 'Projects', 'protected')
  mkdirSync(dir, { recursive: true })
  const project = { schemaVersion: 1, id: 'protected', slug: 'protected', title: 'Keep me', version: 1 }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
  try {
    expect(await page.evaluate(() => window.reel.projects.list())).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'protected' })]))
    const attack = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const attacker = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
      try {
        await attacker.loadURL('about:blank')
        return await attacker.webContents.executeJavaScript(`window.reel.projects.remove('protected').then(() => 'accepted', e => e.code)`)
      } finally {
        attacker.destroy()
      }
    }, join(APP_DIR, 'out', 'preload', 'index.js'))
    expect(attack).toBe('FORBIDDEN')
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))).toEqual(project)
    const malformed = await page.evaluate(async () => {
      // @ts-expect-error IPC callers can send values outside the preload's TypeScript contract.
      return window.reel.projects.update('protected', { music: { enabled: true, track: ['outside.mp3'] } })
        .then(() => 'accepted', (e: { code: string }) => e.code)
    })
    expect(malformed).toBe('BAD_ARGS')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadURL('about:blank'))
    const wrongOrigin = await page.evaluate(() => window.reel.projects.remove('protected').then(() => 'accepted', (e: { code: string }) => e.code))
    expect(wrongOrigin).toBe('FORBIDDEN')
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))).toEqual(project)
  } finally {
    await app.close()
    rmSync(BASE, { recursive: true, force: true })
  }
})
