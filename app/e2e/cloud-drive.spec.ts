import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

test('fails if cloud save copies the wrong export or uses the wrong drive', async () => {
  test.skip(process.platform !== 'darwin', 'The native Windows flow runs on a Windows host.')
  const dir = mkdtempSync(join(BASE, 'cloud-'))
  const home = join(dir, 'home')
  const drive = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  mkdirSync(drive, { recursive: true })
  const personal = join(home, 'Library', 'CloudStorage', 'GoogleDrive-Personal', 'My Drive')
  const work = join(home, 'Library', 'CloudStorage', 'GoogleDrive-Work', 'My Drive')
  mkdirSync(personal, { recursive: true })
  mkdirSync(work, { recursive: true })
  const media = makeMedia()
  const { app, page } = await launch({ RS_E2E_HOME: home, REELSTUDIO_PHONE_HOST: '127.0.0.1', REELSTUDIO_USER_DATA: join(dir, 'data'), REELSTUDIO_ROOT: join(dir, 'Reel Studio') })
  const capture = async (name: string) => {
    const evidence = process.env.RS_CLOUD_EVIDENCE
    if (!evidence) return
    mkdirSync(evidence, { recursive: true })
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'))
    writeFileSync(join(evidence, `${name}.png`), Buffer.from(png, 'base64'))
  }
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByTestId('player')).toBeVisible()
    await page.getByTestId('export').click()
    await expect(page.getByTestId('export-saved')).toBeVisible()
    await capture('export')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('send-to-phone').click()
    await page.getByTestId('phone-cant').click()
    await page.locator('.phone-fallbacks .phone-way').nth(1).scrollIntoViewIfNeeded()
    await capture('phone-fallback')
    await page.getByTestId('phone-back').click()
    const save = page.getByRole('button', { name: 'Save to iCloud Drive', exact: true })
    await expect(save).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('button', { name: 'Save to Google Drive (Personal)', exact: true })).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('button', { name: 'Save to Google Drive (Work)', exact: true })).toBeVisible({ timeout: 5000 })
    await save.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status')).toContainText('Saved to iCloud Drive')
    const saved = join(drive, 'Reel Studio')
    const files = readdirSync(saved)
    expect(files).toHaveLength(1)
    const exportFile = await page.getByTestId('export-name').getAttribute('title')
    if (!exportFile) throw new Error('The export dialog has no video path')
    expect(readFileSync(join(saved, files[0]))).toEqual(readFileSync(exportFile))
    await capture('saved')
    await page.getByRole('button', { name: 'Show in Finder', exact: true }).last().focus()
    await page.keyboard.press('Enter')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Save to Google Drive (Work)', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status')).toContainText('Saved to Google Drive (Work)')
    const workFiles = readdirSync(join(work, 'Reel Studio'))
    expect(workFiles).toHaveLength(1)
    expect(readFileSync(join(work, 'Reel Studio', workFiles[0]))).toEqual(readFileSync(exportFile))
    expect(readdirSync(personal)).toEqual([])
    await capture('saved-wide')
  } finally {
    await app.close()
  }
})
