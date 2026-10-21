// Screenshots for the README (docs/images/). Not a test of behaviour: it makes one real reel from a
// licence-clean presenter clip and photographs the app. Skipped unless asked for.
//
//   REELSTUDIO_README_DIR=<scratch dir>      where the profile, the library and the project live
//   REELSTUDIO_README_VIDEO=<presenter.mp4>  the clip (read in place, never copied into the repo)
//   REELSTUDIO_README_SONG=<song.mp3>        a royalty-free song for the Library
//   REELSTUDIO_README_PHASE=make|shoot|public
//   REELSTUDIO_ENGINE_DIR / REELSTUDIO_PYTHON / REELSTUDIO_MODELS_DIR / REELENGINE_CACHE_DIR as in takes.spec.ts
//
// make   : drop the clip, let the real engine + the Claude Code app signed in on this computer edit it (the run
//          clicks "Use Claude (your Claude Code app)"), send one note.
//          (needs REELSTUDIO_E2E_AI=package, bills one or two AI runs on that Claude plan)
// shoot  : relaunch on that finished project; the sidebar says ChatGPT is connected (stubbed), and take the
//          Reel / drawer / export / home pictures.
// public : first-run connect screen and the script screen on a fresh profile (mock AI: no Claude Code app found).
// Output: app/e2e/screenshots/readme/*.png (gitignored); copy the ones you want into docs/images/.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chooseClaudeCode, dropFiles, launch, passFirstRun, SHOTS } from './helpers'

const DIR = process.env.REELSTUDIO_README_DIR
const VIDEO = process.env.REELSTUDIO_README_VIDEO
const SONG = process.env.REELSTUDIO_README_SONG
const PHASE = process.env.REELSTUDIO_README_PHASE ?? ''
const OUT = join(SHOTS, 'readme')

test.skip(!DIR || !PHASE, 'set REELSTUDIO_README_DIR and REELSTUDIO_README_PHASE to run')

const NOTE = 'Make the music a little quieter at the start'

function env(): Record<string, string> {
  return { REELSTUDIO_ROOT: join(DIR!, 'root'), REELSTUDIO_USER_DATA: join(DIR!, 'user data'), REELSTUDIO_MOCK_AI: '0' }
}

async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

/** The sidebar with an AI editor connected (ChatGPT, stubbed). */
async function stubConnected(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const p = { id: 'chatgpt', connected: true, label: 'ChatGPT', detail: '' }
    ipcMain.removeHandler('ai:active')
    ipcMain.handle('ai:active', async () => ({ ok: true, value: p }))
  })
}

function projectJson(): { dir: string; project: Record<string, any> } {
  const base = join(DIR!, 'root', 'Projects')
  const dir = join(base, readdirSync(base)[0])
  return { dir, project: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) }
}

/** Pause the preview on a moment where something is happening (a caption, a picture). */
async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate((at) => {
    const v = document.querySelector('[data-testid=player]') as HTMLVideoElement
    v.pause()
    v.currentTime = at
  }, t)
  await page.waitForFunction(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).readyState >= 2)
  await page.waitForTimeout(500)
}

test('make: one real reel from the presenter clip', async () => {
  test.skip(PHASE !== 'make')
  test.setTimeout(90 * 60_000)
  const { app, page } = await launch({ ...env(), REELSTUDIO_DEV: '0' })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    expect(await chooseClaudeCode(page)).toBe(true)
    await page.getByTestId('nav-library').click()
    await page.getByTestId('file-input').setInputFiles([SONG!])
    await expect(page.getByTestId('bin-music')).toContainText('Sunny Loop', { timeout: 60_000 })
    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-video').click()
    await dropFiles(page, 'drop-zone', [VIDEO!])
    await expect(page.getByText('Making your reel')).toBeVisible()
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 60 * 60_000 })
    const replies = page.locator('.bubble.editor:not(.working):not(.reply-pending)')
    const before = await replies.count()
    await page.getByTestId('note-input').fill(NOTE)
    await page.keyboard.press('Enter')
    await expect.poll(() => replies.count(), { timeout: 40 * 60_000 }).toBeGreaterThan(before)
    await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 10 * 60_000 })
    const { project } = projectJson()
    writeFileSync(join(DIR!, 'project-after.json'), JSON.stringify(project, null, 2))
  } finally {
    await app.close().catch(() => {})
  }
})

test('shoot: Reel, drawer, export, home', async () => {
  test.skip(PHASE !== 'shoot')
  test.setTimeout(30 * 60_000)
  const { app, page } = await launch(env())
  await stubConnected(app)
  await expect(page.getByText('Your videos')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('ai-status')).toContainText('AI editor: ChatGPT')

  // the Reel screen, on the final version, paused on a captioned moment (the clip's file name was the title)
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('player')).toBeVisible()
  await page.getByTestId('rename').click()
  await page.getByTestId('title-input').fill('3 tiny morning habits')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('title')).toHaveText('3 tiny morning habits')
  await page.getByRole('button', { name: 'My videos' }).first().click()
  await expect(page.getByTestId('project-card').first()).toBeVisible()
  await page.waitForTimeout(800)
  await snap(page, 'home')
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('player')).toBeVisible()
  const at = Number(process.env.REELSTUDIO_README_AT ?? 4)
  await page.addStyleTag({ content: '.big-play { visibility: hidden }' }) // a playing preview has no play button
  await seek(page, at)
  await snap(page, 'reel')

  // the drawer, tab by tab
  await page.getByTestId('edit-myself').click()
  await expect(page.getByTestId('drawer')).toBeVisible()
  await snap(page, 'drawer-cut')
  for (const tab of ['captions', 'music', 'broll', 'cover', 'post']) {
    await page.getByTestId(`tab-${tab}`).click()
    await snap(page, `drawer-${tab}`)
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('drawer')).toHaveCount(0)

  // export
  await page.getByTestId('export').click()
  await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 10 * 60_000 })
  await snap(page, 'export')
  await app.close()
})

test('public: first-run connect screen and the script screen', async () => {
  test.skip(PHASE !== 'public')
  test.setTimeout(5 * 60_000)
  for (const d of ['public root', 'public user data']) rmSync(join(DIR!, d), { recursive: true, force: true })
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(DIR!, 'public root'), REELSTUDIO_USER_DATA: join(DIR!, 'public user data'), REELSTUDIO_MOCK_AI: '1' })
  try {
    await page.getByTestId('get-started').click()
    const ready = page.getByTestId('model-next')
    await expect(ready.or(page.getByTestId('download-model'))).toBeVisible()
    await ((await ready.isVisible()) ? ready : page.getByTestId('later')).click()
    await expect(page.getByTestId('skip')).toBeVisible()
    await snap(page, 'connect-ai')
    await page.getByTestId('skip').click()
    await expect(page.getByText('Your videos')).toBeVisible()
    await snap(page, 'home-empty')
    await page.getByTestId('new-video').click()
    await page.getByText('I want help writing a script first').click()
    await page.locator('textarea').first().fill('Three tips for better sleep')
    await snap(page, 'write-a-script')
  } finally {
    await app.close().catch(() => {})
  }
})
