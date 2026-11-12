// End-to-end smoke test: launches the built app, goes through first run, makes a reel from a real
// file on the Reel screen, tries every screen, exports, and survives a quit mid-job.
//
// Run: npm run e2e (builds first). Env:
//   REELSTUDIO_E2E_VIDEO   the raw take to use (default: a generated clip)
//   REELSTUDIO_ENGINE_DIR  a real engine to test against (default: the stand-in in dev/fake-engine)
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, dropFiles, launch, makeMedia, modelReady, passFirstRun, shot, openSettings, startReel, toEditorStep } from './helpers'

/** Each test starts on a fresh profile of its own, so neither depends on the order specs run in. */
function freshProfile(name: string): { root: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(BASE, `smoke-${name}-`))
  const root = join(dir, 'Zoë Müller', 'Documents', 'Reel Studio')
  return { root, env: { REELSTUDIO_USER_DATA: join(dir, 'user data'), REELSTUDIO_ROOT: root } }
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
  for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(join(SHOTS, f))
})

test('make a reel end to end', async () => {
  const media = makeMedia()
  const profile = freshProfile('reel')
  let { app, page } = await launch(profile.env)

  // ---- first run ----
  await expect(page.getByText('Welcome to Reel Studio')).toBeVisible()
  await shot(page, '01-firstrun-welcome')
  await page.getByTestId('get-started').click()
  // the sample is made on the Reel screen's own rows while the listening model downloads (instant with the stand-in)
  await expect(page.getByTestId('steps-list')).toBeVisible()
  await shot(page, '02-firstrun-sample')
  await page.getByTestId('demo-skip').click()
  await toEditorStep(page)
  await expect(page.getByRole('heading', { name: 'Choose your editor' })).toBeVisible()
  await modelReady(page)
  await shot(page, '03-firstrun-connect')
  await page.getByTestId('not-now').click()

  // ---- your turn: a new reel with no video yet, then Reels ----
  await expect(page.getByTestId('planned-stage')).toBeVisible()
  await shot(page, '04-your-turn')
  await page.getByTestId('nav-home').click()
  // left untouched, that new reel goes with it (main store.ts isUntouchedPlanned)
  await expect(page.getByTestId('project-card')).toHaveCount(0)
  await shot(page, '04-home')

  // ---- library: add a song, a picture and a file it cannot use ----
  await page.getByTestId('nav-library').click()
  await page.getByTestId('file-input').setInputFiles([media.song, media.picture, media.doc])
  // Said on the Library screen itself, in plain words (critique 1.12).
  await expect(page.getByTestId('library-result')).toHaveText('Added 1 song and 1 picture to your Library. Skipped notes.txt (not a video, song or picture).')
  await expect(page.getByTestId('bin-music').getByText('happy song', { exact: true })).toBeVisible()
  await shot(page, '05-library')

  // ---- New reel: a reel with no video yet; a non-video file is explained, not swallowed ----
  await page.getByTestId('new-reel').click()
  const stage = page.getByTestId('planned-stage')
  await expect(stage).toContainText('Drop the video you filmed')
  await shot(page, '06-new-reel')
  await stage.getByTestId('file-input').setInputFiles([media.doc])
  await expect(page.getByTestId('toast')).toContainText('Drop a video file')
  await expect(stage).toBeVisible()

  // ---- the real file: Version 1 is made here, the original playing, tagged ----
  await stage.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('note-progress')).toContainText('Making Version 1')
  await expect(page.getByTestId('note-progress')).toContainText(/Listening|Copying|Cutting|Picking|Mixing|Adding|Putting|Making your cover/)
  await expect(page.getByTestId('first-tag')).toHaveText('Original', { timeout: 60_000 })
  await shot(page, '07-making')
  // Dock / taskbar progress follows the job (main process; notifications are not shown in tests).
  const fb = await app.evaluate(() => (globalThis as any).__reelFeedback)
  expect(fb.progress.length).toBeGreaterThan(0)

  // ---- reel ----
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
  // Version 1 opens on what the first cut did, compared with the raw video.
  await expect(page.getByTestId('chat')).toContainText('Music')
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && v.readyState >= 2 && v.videoWidth > 0
  })
  await shot(page, '08-reel')
  const aiSource = await page.evaluate(() => window.reel.app.info().then((i) => i.ai))

  // The notes never claim AI work the no-AI path did not do (grandma test 7 + 12).
  if (aiSource === 'mock') await expect(page.getByTestId('version-fact-1')).toHaveText('Basic version')
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
  for (const t of ['captions', 'music', 'broll', 'cover']) {
    await page.getByTestId(`tab-${t}`).click()
    if (t === 'captions') await expect(page.getByTestId('sub-preview')).toBeVisible() // live preview on the phone
    await shot(page, `10-drawer-${t}`)
  }
  await expect(page.getByTestId('sub-preview')).toHaveCount(0)
  await page.getByTestId('tab-cut').click()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('version-on-screen')).toContainText('Version 2', { timeout: 120_000 })
  await shot(page, '11-reel-v2')

  // ---- no AI connected: the note box is there; the first note asks for an AI in its place and keeps the note ----
  if (aiSource === 'mock') {
    await expect(page.getByTestId('composer-connect')).toHaveCount(0)
    await page.getByTestId('note-input').fill('make the start faster')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('composer-connect')).toContainText('To make changes from a note, connect an AI once. Your note is kept.')
    await expect(page.getByTestId('change-at')).toHaveCount(0)
    await page.getByTestId('ai-setup-skip').click()
    await expect(page.getByTestId('note-input')).toHaveValue('make the start faster')
  }
  await shot(page, '12-reel-no-ai')

  // ---- share ----
  await page.getByTestId('share').click()
  await page.getByTestId('share-finder').click()
  await expect(page.getByTestId('share-pop')).toContainText('- Version 2.mp4', { timeout: 120_000 })
  await shot(page, '13-share')
  const exported = readdirSync(join(profile.root, 'Library', 'Exports'))
  expect(exported.some((f) => / - Version 2\.mp4$/.test(f))).toBe(true)
  expect(exported.some((f) => f.endsWith('caption.txt'))).toBe(true)
  await page.keyboard.press('Escape')

  // ---- my style, settings, script ----
  await page.getByTestId('nav-style').click()
  await expect(page.getByText('My style', { exact: true }).first()).toBeVisible()
  await shot(page, '14-my-style')
  await openSettings(page)
  await expect(page.getByText('Library folder')).toBeVisible()
  await shot(page, '15-settings')
  // a reel with no video is the place to plan; with no editor, it asks to connect one first (plan.spec.ts)
  await page.getByTestId('new-reel').click()
  await expect(page.getByTestId('planned-stage')).toBeVisible()
  if (aiSource === 'mock') await expect(page.getByTestId('plan-connect')).toBeVisible()
  await shot(page, '16-plan')

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

  // ---- quit mid-job (the quit asks, and the test answers Quit), reopen: it goes on by itself ----
  await startReel(page, media.video)
  await expect(page.getByTestId('note-progress')).toContainText(/Listening/, { timeout: 60_000 })
  await app.close()

  ;({ app, page } = await launch(profile.env))
  await expect(page.getByRole('heading', { name: 'Reels' })).toBeVisible()
  await expect(page.locator('[data-testid="project-card"][data-state="making"]')).toBeVisible()
  await shot(page, '17-home-after-quit')
  await page.locator('[data-testid="project-card"][data-state="making"]').click()
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
  await page.getByTestId('nav-home').click()
  // the first reel and the one the quit interrupted (the New reels nobody touched are gone; the last took the video)
  await expect(page.getByTestId('project-card')).toHaveCount(2)
  await shot(page, '19-home')
  await app.close()
})

