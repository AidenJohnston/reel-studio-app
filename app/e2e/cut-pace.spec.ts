// Edit it myself > Cut > Pace, end to end with the fake engine: the reel's pace and a zoom-in's kind picked by hand
// become Version 2 through the same queue as any hand edit, then "Try other moments" keeps the pace with a new seed
// in Version 3. Each version's project.json and its line in the notes carry what was picked.
//
// Run: npx playwright test e2e/cut-pace.spec.ts after a build. Same env as smoke.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'pace-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

const projectFile = (slug: string): string => join(ROOT, 'Projects', slug, 'project.json')
const projectJson = (slug: string): any => JSON.parse(readFileSync(projectFile(slug), 'utf8'))

/** Version 1 as the AI editor might have left it: two zoom-ins, one with no kind (a plain punch-in), one quick. */
function seedZooms(slug: string): void {
  const zooms = [{ anchor: { from: 'w2', to: 'w4' } }, { anchor: { from: 'w10', to: 'w12' }, kind: 'snap' }]
  const dir = join(ROOT, 'Projects', slug)
  for (const file of [projectFile(slug), join(dir, 'versions', 'v1', 'project.json')]) {
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), zooms }, null, 2))
  }
}

async function openPace(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit it myself' }).click()
  await page.getByRole('tab', { name: 'Cut' }).click()
  await page.getByTestId('cut-mode-pace').click()
  await expect(page.getByTestId('pace')).toBeVisible()
}

test('pace and zoom-in kinds: picked by hand, made into versions, other moments in the same pace', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const slug = (await page.locator('.reel-page').getAttribute('data-slug'))!
    expect(readdirSync(join(ROOT, 'Projects'))).toContain(slug)
    seedZooms(slug)
    await page.getByTestId('nav-home').click()
    await page.locator(`[data-slug="${slug}"] [data-testid=project-card]`).click()

    // ---- Version 2: a pace and a zoom-in's kind ----
    await openPace(page)
    const paces = page.getByRole('radiogroup', { name: 'Pace' })
    await expect(paces.getByRole('radio', { name: /^No set pace/ })).toBeChecked()
    // fails if Try other moments is offered with no pace to keep
    await expect(page.getByTestId('pace-reshuffle')).toHaveCount(0)
    const rows = page.getByTestId('zoom-row')
    await expect(rows).toHaveCount(2)
    // a zoom-in with no kind plays as a punch-in, so Instant is its choice
    await expect(rows.nth(0).getByRole('radio', { name: 'Instant' })).toHaveAttribute('aria-checked', 'true')
    await expect(rows.nth(1).getByRole('radio', { name: 'Quick' })).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'pace-01-as-made')

    await paces.getByRole('radio', { name: /^Fast/ }).check()
    await rows.nth(0).getByRole('radio', { name: 'Slow' }).click()
    await expect(rows.nth(0).getByRole('radio', { name: 'Slow' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('change-count')).toHaveText('2 changes')
    await expect(page.getByTestId('pace-later')).toContainText('Make Version 2 to see your changes.')
    // Undo steps back one choice at a time
    await page.getByTestId('drawer-undo').click()
    await expect(rows.nth(0).getByRole('radio', { name: 'Instant' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('change-count')).toHaveText('1 change')
    await rows.nth(0).getByRole('radio', { name: 'Slow' }).click()
    await shot(page, 'pace-02-fast-slow')

    // fails if a pace row or a zoom-in's control runs off the column at the smallest window
    await page.setViewportSize({ width: 1100, height: 720 })
    const panel = page.locator('.edit-b')
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    for (const row of await rows.all()) {
      const r = (await row.getByRole('radiogroup').boundingBox())!
      const p = (await panel.boundingBox())!
      expect(r.x + r.width).toBeLessThanOrEqual(p.x + p.width + 0.5)
    }
    await shot(page, 'pace-03-smallest-window')
    await page.setViewportSize({ width: 1280, height: 820 })

    await page.getByRole('button', { name: 'Make Version 2' }).click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 5 * 60_000 })
    const v2 = projectJson(slug)
    expect(v2.cutStyle.preset).toBe('hyper')
    expect(Number.isInteger(v2.cutStyle.seed)).toBe(true)
    // the kind-less zoom keeps the 1.12 it zoomed by; the other is untouched
    expect(v2.zooms).toEqual([{ anchor: { from: 'w2', to: 'w4' }, scale: 1.12, kind: 'drift' }, { anchor: { from: 'w10', to: 'w12' }, kind: 'snap' }])
    await expect(page.getByTestId('chat')).toContainText('gave the reel a fast pace and made a zoom-in slow')

    // ---- Version 3: other moments in the same pace ----
    await openPace(page)
    await expect(paces.getByRole('radio', { name: /^Fast/ })).toBeChecked()
    await page.getByTestId('pace-reshuffle').click()
    await expect(page.getByTestId('pace-moments')).toHaveText('Version 3 keeps the fast pace with other moments.')
    await expect(page.getByTestId('change-count')).toHaveText('1 change')
    await shot(page, 'pace-04-other-moments')
    await page.getByRole('button', { name: 'Make Version 3' }).click()
    await expect(page.getByTestId('log-play-3')).toBeVisible({ timeout: 5 * 60_000 })
    const v3 = projectJson(slug)
    expect(v3.cutStyle.preset).toBe('hyper')
    expect(v3.cutStyle.seed).not.toBe(v2.cutStyle.seed)
    expect(v3.zooms).toEqual(v2.zooms)
    await expect(page.getByTestId('chat')).toContainText('picked other moments for the accents')
  } finally {
    await app.close()
  }
})
