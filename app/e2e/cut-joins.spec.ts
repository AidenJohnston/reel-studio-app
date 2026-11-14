// Edit it myself > Cut > Transitions, end to end with the fake engine: how each cut plays, picked by hand, becomes
// Version 2 through the same queue as any hand edit. A match is asked of the engine when it is picked and kept only
// where it lines up (the fake engine lines up a cut whose next word has an even number). A word cut by hand in the
// same session keeps the joins the editor had set.
//
// Run: npx playwright test e2e/cut-joins.spec.ts after a build. Same env as smoke.spec.ts.
import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'joins-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

const projectFile = (slug: string): string => join(ROOT, 'Projects', slug, 'project.json')
const projectJson = (slug: string): any => JSON.parse(readFileSync(projectFile(slug), 'utf8'))

/** Version 1 as the AI editor might have left it: three stretches, the last one joined with a J cut. */
function seedCut(slug: string): void {
  const keep = [{ from: 'w0', to: 'w4' }, { from: 'w7', to: 'w11' }, { from: 'w14', to: 'w18', join: { transition: 'j', frames: 8 } }]
  const dir = join(ROOT, 'Projects', slug)
  for (const file of [projectFile(slug), join(dir, 'versions', 'v1', 'project.json')]) {
    const p = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...p, cut: { ...p.cut, keep } }, null, 2))
  }
}

test('transitions: picked by hand, a match kept only where it lines up, made into a version', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const slug = (await page.locator('.reel-page').getAttribute('data-slug'))!
    seedCut(slug)
    await page.getByTestId('nav-home').click()
    await page.locator(`[data-slug="${slug}"] [data-testid=project-card]`).click()

    await page.getByRole('button', { name: 'Edit it myself' }).click()
    await page.getByRole('tab', { name: 'Cut' }).click()
    // fails if the four-way switch is wider than the panel at the smallest window (Fable check 1, #2): each choice's
    // words fit its segment, and the switch ends inside the panel's column
    await page.setViewportSize({ width: 1100, height: 720 })
    await expect
      .poll(() => page.evaluate(() => {
        const sw = document.querySelector('[data-testid="cut-mode"]')!
        const col = sw.closest('.edit-b')!.getBoundingClientRect()
        const r = sw.getBoundingClientRect()
        const clipped = Array.from(sw.querySelectorAll('button')).filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent)
        return { clipped, inside: r.left >= col.left - 0.5 && r.right <= col.right + 0.5 }
      }), { message: 'Cut switch at 1100 x 720' })
      .toEqual({ clipped: [], inside: true })
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.getByTestId('cut-mode-joins').click()
    const rows = page.getByTestId('join-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByRole('radio', { name: 'Plain', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(rows.nth(1).getByRole('radio', { name: 'J', exact: true })).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'joins-01-as-made')

    // fails if a match the engine says doesn't line up is kept anyway
    await rows.nth(0).getByRole('radio', { name: 'Match', exact: true }).click()
    await expect(rows.nth(0).getByTestId('join-check')).toHaveText('Not here: the speaker moves too much across the cut.')
    await expect(rows.nth(0).getByRole('radio', { name: 'Plain', exact: true })).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'joins-02-no-match')

    await rows.nth(0).getByRole('radio', { name: 'L', exact: true }).click()
    await rows.nth(1).getByRole('radio', { name: 'Match', exact: true }).click()
    await expect(rows.nth(1).getByTestId('join-check')).toHaveText('Lines up, so this cut hides.')
    await expect(rows.nth(1).getByRole('radio', { name: 'Match', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('change-count')).toHaveText('2 changes')
    await expect(page.getByTestId('joins-later')).toHaveText('The player shows the cuts as made. What you pick here plays in Version 2.')
    await shot(page, 'joins-03-l-and-match')

    // fails if a row's choices run off the column at the smallest window
    await page.setViewportSize({ width: 1100, height: 720 })
    const panel = page.locator('.edit-b')
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    for (const row of await rows.all()) {
      const r = (await row.getByRole('radiogroup').boundingBox())!
      const p = (await panel.boundingBox())!
      expect(r.x + r.width).toBeLessThanOrEqual(p.x + p.width + 0.5)
    }
    await shot(page, 'joins-04-smallest-window')
    await page.setViewportSize({ width: 1280, height: 820 })

    // fails if a crossed-out word clicked by mistake comes back unnamed, or takes more than one step to cut again (the
    // runner's J2 by hand brought back two fillers and saved them); the version at the end shows nothing came back
    await page.getByTestId('cut-mode-cut').click()
    const words = page.getByTestId('words').locator('.word')
    await words.nth(5).click()
    await words.nth(6).click()
    await expect(page.getByTestId('brought-back')).toHaveText(/^You brought back “[\p{L}\p{N}']+”, “[\p{L}\p{N}']+”\. They are heard in Version 2\.\s*Cut them again$/u)
    await page.getByTestId('cut-again').click()
    await expect(page.getByTestId('brought-back')).toHaveCount(0)
    await expect(words.nth(5)).toHaveClass(/(^| )cut( |$)/)
    await expect(words.nth(6)).toHaveClass(/(^| )cut( |$)/)

    // a word cut inside the last stretch keeps the match on the cut into it
    await page.getByTestId('words').locator('.word').nth(16).click()
    await page.getByTestId('cut-mode-joins').click()
    await expect(rows.nth(1).getByRole('radio', { name: 'Match', exact: true })).toHaveAttribute('aria-checked', 'true')

    await page.getByRole('button', { name: 'Make Version 2' }).click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 5 * 60_000 })
    expect(projectJson(slug).cut.keep).toEqual([
      { from: 'w0', to: 'w4' },
      { from: 'w7', to: 'w11', join: { transition: 'l', frames: 8 } },
      { from: 'w14', to: 'w15', join: { transition: 'match', frames: 0 } },
      { from: 'w17', to: 'w18' }
    ])
    await expect(page.getByTestId('chat')).toContainText('cut a word and changed how 2 cuts play')
  } finally {
    await app.close()
  }
})
