// "Remember this for next time?" for lowercase captions, end to end in the built app with the stand-in engine and
// the mock AI playing a connected Claude Code app (REELSTUDIO_MOCK_CLAUDE=ready): a lowercase note makes a new
// version, the app asks once, Yes saves the rule to My style, the next video starts lowercase, and after Remove
// the video after that does not.
//
// Run: npm run build && npx playwright test e2e/remember-caption-case.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'remember-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const projects = (): string[] => readdirSync(join(ROOT, 'Projects')).filter((s) => !s.startsWith('.'))
const captionCase = (slug: string): unknown => JSON.parse(readFileSync(join(ROOT, 'Projects', slug, 'project.json'), 'utf8')).captions?.style?.case

async function newVideo(page: Page, video: string): Promise<string> {
  const before = projects()
  await page.getByTestId('nav-home').click()
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
  return projects().find((s) => !before.includes(s))!
}

test('a lowercase note is remembered only on Yes, starts the next video lowercase, and stops after Remove', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready', FAKE_ENGINE_SLOW: '1' })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected AI')
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()

    // 1-3. the correction, the version it made, and the question with its scope
    const first = await newVideo(page, media.video)
    await page.getByTestId('note-input').fill('make the captions lowercase')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('remember-scope')).toHaveText(/^For new videos\. From version \d+ of this video\.$/, { timeout: 120_000 })
    await expect(page.getByTestId('chat')).toContainText('I made the captions lowercase.')
    await expect(page.getByTestId('chat')).toContainText('Remember this for next time? "Use lowercase captions."')
    expect(captionCase(first)).toBe('lower')
    expect(await page.evaluate(() => window.reel.style.rules())).toEqual([])
    await shot(page, 'remember-01-question')
    await page.getByTestId('action-remember-yes').click()
    await expect(page.getByTestId('chat')).toContainText('Saved. Your next videos will start with lowercase captions.')
    await expect(page.getByTestId('action-remember-yes')).toHaveCount(0)

    // 4. the saved rule, where it applies and where it came from
    await page.getByTestId('nav-style').click()
    const rule = page.getByTestId('style-rule')
    await expect(rule).toHaveCount(1)
    await expect(rule).toContainText('Use lowercase captions.')
    await expect(rule).toContainText(/On new videos\. From ".+", version \d+\./)
    await shot(page, 'remember-02-my-style')
    // editing it says, before anything changes, that new words make it a sentence the AI reads
    await page.getByRole('button', { name: 'Edit "Use lowercase captions."' }).click()
    await expect(page.getByTestId('style-edit-input')).toHaveAccessibleDescription(
      'If you change these words, they become a sentence the AI reads, and the app no longer makes new videos lowercase by itself.'
    )
    await shot(page, 'remember-03-editing')
    await page.keyboard.press('Escape')

    // 5. the next video starts lowercase, and says why
    const second = await newVideo(page, media.video)
    expect(captionCase(second)).toBe('lower')
    await expect(page.getByTestId('chat')).toContainText('I used lowercase captions from your My style.')

    // 6. Remove stops it
    await page.getByTestId('nav-style').click()
    await page.getByRole('button', { name: 'Remove "Use lowercase captions."' }).click()
    await expect(page.getByTestId('style-rule')).toHaveCount(0)
    const third = await newVideo(page, media.video)
    expect(captionCase(third)).not.toBe('lower')
    await expect(page.getByTestId('chat')).toContainText('Your video is ready.')
    await expect(page.getByTestId('chat')).not.toContainText('My style')
  } finally {
    await app.close().catch(() => {})
  }
})
