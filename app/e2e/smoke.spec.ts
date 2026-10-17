// End-to-end smoke test: launches the built app, goes through first run, makes a video from a real
// file, reaches the Reel screen, tries every screen, exports, and survives a quit mid-job.
//
// Run: npm run e2e (builds first). Env:
//   REELSTUDIO_E2E_VIDEO   the raw take to use (default: a generated clip)
//   REELSTUDIO_ENGINE_DIR  a real engine to test against (default: the stand-in in dev/fake-engine)
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, ROOT, SHOTS, dropFiles, launch, makeMedia, passFirstRun, shot } from './helpers'

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
  for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(join(SHOTS, f))
})

test('make a reel end to end', async () => {
  const media = makeMedia()
  let { app, page } = await launch()

  // ---- first run ----
  await expect(page.getByText('Welcome to Reel Studio')).toBeVisible()
  await shot(page, '01-firstrun-welcome')
  await page.getByTestId('get-started').click()
  // "One download" before the model is here, "Ready to listen" once it is (grandma3 #1).
  await expect(page.getByTestId('model-heading')).toHaveText(/One download, about 500 MB|Ready to listen/)
  await expect(page.getByTestId('model-next').or(page.getByTestId('download-model'))).toBeVisible()
  if (await page.getByTestId('model-next').isVisible()) await expect(page.getByTestId('model-heading')).toHaveText('Ready to listen')
  await shot(page, '02-firstrun-model')
  // Use an installed model if there is one; else "download" (instant with the stand-in engine).
  const next = page.getByTestId('model-next')
  const download = page.getByTestId('download-model')
  await expect(next.or(download)).toBeVisible()
  if (await next.isVisible()) await next.click()
  else await download.click()
  await expect(page.getByText('Connect your AI editor')).toBeVisible()
  await shot(page, '03-firstrun-connect')
  await page.getByTestId('skip').click()

  // ---- home ----
  await expect(page.getByText('Make your first reel')).toBeVisible()
  await shot(page, '04-home-empty')

  // ---- library: add a song, a picture and a file it cannot use ----
  await page.getByTestId('nav-library').click()
  await page.getByTestId('file-input').setInputFiles([media.song, media.picture, media.doc])
  // Said on the Library screen itself, in plain words (critique 1.12).
  await expect(page.getByTestId('library-result')).toHaveText('Added 1 song and 1 picture to your Library. Skipped notes.txt (not a video, song or picture).')
  await expect(page.getByTestId('bin-music').getByText('happy song.mp3')).toBeVisible()
  await shot(page, '05-library')

  // ---- new video: a non-video file is explained, not swallowed ----
  await page.getByTestId('nav-home').click()
  await page.getByTestId('new-video').click()
  await expect(page.getByText('Drop your video here')).toBeVisible()
  await shot(page, '06-new-video')
  await page.getByTestId('file-input').setInputFiles([media.doc])
  // Inline, under the drop zone; never a toast that follows you to the next screen (critique 1.1).
  await expect(page.getByTestId('new-error')).toContainText('Drop a video file')
  await expect(page.getByTestId('toast')).toHaveCount(0)

  // ---- the real file ----
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByText('Making your reel')).toBeVisible()
  await expect(page.getByTestId('new-error')).toHaveCount(0)
  await expect(page.getByTestId('status-message')).toContainText(/Listening|Copying|Getting/)
  await expect(page.getByTestId('time-left')).toBeVisible()
  await expect(page.getByTestId('working-frame')).toBeVisible({ timeout: 60_000 })
  await shot(page, '07-working')
  // Dock / taskbar progress follows the job (main process; notifications are not shown in tests).
  const fb = await app.evaluate(() => (globalThis as any).__reelFeedback)
  expect(fb.progress.length).toBeGreaterThan(0)

  // ---- reel ----
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
  await expect(page.getByTestId('what-i-did')).toContainText('Added music')
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && v.readyState >= 2 && v.videoWidth > 0
  })
  await shot(page, '08-reel')
  const aiSource = await page.evaluate(() => window.reel.app.info().then((i) => i.ai))

  // "What I did" never claims AI work the no-AI path did not do (grandma test 7 + 12).
  if (aiSource === 'mock') {
    await expect(page.getByTestId('did-cut')).toContainText('Cut the pauses and repeated starts')
    await expect(page.getByTestId('extras')).toContainText('Write a post caption')
    await expect(page.getByTestId('what-i-did')).not.toContainText('best takes')
  }
  // The native player's menu (download, speed, picture-in-picture) is gone.
  expect(await page.getByTestId('player').getAttribute('controls')).toBeNull()
  expect(await page.getByTestId('player').getAttribute('disablepictureinpicture')).not.toBeNull()

  // ---- edit it myself (was "Show me how") ----
  await page.getByTestId('edit-myself').click()
  await expect(page.getByTestId('drawer')).toBeVisible()
  await shot(page, '09-drawer-cut')
  // Restore a struck word if there is one, else cut the first word: either way the cut changes.
  const struck = page.locator('.word.cut').first()
  if (await struck.count()) await struck.click()
  else await page.locator('.word').first().click()
  for (const t of ['captions', 'music', 'broll', 'cover', 'post']) {
    await page.getByTestId(`tab-${t}`).click()
    if (t === 'captions') await expect(page.getByTestId('sub-preview')).toBeVisible() // live preview on the phone
    await shot(page, `10-drawer-${t}`)
  }
  await expect(page.getByTestId('sub-preview')).toHaveCount(0)
  await page.getByTestId('tab-cut').click()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('versions').getByText('Version 2')).toBeVisible({ timeout: 120_000 })
  await shot(page, '11-reel-v2')

  // ---- a note with no AI connected: shown as my bubble, a plain answer, the matching button ----
  await page.getByTestId('note-input').fill('Always use big captions')
  await page.keyboard.press('Enter')
  await expect(page.locator('.bubble.you + .bubble.editor')).toBeVisible({ timeout: 120_000 })
  if (aiSource === 'mock') await expect(page.getByTestId('action-open-captions').last()).toBeVisible()
  await shot(page, '12-reel-note')

  // ---- export ----
  await page.getByTestId('export').click()
  await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 120_000 })
  await shot(page, '13-export')
  const exported = readdirSync(join(ROOT, 'Library', 'Exports'))
  expect(exported.some((f) => / - Version 2\.mp4$/.test(f))).toBe(true)
  await expect(page.getByTestId('export-name')).toContainText('- Version 2.mp4')
  expect(exported.some((f) => f.endsWith('caption.txt'))).toBe(true)
  await page.getByText('Done', { exact: true }).click()

  // ---- my style, settings, script ----
  await page.getByTestId('nav-style').click()
  await expect(page.getByText('My style', { exact: true }).first()).toBeVisible()
  await shot(page, '14-my-style')
  await page.getByTestId('nav-settings').click()
  await expect(page.getByText('Where your videos are kept')).toBeVisible()
  await shot(page, '15-settings')
  await page.getByTestId('nav-home').click()
  await page.getByTestId('new-video').click()
  await page.getByText('I want help writing a script first').click()
  await page.getByPlaceholder('What is your video about?').fill('Three tips for better sleep')
  // No AI: said before typing, and the button is off (no pink error after the fact).
  const needsAi = page.getByTestId('script-needs-ai')
  await page.waitForTimeout(300)
  if (await needsAi.isVisible()) await expect(page.getByTestId('write-script')).toBeDisabled()
  else {
    await page.getByTestId('write-script').click()
    await expect(page.locator('.banner.error').or(page.getByRole('heading', { name: 'What to say' }))).toBeVisible({ timeout: 120_000 })
  }
  await shot(page, '16-script')

  // ---- animation renderer: transparent layer ----
  const anim = join(BASE, 'anim test ü.mov')
  await page.evaluate((p) => window.reel.dev.renderTestAnimation(p), anim)
  expect(existsSync(anim)).toBe(true)
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', anim]).toString()
  )
  expect(probe.streams[0].codec_name).toBe('qtrle')
  expect(probe.streams[0].pix_fmt).toBe('argb')
  // Top-left pixel of frame 0 must be fully transparent; the card is in the middle.
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', anim, '-frames:v', '1', '-vf', 'crop=1:1:0:0,format=rgba', '-f', 'rawvideo', '-'])
  expect(px[3]).toBe(0)
  const mid = execFileSync('ffmpeg', ['-v', 'error', '-i', anim, '-frames:v', '1', '-vf', 'crop=1:1:20:860,format=rgba', '-f', 'rawvideo', '-'])
  expect(mid[3]).toBe(255)
  // Full size through EngineHost.renderAnimation (1080x1920, 2 s at 30 fps), and how long it takes.
  const big = join(BASE, 'anim full.mov')
  const t0 = Date.now()
  await page.evaluate((p) => window.reel.dev.renderTestAnimation(p, true), big)
  const ms = Date.now() - t0
  const bigProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', big]).toString())
  expect([bigProbe.streams[0].width, bigProbe.streams[0].height, Number(bigProbe.streams[0].nb_frames)]).toEqual([1080, 1920, 60])
  console.log(`full-size animation: 60 frames in ${ms} ms`)
  expect(ms).toBeLessThan(120_000)
  // A real template from templates/animations, asked for as .webm like the AI does: the renderer
  // writes .mov + the .anim.json sidecar the engine reads.
  const t1 = Date.now()
  const real = await page.evaluate(
    (p) => window.reel.dev.renderTestAnimation(p, true, 'stat-count-up', { value: '3,000', text: 'people signed up' }),
    join(BASE, 'anim real ü.webm')
  )
  console.log(`stat-count-up: ${real} in ${Date.now() - t1} ms`)
  expect(real.endsWith('.mov')).toBe(true)
  expect(existsSync(real.replace(/\.mov$/, '.anim.json'))).toBe(true)
  const realProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', real]).toString())
  expect([realProbe.streams[0].codec_name, realProbe.streams[0].width, realProbe.streams[0].height]).toEqual(['qtrle', 1080, 1920])

  // ---- quit mid-job, reopen, pick up where we left off ----
  await page.getByTestId('nav-home').click()
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('status-message')).toContainText(/Listening/, { timeout: 60_000 })
  await app.close()

  ;({ app, page } = await launch())
  await expect(page.getByText('Your videos')).toBeVisible()
  await expect(page.locator('.badge.interrupted')).toBeVisible()
  await shot(page, '17-home-after-quit')
  await page.locator('.card', { has: page.locator('.badge.interrupted') }).click()
  await expect(page.getByText('This video is paused')).toBeVisible()
  await shot(page, '18-working-stopped')
  await page.getByTestId('resume').click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('project-card')).toHaveCount(2)
  await shot(page, '19-home')
  await app.close()
})

