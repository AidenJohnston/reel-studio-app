// Version 1 stopped while the video was still being copied in: no project.json yet, a partial copy in media/. The
// stand-in engine holds every copy for FAKE_ENGINE_SLOW_COPY seconds before it writes project.json, so Stop always
// lands in the copy. Resume copies the video again from the file the person dropped; if that file is gone, the reel
// says so and takes another video, and nothing offers a Resume it can't do.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, startReel } from './helpers'

function profile(name: string): Record<string, string> {
  const dir = mkdtempSync(join(BASE, `copy-${name}-`))
  return { REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'user data'), FAKE_ENGINE_SLOW_COPY: '600' }
}
const card = (page: Page) => page.getByTestId('project-card')
const slowCopy = (app: ElectronApplication, seconds: string) => app.evaluate((_e, s) => void (process.env.FAKE_ENGINE_SLOW_COPY = s), seconds)
const reelDir = (page: Page) =>
  page.evaluate(async () => {
    const [p] = await window.reel.projects.list()
    return (await window.reel.projects.get(p.slug)).dir
  })

/** New reel, its video, and Stop while the copy is held: the reel has a partial copy and no project.json. */
async function stopDuringCopy(page: Page, video: string): Promise<string> {
  await startReel(page, video)
  await expect(page.getByTestId('note-progress')).toContainText('Copying your video')
  const dir = await reelDir(page)
  await expect.poll(() => existsSync(join(dir, 'media'))).toBe(true)
  await page.getByTestId('stop').click()
  await expect(page.getByTestId('first-paused')).toBeVisible()
  expect(existsSync(join(dir, 'project.json'))).toBe(false)
  return dir
}

// fails if Resume after a Stop during the copy refuses ("never finished copying") instead of copying the video again
// from the file the person dropped and making Version 1
test('stopped during the copy, Resume copies the video again from the dropped file and makes Version 1', async () => {
  test.setTimeout(5 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch(profile('again'))
  try {
    await passFirstRun(page)
    const dir = await stopDuringCopy(page, media.video)
    await page.getByTestId('nav-home').click()
    await expect(card(page)).toHaveAttribute('data-state', 'paused')
    await expect(page.getByTestId('card-status')).toHaveText('You paused it · resumes where it stopped')

    await slowCopy(app, '0')
    await page.getByRole('button', { name: /^Resume:/ }).click()
    await expect(card(page)).toHaveAttribute('data-state', 'making')
    await card(page).click()
    await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.map((s: { originalName: string }) => s.originalName)).toEqual([basename(media.video)])
    // the files it copied from are only kept until the copy is in
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).copyFrom).toBeUndefined()
  } finally {
    await app.close()
  }
})

// fails if a reel whose copy was stopped and whose dropped file is gone still says "resumes where it stopped" and
// offers Resume, or if Choose another video on it doesn't make Version 1 on the same reel
test('stopped during the copy with the dropped file gone, the reel says so and takes the video again', async () => {
  test.setTimeout(5 * 60_000)
  const media = makeMedia()
  const away = mkdtempSync(join(BASE, 'gone-'))
  const dropped = join(away, 'phone take.mp4')
  copyFileSync(media.video, dropped)
  const { app, page } = await launch(profile('gone'))
  try {
    await passFirstRun(page)
    await stopDuringCopy(page, dropped)
    rmSync(dropped)

    await page.getByTestId('nav-home').click()
    await expect(card(page)).toHaveAttribute('data-state', 'failed')
    await expect(page.getByTestId('card-status')).toContainText('Your video was only partly copied and the file you dropped can’t be found any more, so drop it again from where it is now.')
    await expect(page.getByRole('button', { name: /^Resume:/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Choose another video:/ })).toBeVisible()
    expect(await page.evaluate(() => window.reel.projects.list().then((l) => l.length))).toBe(1)

    // the reel itself says the same where the video would be, and takes the video there
    await card(page).click()
    const stage = page.getByTestId('stage-failed')
    await expect(stage).toContainText('Your video was only partly copied and the file you dropped can’t be found any more, so drop it again from where it is now.')
    await expect(page.getByTestId('first-paused')).toHaveCount(0)
    await slowCopy(app, '0')
    await stage.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
    await expect(page.getByTestId('title')).toHaveText('My first take')
    expect(await page.evaluate(() => window.reel.projects.list().then((l) => l.length))).toBe(1)
  } finally {
    await app.close()
  }
})
