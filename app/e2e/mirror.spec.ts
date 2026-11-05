// "Flip the picture" in "Edit it myself": the no-AI way to flip a mirrored take. Makes a
// reel, turns the toggle on, makes a new version, and checks what reached project.json and the
// chat; then turns it off again.
//
// Run: npx playwright test e2e/mirror.spec.ts (after npm run build). Same env as smoke.spec.ts:
//   REELSTUDIO_E2E_VIDEO   a real (mirrored) take; default a generated clip
//   REELSTUDIO_ENGINE_DIR  a real engine (the flip is only visible with one); default the stand-in
//   REELSTUDIO_E2E_SHOTS   where to put the screenshots (default e2e/screenshots, gitignored)
import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, SHOTS, launch, makeMedia, makeReel, passFirstRun } from './helpers'

const OUT = process.env.REELSTUDIO_E2E_SHOTS ?? SHOTS

const projectsDir = (): string => join(root(), 'Projects')
const projectDirs = (): string[] => (existsSync(projectsDir()) ? readdirSync(projectsDir()) : [])
// The one this test makes. The file's tests share its profile, and readdir order is the file system's (NTFS lists
// names sorted), so the project is found by name rather than as [0].
let mine: string | undefined

function project(): any {
  if (!mine) throw new Error('the project this test made is not known yet')
  return JSON.parse(readFileSync(join(projectsDir(), mine, 'project.json'), 'utf8'))
}

test('flip a mirrored take from Edit it myself', async () => {
  test.setTimeout(20 * 60_000)
  mkdirSync(OUT, { recursive: true })
  const snap = async (name: string) => {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(OUT, `${name}.png`) })
  }
  const media = makeMedia()
  const { app, page } = await launch()
  await passFirstRun(page)
  const before = projectDirs()
  await makeReel(page, media.video, 15 * 60_000)
  const made = projectDirs().filter((d) => !before.includes(d))
  expect(made, 'exactly one new project').toHaveLength(1)
  mine = made[0]
  expect(project().sources[0].mirror).toBeUndefined()

  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-cover').click()
  const toggle = page.getByTestId('mirror-on')
  await expect(toggle).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText('Flip the picture')).toBeVisible()
  await snap('mirror-01-drawer-off')
  await toggle.check()
  await expect(page.getByTestId('make-version')).toBeEnabled()
  // fails if the cover on the phone stays as filmed: it was made before the flip, so it is drawn mirrored until then
  await expect(page.getByTestId('cover-preview').locator('img, video').first()).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)')
  await snap('mirror-02-drawer-on')
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByText(/flipped the picture/).first()).toBeVisible()
  const p = project()
  expect(p.sources[0].mirror).toBe(true)
  expect(p.sources[0].path).toMatch(/^media\//)                   // only the flag moved
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && v.readyState >= 2 && v.videoWidth > 0
  })
  await snap('mirror-03-reel-v2-flipped')

  // and back: the flag is removed, the project is as it was
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-cover').click()
  await expect(page.getByTestId('mirror-on')).toBeChecked()
  await page.getByTestId('mirror-on').uncheck()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('log-play-3')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByText(/picture back the way you filmed it/).first()).toBeVisible()
  expect('mirror' in project().sources[0]).toBe(false)
  await app.close()
})
