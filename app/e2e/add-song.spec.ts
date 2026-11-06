// Add Song (tracker add-song-crash): a long song carrying large cover art, added from the Library's Add files and from
// the Sound tab's own picker, lands in the Library and in the reel without the window or a helper process dying, and
// without the app stalling. The fixes it guards are the process-exit logging (main/index.ts render-process-gone) and
// bounded cover memory (engine compose_util.py). REELSTUDIO_E2E_EXE=<packaged Reel Studio.exe> runs it against a
// packaged build with its bundled engine (helpers.ts launch); a packaged run also needs REELSTUDIO_MODELS_DIR holding
// the listening model, since the reel is transcribed for real.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, makeMedia, makeReel, passFirstRun, shot, userData } from './helpers'

const MINUTES = 20

/** Songs like the one that crashed: long, high bitrate, a 3000 px cover embedded, a name with spaces and accents. */
function heavySongs(): { mp3: string; m4a: string } {
  const dir = join(BASE, 'heavy songs é')
  mkdirSync(dir, { recursive: true })
  const cover = join(dir, 'cover.png')
  const mp3 = join(dir, 'Long mix – côte.mp3')
  const m4a = join(dir, 'Long mix two.m4a')
  const seconds = String(MINUTES * 60)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3000x3000', '-frames:v', '1', cover])
  const art = ['-i', cover, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic']
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, ...art,
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '320k', '-c:v', 'mjpeg', '-id3v2_version', '3', mp3])
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, ...art,
    '-ac', '2', '-c:a', 'aac', '-b:a', '256k', '-c:v', 'mjpeg', m4a])
  return { mp3, m4a }
}

/** The native file picker cannot be driven, so answer it from the main process. */
async function answerFilePicker(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, file)
}

/** Lines in main.log that say a process died or the window stopped answering. */
function deaths(): string[] {
  const file = join(userData(), 'logs', 'main.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => /\[(render-process-gone|unresponsive)\]|\[child-process-gone\](?!.*reason=clean-exit)/.test(l))
}

test('Add Song: a long song with big cover art, from the Library and the Sound tab', async () => {
  test.setTimeout(30 * 60_000)
  const songs = heavySongs()
  const media = makeMedia()
  const timings: Record<string, number> = {}
  const { app, page } = await launch()
  await passFirstRun(page)

  // ---- Library: Add files with both songs ----
  await page.getByTestId('nav-library').click()
  await page.getByTestId('library-tab-music').click()
  let t0 = Date.now()
  await page.getByTestId('file-input').setInputFiles([songs.mp3, songs.m4a])
  await expect(page.getByTestId('library-result')).toHaveText('Added 2 songs to your Library.', { timeout: 120_000 })
  timings.libraryAddMs = Date.now() - t0
  const rows = page.getByTestId('library-sound')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'Long mix – côte' }).locator('.lib-dur')).toHaveText(`${MINUTES}:00`, { timeout: 60_000 })
  await expect(rows.filter({ hasText: 'Long mix two' }).locator('.lib-wave svg').first()).toBeVisible({ timeout: 60_000 })
  timings.libraryPreviewMs = Date.now() - t0
  await shot(page, 'add-song-library')

  // ---- the Sound tab's own picker, on a reel ----
  await makeReel(page, media.video, 15 * 60_000)
  await page.getByRole('button', { name: 'Edit it myself' }).click()
  await page.getByRole('tab', { name: 'Sound' }).click()
  // the same file from where it was: a second copy lands in the Library under the next free name and is the reel's song
  await answerFilePicker(app, songs.mp3)
  t0 = Date.now()
  await page.getByTestId('music-add').click()
  await expect(page.getByRole('slider', { name: 'Music fade-in' })).toBeVisible({ timeout: 120_000 })
  timings.soundTabAddMs = Date.now() - t0
  await expect(page.getByRole('radio', { name: 'Long mix – côte (2)' })).toBeChecked()
  await shot(page, 'add-song-sound-tab')

  // the window is still the app's, and nothing died along the way
  await expect(page.getByTestId('nav-library')).toBeVisible()
  expect(deaths()).toEqual([])
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'add-song-timings.json'), JSON.stringify({ packaged: !!process.env.REELSTUDIO_E2E_EXE, minutes: MINUTES, ...timings }, null, 2))
  await app.close()
})
