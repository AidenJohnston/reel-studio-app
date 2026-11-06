// Footage folders (tracker media-drive, smart-indexing): Library › Videos adds a folder of videos, shows the index
// reading it file by file, reads a video copied in later, says when the drive is unplugged and keeps its count, and
// Remove leaves the videos where they are. The stand-in engine counts files instead of listening (dev/fake-engine
// cmd_footage); REELSTUDIO_TEST_INDEX=1 lets the index run under test.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, root, shot } from './helpers'

async function answerFolderPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, folder)
}

test('a footage folder is read where it is, watched, survives an unplugged drive and is removed cleanly', async () => {
  test.setTimeout(240_000)
  const media = makeMedia()
  const drive = join(BASE, 'Card ü', 'Shoots')
  mkdirSync(join(drive, 'day 1'), { recursive: true })
  mkdirSync(join(drive, '.thumbs'), { recursive: true })
  for (const name of ['day 1/a.mp4', 'day 1/b.mp4', 'c.mov', '.thumbs/skip.mp4']) copyFileSync(media.video, join(drive, name))
  const { app, page } = await launch({ REELSTUDIO_TEST_INDEX: '1', FAKE_ENGINE_INDEX_STEP: '1' })
  await passFirstRun(page)

  await page.getByTestId('nav-library').click()
  await page.getByTestId('library-tab-videos').click()
  const folders = page.getByTestId('footage-folders')
  await expect(folders).toContainText('Nothing is copied until a clip is used.')
  await expect(page.getByTestId('footage-folder')).toHaveCount(0)

  // a folder that holds Reel Studio's own would read its projects and finished reels as footage
  await answerFolderPicker(app, dirname(root()))
  await page.getByTestId('footage-add').click()
  await expect(page.getByTestId('library-result')).toHaveText('That folder holds your Reel Studio folder. Choose the folder your videos are in.')
  await expect(page.getByTestId('footage-folder')).toHaveCount(0)

  // ---- added: read file by file, then counted; hidden folders are skipped, nothing is copied ----
  await answerFolderPicker(app, drive)
  await page.getByTestId('footage-add').click()
  const row = page.getByTestId('footage-folder')
  await expect(row).toHaveCount(1)
  // fails if the refusal stays on screen over a folder that was added
  await expect(page.getByTestId('library-result')).toHaveCount(0)
  await expect(row).toContainText('Shoots')
  const reading = page.getByTestId('footage-index')
  await expect(reading).toContainText(/Reading .+ \(\d+ of \d+\)/)
  await expect(reading.getByRole('progressbar', { name: 'Reading your videos' })).toBeVisible()
  await shot(page, 'footage-reading')
  await expect(row).toContainText('3 videos', { timeout: 30_000 })
  await expect(reading).toHaveCount(0)
  expect(existsSync(join(root(), 'Library', 'B-roll', 'a.mp4'))).toBe(false)
  await shot(page, 'footage-read')

  // ---- a video copied in later is read without asking ----
  copyFileSync(media.video, join(drive, 'day 1', 'd.mp4'))
  await expect(row).toContainText('4 videos', { timeout: 60_000 })

  // ---- the drive is unplugged: still listed, with its count, and back when it returns ----
  const away = join(BASE, 'Card ü', 'Shoots (unplugged)')
  renameSync(drive, away)
  await expect(row).toContainText('Not plugged in. Its 4 videos come back when it is.', { timeout: 30_000 })
  await expect(row).toHaveClass(/away/)
  await shot(page, 'footage-unplugged')
  renameSync(away, drive)
  await expect(row).toContainText('4 videos', { timeout: 60_000 })
  await expect(row).not.toHaveClass(/away/)

  // ---- Remove: gone from Reel Studio, the videos stay where they are ----
  await row.getByRole('button', { name: 'Remove Shoots' }).click()
  await expect(page.getByTestId('footage-folder')).toHaveCount(0)
  await expect(page.getByTestId('library-result')).toHaveText('Removed Shoots. Its videos stay where they are.')
  expect(existsSync(join(drive, 'day 1', 'a.mp4'))).toBe(true)
  // and it stays removed across a restart
  await app.close()
  const again = await launch({ REELSTUDIO_TEST_INDEX: '1' })
  await again.page.getByTestId('nav-library').click()
  await again.page.getByTestId('library-tab-videos').click()
  await expect(again.page.getByTestId('footage-folders')).toBeVisible()
  await expect(again.page.getByTestId('footage-folder')).toHaveCount(0)
  await again.app.close()
})
