import { test, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, launch, makeMedia, passFirstRun } from './helpers'

test('Stop while a preview is made full quality for a platform export ends quietly', async () => {
  const media = makeMedia()
  // A project whose only version is a preview: exporting it makes the full-quality version first.
  const project = join(ROOT, 'Projects', 'my-reel')
  mkdirSync(join(project, 'media'), { recursive: true })
  mkdirSync(join(project, 'versions', 'preview'), { recursive: true })
  copyFileSync(media.video, join(project, 'media', 'take.mp4'))
  copyFileSync(media.video, join(project, 'versions', 'preview', 'draft.mp4'))
  const now = new Date().toISOString()
  writeFileSync(join(project, 'project.json'), JSON.stringify({
    schemaVersion: 1, id: 'stop-test', title: 'My reel', slug: 'my-reel', createdAt: now, updatedAt: now, version: 0,
    format: { width: 1080, height: 1920, fps: 30 }, sources: [{ id: 's1', path: 'media/take.mp4', duration: 12 }],
    post: { caption: 'A caption', hashtags: [], keywords: [] }
  }))
  writeFileSync(join(project, 'app.json'), JSON.stringify({ chat: [], job: null, status: 'ready', lastError: null }))

  const { app, page } = await launch({ FAKE_ENGINE_SLOW_RENDER: '30' })
  try {
    await passFirstRun(page)
    await page.getByText('My reel', { exact: true }).first().click()
    await page.getByTestId('export-platforms').click()
    const dialog = page.getByTestId('platform-export-dialog')
    await dialog.getByRole('checkbox', { name: /^TikTok\b/ }).check()
    await dialog.getByRole('checkbox', { name: /I checked subtitles/ }).check()
    await dialog.getByTestId('export-selected').click()
    await dialog.getByRole('button', { name: 'Stop export' }).click()
    await expect(dialog.getByTestId('export-selected')).toBeEnabled()
    await expect(dialog.locator('.platform-errors')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
