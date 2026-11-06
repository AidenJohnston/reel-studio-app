// A version's edit checks, end to end in the built app with the stand-in engine: opening a version's "What changed"
// reads its checks (engine `score`) and lists the failing one first, with the line that says what the checks are not.
// The real checks are engine/tests/test_score.py and compositing/test_score_version.py; the stand-in reports loudness
// off target because it never normalizes its sound.
//
// Run: npm run build && npx playwright test e2e/edit-checks.spec.ts
import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'edit-checks-'))

test("a version's checks show under What changed, failing ones first", async () => {
  test.setTimeout(6 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(MINE, 'Documents', 'Reel Studio'), REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    // a version nobody has watched offers Watch in that place: play it first
    await page.getByTestId('log-play-1').click()
    // the newest version's rows may already be open: a click would close them
    const changed = page.getByTestId('what-changed-1')
    if ((await changed.getAttribute('aria-expanded')) !== 'true') await changed.click()
    const checks = page.getByTestId('edit-checks-1')
    await expect(checks).toContainText('2 of 3 checks pass.')
    await expect(checks).toContainText('not whether the reel works')
    await expect(checks.locator('.drow').first()).toContainText('Loudness')
    await expect(checks.locator('.drow').first()).toContainText('−19.6 LUFS, off target')
    await shot(page, 'edit-checks-01')
  } finally {
    await app.close().catch(() => {})
  }
})