test('a force quit mid-job recovers on the next start', async () => {
  const media = makeMedia()
  let { app, page } = await launch()
  await passFirstRun(page)
  const before = await page.getByTestId('project-card').count()
  await page.getByTestId('new-video').click()
  // Drag and drop this time (the first test used the file picker).
  await dropFiles(page, 'drop-zone', [media.video])
  await expect(page.getByTestId('status-message')).toContainText(/Listening/, { timeout: 60_000 })
  // Like a crash or Task Manager "End task": no quit handlers run. Only the app's main process is
  // killed; the engine it started is left behind as an orphan, which the next start must clean up.
  // app.process() can be a launcher, so ask the main process for its own pid.
  const mainPid = await app.evaluate(() => process.pid)
  const exited = new Promise((r) => app.process().once('exit', r))
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(mainPid), '/F'])
  else process.kill(mainPid, 'SIGKILL')
  await exited

  ;({ app, page } = await launch())
  await expect(page.getByTestId('project-card')).toHaveCount(before + 1)
  const stopped = page.locator('.card', { has: page.locator('.badge.interrupted') })
  await expect(stopped).toHaveCount(1)
  await stopped.click()
  await page.getByTestId('resume').click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
  await shot(page, '20-recovered-after-force-quit')
  await app.close()
})
