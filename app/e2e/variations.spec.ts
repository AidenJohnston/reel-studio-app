// Versions to compare, end to end with the stand-in engine: Cut > Pace > "One at each pace" queues one hand edit per
// pace, they become Versions 2 to 4 in a row, each changing only cutStyle with its seed in the notes, and Compare
// plays one against the one before.
//
// Run: npm run build && npx playwright test e2e/variations.spec.ts
import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'variations-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

test('one version at each pace, made in a row and compared', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const slug = (await page.locator('.reel-page').getAttribute('data-slug'))!
    await page.getByRole('button', { name: 'Edit it myself' }).click()
    await page.getByRole('tab', { name: 'Cut' }).click()
    await page.getByTestId('cut-mode-pace').click()
    await expect(page.getByTestId('pace')).toBeVisible()
    // no pace yet: only one at each pace is offered
    await expect(page.getByTestId('variations-moments')).toHaveCount(0)
    await page.getByTestId('variations-paces').click()
    await expect(page.getByTestId('variations-said')).toContainText('Versions 2 to 4 are on their way')
    await shot(page, 'variations-01-queued')
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('log-play-4')).toBeVisible({ timeout: 240_000 })
    const read = (n: number) => JSON.parse(readFileSync(join(ROOT, 'Projects', slug, 'versions', `v${n}`, 'project.json'), 'utf8'))
    const v1 = read(1)
    const paces = [2, 3, 4].map((n) => read(n))
    expect(paces.map((p) => p.cutStyle.preset)).toEqual(['clean', 'standard', 'hyper'])
    // each differs from Version 1 in its pace alone
    for (const p of paces) expect({ ...p, cutStyle: undefined, version: undefined, handEdits: undefined, updatedAt: undefined }).toEqual({ ...v1, cutStyle: undefined, version: undefined, handEdits: undefined, updatedAt: undefined })
    await expect(page.getByTestId('chat')).toContainText(`Variation: Fast pace (seed ${paces[2].cutStyle.seed})`)

    await page.getByTestId('log-play-4').click()
    // the newest version's rows may already be open: a click would close them
    const changed = page.getByTestId('what-changed-4')
    if ((await changed.getAttribute('aria-expanded')) !== 'true') await changed.click()
    await page.getByTestId('compare-4').click()
    await expect(page.getByTestId('compare-pick-3')).toBeVisible()
    await expect(page.getByTestId('compare-pick-4')).toBeVisible()
    await shot(page, 'variations-02-compare')
  } finally {
    await app.close().catch(() => {})
  }
})
