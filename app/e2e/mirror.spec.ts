// "Flip picture (it's mirrored)" in "Edit it myself": the no-AI way to flip a mirrored take. Makes a
// reel, turns the toggle on, makes a new version, and checks what reached project.json and the
// chat; then turns it off again.
//
// Run: npx playwright test e2e/mirror.spec.ts (after npm run build). Same env as smoke.spec.ts:
//   REELSTUDIO_E2E_VIDEO   a real (mirrored) take; default a generated clip
//   REELSTUDIO_ENGINE_DIR  a real engine (the flip is only visible with one); default the stand-in
//   REELSTUDIO_E2E_SHOTS   where to put the screenshots (default e2e/screenshots, gitignored)
import { test, expect } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, SHOTS, launch, makeMedia, passFirstRun } from './helpers'

const OUT = process.env.REELSTUDIO_E2E_SHOTS ?? SHOTS

function project(): any {
  const dir = join(ROOT, 'Projects')
  return JSON.parse(readFileSync(join(dir, readdirSync(dir)[0], 'project.json'), 'utf8'))
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
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 15 * 60_000 })
  expect(project().sources[0].mirror).toBeUndefined()

  await page.getByTestId('edit-myself').click()
  const toggle = page.getByTestId('mirror-on')
  await expect(toggle).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText("Flip picture (it's mirrored)")).toBeVisible()
  await snap('mirror-01-drawer-off')
  await toggle.check()
  await expect(page.getByTestId('make-version')).toBeEnabled()
  await snap('mirror-02-drawer-on')
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('versions').getByText('Version 2')).toBeVisible({ timeout: 10 * 60_000 })
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
  await expect(page.getByTestId('mirror-on')).toBeChecked()
  await page.getByTestId('mirror-on').uncheck()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('versions').getByText('Version 3')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByText(/picture back the way you filmed it/).first()).toBeVisible()
  expect('mirror' in project().sources[0]).toBe(false)
  await app.close()
})
