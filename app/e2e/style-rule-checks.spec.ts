// A checked My style rule, end to end in the built app with the stand-in engine and the mock AI playing a connected
// Claude Code app (REELSTUDIO_MOCK_CLAUDE=ready): a note about words per subtitle asks to check that on every reel,
// the question says it will be checked, Yes saves the rule with its check, and My style shows it as checked. The
// engine side (measuring the rule, stopping a final render) is engine/tests/compositing/test_rule_checks_render.py;
// the note loop around it is ai/test/rules.test.ts.
//
// Run: npm run build && npx playwright test e2e/style-rule-checks.spec.ts
import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, openSettings, passFirstRun, shot, makeReel } from './helpers'

const MINE = mkdtempSync(join(BASE, 'rule-checks-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

test('a checked rule is asked as one the app checks, saved with its check, and shown as checked in My style', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready' })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected AI')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()

    await page.getByTestId('nav-home').click()
    await makeReel(page, media.video)
    await page.getByTestId('note-input').fill('always show at most 2 words in a subtitle')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('chat')).toContainText('Remember this for next time? "Show at most 2 words in a subtitle."', { timeout: 120_000 })
    await expect(page.getByTestId('remember-kind')).toHaveText('I’ll check this on every reel.')
    await shot(page, 'rule-checks-01-question')

    await page.getByTestId('action-remember-yes').click()
    await expect(page.getByTestId('chat')).toContainText("Saved. I'll check this on every new reel.")
    const saved = JSON.parse(readFileSync(join(ROOT, 'My style.json'), 'utf8')).rules
    expect(saved).toEqual([expect.objectContaining({ text: 'Show at most 2 words in a subtitle.', check: { kind: 'captions.maxWords', value: 2 } })])

    await page.getByTestId('nav-style').click()
    const rule = page.getByTestId('style-rule')
    await expect(rule).toHaveCount(1)
    await expect(rule).toContainText('Checked')
    await rule.getByRole('button', { name: 'Subtitles: Show at most 2 words in a subtitle', exact: true }).click()
    await expect(rule).toContainText('The app checks this on every reel it makes')
    await shot(page, 'rule-checks-02-my-style')
    await rule.getByRole('button', { name: 'Edit "Show at most 2 words in a subtitle"' }).click()
    await expect(page.getByTestId('style-edit-input')).toHaveAccessibleDescription(
      'If you change these words, they become a sentence the AI reads, and the app no longer checks every reel for it.'
    )
    await shot(page, 'rule-checks-03-editing')
  } finally {
    await app.close().catch(() => {})
  }
})
