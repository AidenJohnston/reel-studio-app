// Share › Other platforms: Stop ends an export quietly. Nothing is written, no "Stopped." appears anywhere, and Save
// is back. With no editor connected, Try 2 is the app's cover pick and nobody says "I".
import { test, expect, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, launch, makeMedia, passFirstRun } from './helpers'

/** A reel whose only version is `kind`: a preview (exporting makes the full-quality version first) or Version 1. */
function reelWith(kind: 'preview' | 'v1', video: string): void {
  const project = join(root(), 'Projects', 'my-reel')
  const dir = join(project, 'versions', kind === 'preview' ? 'preview' : 'v1')
  mkdirSync(join(project, 'media'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  copyFileSync(video, join(project, 'media', 'take.mp4'))
  copyFileSync(video, join(dir, kind === 'preview' ? 'draft.mp4' : 'export.mp4'))
  if (kind === 'v1') writeFileSync(join(dir, 'render.json'), JSON.stringify({ duration: 12, segmentsDetail: [{ source: 's1', src_start: 0, src_end: 12, out_start: 0 }] }))
  const now = new Date().toISOString()
  const p = {
    schemaVersion: 1, id: `stop-${kind}`, title: 'My reel', slug: 'my-reel', createdAt: now, updatedAt: now, version: kind === 'v1' ? 1 : 0,
    format: { width: 1080, height: 1920, fps: 30 }, sources: [{ id: 's1', path: 'media/take.mp4', duration: 12 }],
    post: { caption: 'A caption', hashtags: [], keywords: [] }
  }
  writeFileSync(join(project, 'project.json'), JSON.stringify(p))
  if (kind === 'v1') writeFileSync(join(dir, 'project.json'), JSON.stringify(p))
  writeFileSync(join(project, 'app.json'), JSON.stringify({ chat: [], job: null, status: 'ready', lastError: null }))
}

async function openPlatforms(page: Page) {
  await page.reload()
  // the whole card is one button, which covers its title
  await page.getByRole('button', { name: /^My reel,/ }).click()
  await page.getByTestId('share').click()
  await page.getByTestId('share-platforms-toggle').click()
  return page.getByTestId('share-platforms')
}

async function stopsQuietly(page: Page, platforms: ReturnType<Page['getByTestId']>) {
  await platforms.getByRole('button', { name: 'Stop' }).click()
  await expect(platforms.getByTestId('export-selected')).toBeEnabled()
  await expect(platforms.locator('.sp-fail')).toHaveCount(0)
  await expect(page.getByText(/Stopped/)).toHaveCount(0)
  const exports = join(root(), 'Library', 'Exports')
  expect(existsSync(exports) ? readdirSync(exports).filter((n) => !n.startsWith('.')) : []).toEqual([])
}

test('fails if Stop during a two-platform export leaves files, says "Stopped.", or keeps Save away', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ FAKE_ENGINE_SLOW_EXPORT: '30' })
  try {
    // after the first run, which leaves Reels empty (helpers.ts passFirstRun removes every reel)
    await passFirstRun(page)
    reelWith('v1', media.video)
    const platforms = await openPlatforms(page)
    await expect(platforms.getByRole('checkbox', { name: 'Instagram Reels' })).toBeChecked()

    // No editor: the app picks the cover, and nothing on the section speaks as "I".
    await expect(platforms.getByTestId('try-two-proposal')).toHaveText(/^Try 2: the same reel, with the 0:0\d frame as its cover\.$/)
    await expect(platforms.getByRole('radiogroup', { name: 'What Try 2 changes' })).toHaveCount(0)
    await expect(platforms.getByTestId('try-two')).not.toContainText(/\bI\b/)

    await platforms.getByRole('checkbox', { name: 'TikTok' }).check()
    await expect(platforms.getByTestId('edges-warning')).toHaveText('TikTok puts buttons near the edges that can cover subtitles. Check them before you post.')
    await platforms.getByTestId('export-selected').click()
    await expect(platforms.getByText(/^Saving for 2 platforms · \d+%$/)).toBeVisible()
    await stopsQuietly(page, platforms)
  } finally {
    await app.close()
  }
})

test('fails if Stop while a preview is made full quality for a platform export says "Stopped."', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ FAKE_ENGINE_SLOW_RENDER: '30' })
  try {
    await passFirstRun(page)
    reelWith('preview', media.video)
    const platforms = await openPlatforms(page)
    await platforms.getByRole('checkbox', { name: 'TikTok' }).check()
    await platforms.getByTestId('export-selected').click()
    await stopsQuietly(page, platforms)
  } finally {
    await app.close()
  }
})
