import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

test.skip(process.platform !== 'darwin', 'The fake drive folders follow the macOS layout; the native Windows flow runs on a Windows host.')

async function launchWithHome() {
  const dir = mkdtempSync(join(BASE, 'cloud-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  const { app, page } = await launch({ REELSTUDIO_PHONE_HOST: '127.0.0.1', REELSTUDIO_USER_DATA: join(dir, 'data'), REELSTUDIO_ROOT: join(dir, 'Reel Studio') })
  await app.evaluate(({ app }, folder) => app.setPath('home', folder), home)
  return { app, page, home, iCloud: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') }
}

/** Exports a reel and returns the exported file. */
async function exportReel(page: Page): Promise<string> {
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([makeMedia().video])
  await expect(page.getByTestId('player')).toBeVisible()
  await page.getByTestId('export').click()
  await expect(page.getByTestId('export-saved')).toBeVisible()
  const file = await page.getByTestId('export-name').getAttribute('title')
  if (!file) throw new Error('The export dialog has no video path')
  return file
}

async function openCloudWay(page: Page) {
  await page.getByTestId('send-to-phone').click()
  await page.getByTestId('phone-cant').click()
  return page.getByTestId('phone-cloud')
}

test('fails if the drive way loses its web links, saves the wrong export or to the wrong drive, or crowds the export dialog', async () => {
  const { app, page, home, iCloud } = await launchWithHome()
  try {
    const exported = await exportReel(page)

    // No drive app on this computer: the drive websites are still offered.
    let cloud = await openCloudWay(page)
    await expect(cloud.getByTestId('phone-icloud')).toHaveAttribute('href', 'https://www.icloud.com/iclouddrive/')
    await expect(cloud.getByTestId('phone-gdrive')).toHaveAttribute('href', 'https://drive.google.com/drive/my-drive')
    await expect(cloud.getByRole('button', { name: /^Save to / })).toHaveCount(0)

    mkdirSync(iCloud, { recursive: true })
    const personal = join(home, 'Library', 'CloudStorage', 'GoogleDrive-zoe.m@example.com', 'My Drive')
    const work = join(home, 'Library', 'CloudStorage', 'GoogleDrive-studio@example.org', 'My Drive')
    mkdirSync(personal, { recursive: true })
    mkdirSync(work, { recursive: true })
    // The export dialog keeps one obvious next action: the drive buttons live only in the phone fallbacks.
    await page.getByTestId('phone-back').click()
    await expect(page.getByTestId('send-to-phone')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Save to / })).toHaveCount(0)
    cloud = await openCloudWay(page)
    await expect(cloud.getByRole('button', { name: /^Save to / })).toHaveText(['Save to iCloud Drive', 'Save to Google Drive (studio)', 'Save to Google Drive (zoe.m)'])
    await expect(cloud.getByTestId('phone-icloud')).toHaveCount(0)

    await cloud.getByRole('button', { name: 'Save to iCloud Drive', exact: true }).focus()
    await page.keyboard.press('Enter')
    const status = cloud.getByTestId('cloud-status')
    await expect(status).toContainText('Saved to iCloud Drive. It shows up on your phone once your drive finishes syncing.')
    await expect(status).toContainText('Files app, then iCloud Drive › Reel Studio')
    const saved = readdirSync(join(iCloud, 'Reel Studio'))
    expect(saved).toEqual([basename(exported)])
    expect(readFileSync(join(iCloud, 'Reel Studio', saved[0]))).toEqual(readFileSync(exported))

    await cloud.getByRole('button', { name: 'Save to Google Drive (studio)', exact: true }).click()
    await expect(status).toContainText('Saved to Google Drive (studio).')
    await expect(status).toContainText('Drive app')
    const workFiles = readdirSync(join(work, 'Reel Studio'))
    expect(workFiles).toHaveLength(1)
    expect(readFileSync(join(work, 'Reel Studio', workFiles[0]))).toEqual(readFileSync(exported))
    expect(readdirSync(personal)).toEqual([])
  } finally {
    await app.close()
  }
})

test('fails if quitting during a save leaves an empty or temporary file in the drive', async () => {
  const { app, page, iCloud } = await launchWithHome()
  mkdirSync(iCloud, { recursive: true })
  const folder = join(iCloud, 'Reel Studio')
  try {
    const exported = await exportReel(page)
    // A slow drive: the copy finishes, then the drive takes a while to report it.
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs')
      const copyFile = fs.promises.copyFile
      fs.promises.copyFile = async (...args: Parameters<typeof copyFile>) => {
        await copyFile(...args)
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    })
    await openCloudWay(page)
    await page.getByRole('button', { name: 'Save to iCloud Drive', exact: true }).click()
    await expect.poll(() => existsSync(folder) && readdirSync(folder).some((name) => name.endsWith('.tmp'))).toBe(true)
    await app.close()
    const left = readdirSync(folder)
    expect(left.filter((name) => name.endsWith('.tmp'))).toEqual([])
    for (const name of left) expect(readFileSync(join(folder, name))).toEqual(readFileSync(exported))
  } finally {
    await app.close().catch(() => {})
  }
})
