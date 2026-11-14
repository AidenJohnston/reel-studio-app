// A mirrored take found at import (engine mirror_detect.py): the editor says it flipped it, and "Undo
// flip" puts it back; a take that only looks mirrored is asked about, and "Flip it" flips it. Each answer is a
// button under the editor's line in the Notes panel, queued as a change made by hand (main mirror:answer), so it
// makes a new version, the buttons go, and Edit it myself > Cover's "Flip the picture" shows the same state.
//
// Run: npx playwright test e2e/mirror-detect.spec.ts (after npm run build). The stand-in engine decides
// from the file's name ("...mirrored..." / "...maybe-mirrored..."); with REELSTUDIO_ENGINE_DIR set to the
// real engine, use REELSTUDIO_E2E_MIRRORED for a take the real check finds mirrored.
//   REELSTUDIO_E2E_SHOTS   where to put the screenshots (default e2e/screenshots, gitignored)
import { test, expect, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, makeMedia, makeReel, passFirstRun, root } from './helpers'

const OUT = process.env.REELSTUDIO_E2E_SHOTS ?? SHOTS

function newest(): any {
  const dir = join(root(), 'Projects')
  const p = readdirSync(dir).map((d) => JSON.parse(readFileSync(join(dir, d, 'project.json'), 'utf8')))
  return p.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop()
}

/** Edit it myself > Cover's "Flip the picture", as the panel shows it now; the panel closes again. */
async function flipShown(page: Page): Promise<boolean> {
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-cover').click()
  const on = await page.getByTestId('mirror-on').isChecked()
  await page.getByTestId('drawer-close').click()
  await expect(page.getByTestId('drawer')).toHaveCount(0)
  return on
}

test('a mirrored take comes in flipped, says so, and Undo flip puts it back', async () => {
  test.setTimeout(20 * 60_000)
  mkdirSync(OUT, { recursive: true })
  const media = makeMedia()
  const take = process.env.REELSTUDIO_E2E_MIRRORED ?? join(BASE, 'my mirrored take.mp4')
  if (!process.env.REELSTUDIO_E2E_MIRRORED) copyFileSync(media.video, take)
  const { app, page } = await launch()
  await passFirstRun(page)
  await makeReel(page, take, 15 * 60_000)
  expect(newest().sources[0]).toMatchObject({ mirror: true, mirrorCheck: { verdict: 'mirrored' } })
  await expect(page.getByText('I flipped your video: it looked mirrored (the writing behind you reads backwards).')).toBeVisible()
  await expect(page.getByTestId('action-mirror-undo')).toHaveText('Undo flip')
  expect(await flipShown(page)).toBe(true)
  await page.screenshot({ path: join(OUT, 'mirror-detect-01-flipped.png') })

  await page.getByTestId('action-mirror-undo').click()
  await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByText('Done: it is back the way you filmed it.')).toBeVisible()
  await expect(page.getByTestId('action-mirror-undo')).toHaveCount(0)
  expect(await flipShown(page)).toBe(false)
  const s = newest().sources[0]
  expect('mirror' in s).toBe(false)
  expect(s.mirrorCheck.answer).toBe('undone')
  await page.screenshot({ path: join(OUT, 'mirror-detect-02-undone.png') })
  await app.close()
})

test('a take that only looks mirrored is asked about, and Flip it flips it', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const take = join(BASE, 'my maybe-mirrored take.mp4')
  copyFileSync(media.video, take)
  const { app, page } = await launch()
  await passFirstRun(page)
  await makeReel(page, take, 15 * 60_000)
  expect('mirror' in newest().sources[0]).toBe(false)
  await expect(page.getByText('Your video looks mirrored (some writing behind you seems to read backwards). Flip it?')).toBeVisible()
  await expect(page.getByTestId('action-mirror-flip')).toHaveText('Flip it')
  await expect(page.getByTestId('action-mirror-keep')).toHaveText('Keep as filmed')
  expect(await flipShown(page)).toBe(false)
  await page.screenshot({ path: join(OUT, 'mirror-detect-03-asked.png') })

  await page.getByTestId('action-mirror-flip').click()
  await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByText('Flipped. The writing behind you reads the right way now.')).toBeVisible()
  await expect(page.getByTestId('action-mirror-keep')).toHaveCount(0)
  expect(newest().sources[0]).toMatchObject({ mirror: true, mirrorCheck: { verdict: 'maybe-mirrored', answer: 'flipped' } })
  expect(await flipShown(page)).toBe(true)
  await page.screenshot({ path: join(OUT, 'mirror-detect-04-flipped-on-answer.png') })
  await app.close()
})

test('two quick answers settle once: the first wins, the second changes nothing', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const take = join(BASE, 'my second maybe-mirrored take.mp4')
  copyFileSync(media.video, take)
  const { app, page } = await launch()
  await passFirstRun(page)
  await makeReel(page, take, 15 * 60_000)
  const slug = newest().slug
  // both answers at once, straight to the main process (as a double click or two buttons would)
  const got = await page.evaluate(async (slug) => {
    const reel = (window as any).reel
    const m = (await reel.projects.get(slug)).chat.find((x: any) => x.actions?.includes('mirror-flip'))
    const answers = await Promise.all([reel.mirror.answer(slug, m.id, 'mirror-flip'), reel.mirror.answer(slug, m.id, 'mirror-keep')])
    const chat = (await reel.projects.get(slug)).chat
    return { answers, replies: chat.filter((x: any) => /^(Flipped\.|OK, I left it)/.test(x.text)).length, buttons: chat.some((x: any) => x.actions?.length) }
  }, slug)
  expect(got).toEqual({ answers: [{ change: 'flipped the picture' }, { change: '' }], replies: 1, buttons: false })
  expect(newest().sources[0]).toMatchObject({ mirror: true, mirrorCheck: { answer: 'flipped' } })
  await app.close()
})
