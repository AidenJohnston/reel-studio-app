// "Paused without you" (ux-foundation-b.md 3.4 and 7) and New reel, in the built app with the stand-in engine:
// Version 1 stopped by a plan at its limit pauses and continues by itself at the reset; a quit asks, and the work
// continues on the next launch; a New reel nobody touched never stays behind.
//
// Run: npm run build && npx playwright test e2e/paused.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, newReel, passFirstRun, startReel } from './helpers'

function profile(name: string) {
  const dir = mkdtempSync(join(BASE, `${name}-`))
  return { dir, env: { REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'user data') } }
}
const reels = (page: Page) => page.evaluate(() => window.reel.projects.list())

// fails if a plan at its limit fails Version 1 or makes a basic version instead, or the reel never continues
test('Version 1 at a plan limit pauses, says when it continues, and continues by itself', async () => {
  test.setTimeout(5 * 60_000)
  const media = makeMedia()
  const p = profile('limit')
  // the practice editor's plan is at its limit for the first 25 s; the pause continues right at the reset
  const until = new Date(Date.now() + 25_000).toISOString()
  const { app, page } = await launch({ ...p.env, REELSTUDIO_MOCK_NOTE: '300', REELSTUDIO_MOCK_LIMIT: until, REELSTUDIO_PAUSE_MARGIN_MS: '0' })
  try {
    await passFirstRun(page)
    await startReel(page, media.video)
    const why = page.getByTestId('first-paused-why')
    await expect(why).toContainText('Paused. Your plan is at its limit, so this continues when it resets at', { timeout: 60_000 })
    await expect(page.getByTestId('first-failed')).toHaveCount(0)
    const [r] = await reels(page)
    expect(r).toMatchObject({ status: 'interrupted', pausedFor: { reason: 'limit', until } })
    // on Reels it sits with the reels being made, saying why and when it continues
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('card-status')).toHaveText(/^(\w+ )?[Pp]lan limit · continues at /)
    await expect(page.getByRole('region', { name: 'Making' }).getByTestId('project-card')).toHaveCount(1)
    await page.getByTestId('project-card').click()
    // nobody presses Resume: it goes on at the reset and Version 1 lands
    await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 120_000 })
    expect((await reels(page))[0]).toMatchObject({ status: 'ready', pausedFor: null })
  } finally {
    await app.close()
  }
})

// fails if quitting mid-make doesn't ask, or the work waits for Resume on the next launch instead of continuing
test('a quit while Version 1 is made asks once, and the next launch continues it', async () => {
  test.setTimeout(5 * 60_000)
  const media = makeMedia()
  const p = profile('quit')
  let { app, page } = await launch({ ...p.env, FAKE_ENGINE_SLOW: '30' })
  await passFirstRun(page)
  await startReel(page, media.video)
  await expect(page.getByTestId('note-progress')).toContainText(/Listening/, { timeout: 60_000 })
  await app.close()
  const log = readFileSync(join(p.dir, 'user data', 'logs', 'main.log'), 'utf8')
  expect(log).toContain('[quit] 1 reel is still being made. Quit and continue it next time? Quit')

  ;({ app, page } = await launch({ ...p.env, FAKE_ENGINE_SLOW: '3' }))
  try {
    await expect.poll(async () => (await reels(page))[0]?.status, { timeout: 30_000 }).toBe('working')
    await page.getByTestId('project-card').click()
    await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 180_000 })
  } finally {
    await app.close()
  }
})

// fails if New reel (⌘N) piles up empty reels, or leaving one keeps it on Reels
test('an untouched New reel never stays: ⌘N again reuses it, leaving removes it, a renamed one stays', async () => {
  const p = profile('newreel')
  const { app, page } = await launch(p.env)
  try {
    await passFirstRun(page)
    for (let i = 0; i < 3; i++) {
      await newReel(app)
      await expect(page.getByTestId('planned-stage')).toBeVisible()
    }
    expect((await reels(page)).length).toBe(1)
    await page.getByTestId('nav-home').click()
    await expect.poll(async () => (await reels(page)).length).toBe(0)
    await expect(page.getByTestId('project-card')).toHaveCount(0)

    await newReel(app)
    await page.getByTestId('title').click()
    await page.getByTestId('title-input').fill('Sourdough in 60 seconds')
    await page.getByTestId('title-input').press('Enter')
    await expect(page.getByTestId('title')).toHaveText('Sourdough in 60 seconds')
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('project-card')).toHaveCount(1)
    expect((await reels(page)).map((r) => r.title)).toEqual(['Sourdough in 60 seconds'])
  } finally {
    await app.close()
  }
})
