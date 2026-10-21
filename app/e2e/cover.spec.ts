// The cover picker: frames picked from the video, each with its time and why, the chosen one marked, and
// a pick saved as that exact frame. Run after a build: npx playwright test e2e/cover.spec.ts
import { test, expect } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clock } from '../src/shared/progress'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

const MINE = mkdtempSync(join(BASE, 'cover-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

test('cover suggestions say when and why, mark the chosen frame, and save it as the frame to render', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })

  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-cover').click()
  const picks = page.getByTestId('cover-pick')
  await expect(picks.first()).toBeVisible()
  // the stand-in engine's first frame: eyes open and face in focus beat its neighbours
  await expect(picks.first()).toContainText(/^0:\d\dEyes open, face in focus$/)
  await expect(page.getByText('Drag to fine-tune')).toHaveCount(0)

  await picks.nth(0).click()
  await page.keyboard.press('ArrowRight') // radio buttons: arrows move and pick
  await expect(picks.nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(picks.nth(1)).toBeFocused()
  await expect(page.locator('[data-testid=cover-pick][aria-checked=true]')).toHaveCount(1)
  const label = (await picks.nth(1).getAttribute('aria-label'))!

  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('drawer')).toHaveCount(0)
  const dir = join(ROOT, 'Projects', readdirSync(join(ROOT, 'Projects'))[0])
  const cover = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).cover
  expect(cover.manual).toBe(true) // the engine renders this frame, no search around it
  expect(label.startsWith(`${clock(cover.atSourceTime)},`)).toBe(true)
  await app.close()
})
