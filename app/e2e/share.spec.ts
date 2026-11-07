// Share's popover: Help improve is asked once, only after a share that worked, and the last destination used comes first.
// Nothing in it claims to post: Instagram and the other platforms say they aren't connected.
//
// Run: npx playwright test e2e/share.spec.ts (after npm run build).
import { test, expect } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, expectOneCheckbox, launch, makeMedia, makeReel, openSettings, passFirstRun, startReel } from './helpers'

test('fails if Help improve is asked before a share that worked or a second time, the last destination used is not first, or a platform reads as connected', async () => {
  test.skip(process.platform !== 'darwin', 'Uses a macOS iCloud Drive folder to make a save fail.')
  test.setTimeout(15 * 60_000)
  const dir = mkdtempSync(join(BASE, 'share-'))
  const home = join(dir, 'home')
  const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  mkdirSync(icloud, { recursive: true })
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(dir, 'data'), REELSTUDIO_ROOT: join(dir, 'Reel Studio') })
  const sharing = () => page.evaluate(() => window.reel.app.info().then((i) => i.sharing))
  try {
    await app.evaluate(({ app }, folder) => app.setPath('home', folder), home)
    await passFirstRun(page)
    // The first run still asks today; Share takes the question over, so start from "never asked".
    await page.evaluate(() => window.reel.app.setSharing({ asked: false, on: false, usage: true, quality: true, posts: true }))
    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })

    const pop = page.getByTestId('share-pop')
    const ask = pop.getByTestId('help-improve')
    await page.getByTestId('share').click()
    await expect(pop).toBeVisible()
    await expect(ask).toHaveCount(0)
    await expect(pop.getByTestId('share-instagram')).toContainText('Saves the reel and copies the caption')
    await pop.getByTestId('share-platforms-toggle').click()
    await expect(pop.getByTestId('share-platforms')).toContainText('None of these are connected yet')
    // fails if a platform's box is not the app's one checkbox, or the keyboard can't tick it and hear that it is
    const insta = pop.getByRole('checkbox', { name: 'Instagram Reels' })
    const tiktok = pop.getByRole('checkbox', { name: 'TikTok' })
    await expectOneCheckbox(insta, true)
    await expectOneCheckbox(tiktok, false)
    await insta.focus()
    await page.keyboard.press('Tab')
    await expect(tiktok).toBeFocused()
    expect(await tiktok.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
    await page.keyboard.press('Space')
    await expect(pop.getByRole('checkbox', { name: 'TikTok', checked: true })).toHaveCount(1)
    await expectOneCheckbox(tiktok, true)
    await page.keyboard.press('Space')
    await expect(pop.getByRole('checkbox', { name: 'TikTok', checked: false })).toHaveCount(1)
    await pop.getByTestId('share-platforms-toggle').click()

    // A save that fails is not a share.
    chmodSync(icloud, 0o500)
    await pop.getByTestId('save-icloud').click()
    await expect(pop.locator('.sp-fail')).toContainText("isn't allowed to write to iCloud Drive")
    await expect(ask).toHaveCount(0)
    chmodSync(icloud, 0o700)

    await pop.getByTestId('share-finder').click()
    await expect(pop).toContainText('Saved as', { timeout: 120_000 })
    await expect(ask).toBeVisible()
    await expect(ask).toContainText('Never your videos, words, notes or file names.')
    expect((await sharing()).asked).toBe(true)
    await ask.getByTestId('help-no').click()
    await expect(ask).toHaveCount(0)
    expect(await sharing()).toMatchObject({ asked: true, on: false })
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()

    await page.getByTestId('share').click()
    await expect(pop.locator('.sp-go').first()).toHaveAttribute('data-testid', 'share-finder')
    await pop.getByTestId('share-instagram').click()
    await expect(pop).toContainText('caption copied')
    await expect(ask).toHaveCount(0)

    // Another visit to the reel: still asked once, and Instagram now comes first.
    await page.keyboard.press('Escape')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('project-card').first().click()
    await page.getByTestId('share').click()
    await expect(pop.locator('.sp-go').first()).toHaveAttribute('data-testid', 'share-instagram')
    await pop.getByTestId('share-finder').click()
    await expect(pop).toContainText('Saved as')
    await expect(ask).toHaveCount(0)
  } finally {
    chmodSync(icloud, 0o700)
    await app.close()
  }
})

