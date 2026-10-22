// Export for other platforms with Try two versions: Try 2 goes only to a platform that can test it,
// and the Saved screen tells the creator how to run Instagram's test.
//
// Run: npx playwright test e2e/try-two-versions.spec.ts (after npm run build).
import { test, expect } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
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
  await expect(page.getByTestId('export-platforms')).toBeEnabled({ timeout: 10 * 60_000 })

  await page.getByTestId('export-platforms').click()
  const dialog = page.getByTestId('platform-export-dialog')
  for (const name of ['Instagram Reels', 'TikTok']) await dialog.getByRole('checkbox', { name: new RegExp(`^${name}`) }).check()
  await dialog.getByTestId('try-two').check()
  await expect(dialog.getByTestId('try-two-status')).toHaveText('Try 2 is the same as Try 1. Pick another version, cover or caption.')
  await dialog.locator('#platform-caption-2').fill('Open with the result')
  await dialog.getByRole('checkbox', { name: /I checked subtitles/ }).check()
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
