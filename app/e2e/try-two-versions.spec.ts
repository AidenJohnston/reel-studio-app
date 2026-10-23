// Export for other platforms with Try two versions: Try 2 goes only to a platform that can test it,
// and the Saved screen tells the creator how to run Instagram's test.
//
// Run: npx playwright test e2e/try-two-versions.spec.ts (after npm run build).
import { test, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

const MINE = mkdtempSync(join(BASE, 'tries-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

test('fails if the Saved screen leaves out Instagram\'s Trial steps or offers Try 2 to TikTok', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('export-more')).toBeEnabled({ timeout: 10 * 60_000 })

  await page.getByTestId('export-more').click()
  await page.getByRole('menuitem', { name: 'Other platforms…' }).click()
  const dialog = page.getByTestId('platform-export-dialog')
  for (const name of ['Instagram Reels', 'TikTok']) await dialog.getByRole('checkbox', { name: new RegExp(`^${name}`) }).check()
  await dialog.getByTestId('try-two').check()
  await expect(dialog.getByTestId('try-two-status')).toHaveText('Try 2 is the same as Try 1. Pick another version, cover or caption.')
  await dialog.locator('#platform-caption-2').fill('Open with the result')
  await dialog.getByTestId('export-selected').click()

  await expect(dialog.getByTestId('export-saved')).toBeVisible({ timeout: 120_000 })
  const instagram = dialog.getByTestId('export-platform').filter({ hasText: 'Instagram Reels' })
  await expect(instagram).toContainText('Before you share, turn on Trial and leave automatic sharing off.')
  await expect(instagram).toContainText('Both use the same video.')
  await expect(instagram.getByTestId('export-name')).toHaveCount(2)
  await expect(dialog.getByTestId('export-platform').filter({ hasText: 'TikTok' }).getByTestId('export-name')).toHaveCount(1)
  await expect(dialog.getByTestId('export-first-only')).toContainText('TikTok gets Try 1 only.')

  const saved = readdirSync(join(ROOT, 'Library', 'Exports'))
  expect(saved.filter((name) => name.includes('Try 2')).sort()).toEqual([expect.stringMatching(/Instagram Reels - Try 2 caption\.txt$/), expect.stringMatching(/Instagram Reels - Try 2 cover\.jpg$/)])
  expect(saved.filter((name) => name.endsWith('.mp4'))).toHaveLength(2)
  const [caption] = saved.filter((name) => name.endsWith('Instagram Reels - Try 2 caption.txt'))
  expect(readFileSync(join(ROOT, 'Library', 'Exports', caption), 'utf8')).toBe('Open with the result\n')
  await app.close()
})

test('fails if clicking Try 2\'s chosen version again leaves Export disabled or drops the frame picked for its cover', async () => {
  const media = makeMedia()
  const mine = mkdtempSync(join(BASE, 'tries-again-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  const project = join(root, 'Projects', 'two-versions')
  for (const n of [1, 2]) {
    mkdirSync(join(project, 'versions', `v${n}`), { recursive: true })
    copyFileSync(media.video, join(project, 'versions', `v${n}`, 'export.mp4'))
  }
  const now = new Date().toISOString()
  writeFileSync(join(project, 'project.json'), JSON.stringify({
    schemaVersion: 1, id: 'two-versions', title: 'Two versions', slug: 'two-versions', createdAt: now, updatedAt: now, version: 2,
    format: { width: 1080, height: 1920, fps: 30 }, sources: [], post: { caption: 'A caption', hashtags: [], keywords: [] }
  }))
  writeFileSync(join(project, 'app.json'), JSON.stringify({ chat: [], job: null, status: 'ready', lastError: null }))

  const { app, page } = await launch({ REELSTUDIO_ROOT: root, REELSTUDIO_USER_DATA: join(mine, 'user data') })
  try {
    await passFirstRun(page)
    await page.getByText('Two versions', { exact: true }).first().click()
    await page.getByTestId('export-more').click()
    await page.getByRole('menuitem', { name: 'Other platforms…' }).click()
    const dialog = page.getByTestId('platform-export-dialog')
    await dialog.getByRole('checkbox', { name: /^Instagram Reels/ }).check()
    await dialog.getByTestId('try-two').check()
    const panel = dialog.getByTestId('try-two-panel')
    await panel.getByRole('radio', { name: 'Version 1' }).click()
    await expect(dialog.getByTestId('export-selected')).toBeEnabled()
    await panel.getByLabel('Try 2 cover frame').evaluate((video: HTMLVideoElement) => { video.currentTime = 1 })
    await expect(panel.getByTestId('try-two-cover-choice')).toContainText('The frame at')
    const picked = await panel.getByTestId('try-two-cover-choice').textContent()

    await panel.getByRole('radio', { name: 'Version 1' }).click()
    await expect(panel.getByTestId('try-two-cover-choice')).toHaveText(picked!)
    await expect(dialog.getByTestId('export-selected')).toBeEnabled()
  } finally {
    await app.close()
  }
})