// The share panel shows the cover posted with the reel beside its caption; Change takes the person to where it is picked.
test('fails if the share panel does not show the cover beside the caption, or Change does not open the Cover tab', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 8 * 60_000 })
    await page.getByTestId('share').click()
    const pop = page.getByTestId('share-pop')
    const cover = pop.getByTestId('share-cover')
    await expect(cover.locator('img')).toHaveJSProperty('complete', true)
    expect(await cover.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
    await cover.click()
    await expect(pop).toBeHidden()
    await expect(page.getByTestId('drawer')).toBeVisible()
    await expect(page.getByTestId('tab-cover')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tab-cover')).toBeFocused()

    // and with the panel already open on another tab: Change moves it to Cover
    await page.getByTestId('tab-cut').click()
    await expect(page.getByTestId('tab-cut')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('share').click()
    await pop.getByTestId('share-cover').click()
    await expect(pop).toBeHidden()
    await expect(page.getByTestId('tab-cover')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tab-cover')).toBeFocused()
  } finally {
    await app.close()
  }
})

// A waiting hand edit open in Edit it myself: Share's Change goes to its Cover tab and keeps that edit (it used to start
// a new edit, so what the person changed next made another version instead of replacing the waiting one).
test('fails if Share › Change leaves the waiting hand edit open in Edit it myself', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(BASE, 'share-hand', 'data'), REELSTUDIO_ROOT: join(BASE, 'share-hand', 'Reel Studio') })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    // the paces' renders take long enough to stop the first: the other two wait, held
    await app.evaluate(() => void (process.env.FAKE_ENGINE_SLOW_RENDER = '60'))
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('tab-cut').click()
    await page.getByTestId('cut-mode-pace').click()
    await page.getByTestId('variations-paces').click()
    await expect(page.getByTestId('variations-said')).toContainText('on their way')
    // Stop lives on the note box's progress, under the panel
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('stop').click()
    await expect(page.getByTestId('stop')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByTestId('queue-edit').first()).toBeVisible()
    await page.getByTestId('queue-edit').first().click()
    const sub = page.getByTestId('drawer').locator('.edit-sub')
    await expect(sub).toContainText('Your waiting edit')

    await expect(page.getByTestId('share')).toBeEnabled()
    await page.getByTestId('share').click()
    await page.getByTestId('share-pop').getByTestId('share-cover').click()
    await expect(page.getByTestId('tab-cover')).toHaveAttribute('aria-selected', 'true')
    await expect(sub).toContainText('Your waiting edit')
  } finally {
    await app.close()
  }
})

// An older version on screen: Share shows its cover, with no Change (the Cover tab edits the newest version, and
// Change used to switch the screen to it).
test("fails if Share offers Change on an older version's cover", async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({
    REELSTUDIO_USER_DATA: join(BASE, 'share-older', 'data'), REELSTUDIO_ROOT: join(BASE, 'share-older', 'Reel Studio'), REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '300'
  })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected editor')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()
    await makeReel(page, media.video)
    await page.getByTestId('note-input').fill('make the subtitles bigger')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })

    await page.getByTestId('log-play-1').click()
    await expect(page.getByTestId('version-latest')).toBeVisible()
    await page.getByTestId('share').click()
    const pop = page.getByTestId('share-pop')
    await expect(pop.locator('.sp-cover-img')).toBeVisible()
    await expect(pop.getByTestId('share-cover')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