test('a force quit mid-job recovers on the next start', async () => {
  const media = makeMedia()
  const profile = freshProfile('quit')
  let { app, page } = await launch(profile.env)
  await passFirstRun(page)
  const before = await page.getByTestId('project-card').count()
  await page.getByTestId('new-reel').click()
  // Drag and drop this time (the first test used the file picker), once the new reel is on screen.
  await expect(page.getByTestId('planned-stage')).toBeVisible()
  await dropFiles(page, 'planned-stage', [media.video])
  await expect(page.getByTestId('note-progress')).toContainText(/Listening/, { timeout: 60_000 })
  // Like a crash or Task Manager "End task": no quit handlers run. Only the app's main process is
  // killed; the engine it started is left behind as an orphan, which the next start must clean up.
  // app.process() can be a launcher, so ask the main process for its own pid.
  const mainPid = await app.evaluate(() => process.pid)
  const exited = new Promise((r) => app.process().once('exit', r))
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(mainPid), '/F'])
  else process.kill(mainPid, 'SIGKILL')
  await exited

  ;({ app, page } = await launch(profile.env))
  await expect(page.getByTestId('project-card')).toHaveCount(before + 1)
  const stopped = page.locator('[data-testid="project-card"][data-state="paused"]')
  await expect(stopped).toHaveCount(1)
  await stopped.click()
  await page.getByTestId('resume').click()
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
  await shot(page, '20-recovered-after-force-quit')
  await app.close()
})
