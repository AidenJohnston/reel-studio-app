// Versions as a tree: a note can change an older version (its result branches from it), two versions can be combined
// part by part, and the Versions view draws which version each one came from.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, openSettings, passFirstRun, shot } from './helpers'

test('fails if a note on an older version does not branch from it, or Combine does not make a version from both', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(BASE, 'tree', 'data'), REELSTUDIO_ROOT: join(BASE, 'tree', 'Reel Studio'), REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '300' })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected editor')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()
    await makeReel(page, media.video)
    const slug = await page.evaluate(() => window.reel.projects.list().then((l) => l[0].slug))
    const versions = () => page.evaluate((s) => window.reel.projects.get(s).then((d) => d.versions.map((v) => ({ n: v.n, parent: v.parent, parents: v.parents ?? null }))), slug)
    for (const [text, n] of [['make the subtitles bigger', 2], ['warmer colors', 3]] as const) {
      await page.getByTestId('note-input').fill(text)
      await page.getByTestId('send').click()
      await expect(page.getByTestId(`log-play-${n}`)).toBeVisible({ timeout: 120_000 })
    }

    // the Versions view: one line, newest first
    await page.getByTestId('notes-view-versions').click()
    await expect(page.getByTestId('version-tree')).toBeVisible()
    await expect(page.getByTestId('version-tree').locator('li')).toHaveCount(3)
    await shot(page, 'version-tree-01-line')

    // a note on Version 2 makes Version 4, a branch from Version 2
    await page.getByTestId('vt-change-2').click()
    await expect(page.getByTestId('note-base')).toHaveText(/Changes Version 2/)
    await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', /Version 2/)
    await shot(page, 'version-tree-02-change-this-one')
    await page.getByTestId('note-input').fill('quieter music')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('note-base')).toHaveCount(0)
    await expect(page.getByTestId('vt-4')).toBeVisible({ timeout: 120_000 })
    expect((await versions()).find((v) => v.n === 4)).toEqual({ n: 4, parent: 2, parents: null })
    await expect(page.getByTestId('vt-4')).toContainText('from Version 2')
    await shot(page, 'version-tree-03-branch')

    // Combine: Version 4 with the music from Version 3
    await page.getByTestId('vt-4').hover()
    await page.getByTestId('vt-combine-4').click()
    await expect(page.getByTestId('combine')).toBeVisible()
    await expect(page.getByTestId('combine-theirs')).toHaveValue('3')
    await expect(page.getByTestId('combine-make')).toBeDisabled()
    await page.getByTestId('combine-music-theirs').click()
    await shot(page, 'version-tree-04-combine')
    await page.getByTestId('combine-make').click()
    await expect(page.getByTestId('combine')).toHaveCount(0)
    await expect(page.getByTestId('log-play-5')).toBeVisible({ timeout: 120_000 })
    expect((await versions()).find((v) => v.n === 5)).toEqual({ n: 5, parent: 4, parents: [4, 3] })
    const chat = await page.evaluate((s) => window.reel.projects.get(s).then((d) => d.chat.filter((m) => m.from === 'you').map((m) => m.text)), slug)
    expect(chat).toContain('Version 4, with the music from Version 3')
    await page.getByTestId('notes-view-versions').click()
    await expect(page.getByTestId('vt-5')).toContainText('from Versions 4 and 3')
    await shot(page, 'version-tree-05-combined')

    // from the title bar: watching an older version offers Change this one, and the chip goes back to the newest
    await page.getByTestId('vt-play-2').click()
    await page.getByTestId('version-change-this').click()
    await expect(page.getByTestId('note-base')).toHaveText(/Changes Version 2/)
    await page.getByTestId('note-base-clear').click()
    await expect(page.getByTestId('note-base')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
