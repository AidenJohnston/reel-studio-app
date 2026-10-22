import { test, expect } from '@playwright/test'
import { launch, makeMedia, passFirstRun } from './helpers'

test('fails if player controls start file drag or picture drag-out stops working', async () => {
  const media = makeMedia()
  const { app, page } = await launch()
  const dragged = await app.evaluateHandle(({ ipcMain }) => {
    const files: string[] = []
    ipcMain.removeAllListeners('app:startDrag')
    ipcMain.on('app:startDrag', (_event, file: string) => files.push(file))
    return files
  })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles(media.video)
    const player = page.getByTestId('player')
    await expect(player).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('export')).toBeEnabled()
    await player.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 0 })
    const track = page.getByRole('slider', { name: 'Position in the video' })
    await track.hover()
    const box = await track.boundingBox()
    if (!box) throw new Error('The scrub track has no bounds')
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    expect(await dragged.evaluate((files) => files), 'scrubbing must not start a file drag').toEqual([])
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime / v.duration)).toBeGreaterThan(0.7)
    const picture = await player.boundingBox()
    if (!picture) throw new Error('The video picture has no bounds')
    await page.mouse.move(picture.x + picture.width * 0.3, picture.y + picture.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(picture.x + picture.width * 0.7, picture.y + picture.height * 0.3, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => dragged.evaluate((files) => files.length)).toBe(1)
    expect(await dragged.evaluate((files) => files[0])).toMatch(/\.mp4$/)
  } finally {
    await app.close()
  }
})
