// Add now (T3 Code's steer): a note written while a version is being made can go into that version instead of
// waiting for its own. From a waiting row, or straight from the box with Ctrl/⌘+Enter.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, openSettings, passFirstRun, shot } from './helpers'

test('fails if a note added while a version is made is lost, waits for its own version, or does not show under the note it joined', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  // the practice editor takes 25 s per note, long enough to add to it: at 6 s, a Windows run at 100% CPU spent the
  // whole note on the steps before Add now (a screenshot among them), and the note was saved first (harness-1106-6)
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(BASE, 'add-now', 'data'), REELSTUDIO_ROOT: join(BASE, 'add-now', 'Reel Studio'), REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '25000' })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected editor')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()
    await makeReel(page, media.video)
    const slug = await page.evaluate(() => window.reel.projects.list().then((l) => l[0].slug))
    const project = () => page.evaluate((s) => window.reel.projects.get(s), slug)

    // 1. from a waiting row
    await page.getByTestId('note-input').fill('make the subtitles bigger')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('note-progress')).toBeVisible()
    await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', /adds it now/)
    await page.getByTestId('note-input').fill('and cut the first pause')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('queue-row')).toHaveCount(1)
    await shot(page, 'add-now-01-waiting-row')
    await page.getByTestId('queue-add').click()
    await expect(page.getByTestId('queue-row')).toHaveCount(0)
    await expect(page.getByTestId('note-added')).toHaveText(/Added\s*and cut the first pause/)
    await shot(page, 'add-now-02-added')
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    let p = await project()
    expect(p.versions.map((v) => v.n)).toEqual([1, 2])
    expect(p.project.notes?.at(-1)?.text).toBe('make the subtitles bigger\nand cut the first pause')
    expect(p.queue).toEqual([])

    // 2. straight from the box: Ctrl+Enter (⌘+Enter on a Mac) while the next version is made
    await page.getByTestId('note-input').fill('warmer colors')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('note-progress')).toBeVisible()
    // the Versions view shows the version being made, dashed, hanging from the one it changes
    await page.getByTestId('notes-view-versions').click()
    await expect(page.getByTestId('vt-ghost')).toHaveCount(1)
    await expect(page.getByTestId('vt-ghost')).toContainText('Making it from Version 2')
    await shot(page, 'add-now-04-ghost-in-versions')
    await page.getByTestId('notes-view-notes').click()
    await page.getByTestId('note-input').fill('and quieter music')
    await page.getByTestId('note-input').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.getByTestId('note-added').last()).toHaveText(/and quieter music/)
    await expect(page.getByTestId('queue-row')).toHaveCount(0)
    await expect(page.getByTestId('log-play-3')).toBeVisible({ timeout: 120_000 })
    await shot(page, 'add-now-03-done')
    p = await project()
    expect(p.versions.map((v) => v.n)).toEqual([1, 2, 3])
    expect(p.project.notes?.at(-1)?.text).toBe('warmer colors\nand quieter music')
  } finally {
    await app.close()
  }
})
