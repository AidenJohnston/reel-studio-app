// Library, My style and Insights (ux-foundation-b.md section 6, spec.md section 9): tabs that mirror the Library
// folder, a drop that lands in its own tab, previews and licences; rules with where they came from, Remove and
// Undo, and Learn from my past edits saving nothing until you keep it; Insights always in the sidebar, saying what it
// will show and what it needs.
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { APP_DIR, BASE, launch, makeMedia, passFirstRun, shot } from './helpers'

const FIXTURE = join(APP_DIR, '..', 'engine', 'tests', 'fixtures', 'reference-import', 'talking-head.xml')

async function dropOnWindow(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = true
    i.id = '__drop_source'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.locator('#__drop_source').setInputFiles(paths)
  await page.evaluate(() => {
    const src = document.getElementById('__drop_source') as HTMLInputElement
    const dt = new DataTransfer()
    for (const f of Array.from(src.files ?? [])) dt.items.add(f)
    const target = document.querySelector('.page') ?? document.body
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    src.remove()
  })
}

test('Library, My style and Insights', async () => {
  test.setTimeout(180_000)
  const media = makeMedia()
  const dir = mkdtempSync(join(BASE, 'library-'))
  const root = join(dir, 'Reel Studio')
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(dir, 'user data'), REELSTUDIO_ROOT: root })
  await passFirstRun(page)

  // ---- Insights: in the sidebar with nothing posted, saying what it will show and what it needs ----
  // fails if Insights hides until a post (e2e/insights.spec.ts covers it with results)
  await page.getByTestId('nav-insights').click()
  await expect(page.getByTestId('titlebar-title')).toHaveText('Insights')
  await expect(page.getByTestId('insights-empty')).toContainText('how long people watched')
  await expect(page.getByTestId('insights-empty')).toContainText('Connect Instagram, TikTok or Facebook first.')

  // ---- Library: tabs, no Finished videos, an empty tab says what goes there ----
  await page.getByTestId('nav-library').click()
  await expect(page.getByTestId('titlebar-title')).toHaveText('Library')
  await expect(page.getByTestId('titlebar-actions').getByRole('button', { name: 'Add files' })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveText(['Pictures0', 'Videos0', 'Music0', 'Sound effects37', 'Fonts15'])
  await expect(page.getByTestId('library-tab-images')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('library-empty')).toContainText('No pictures yet')
  await expect(page.getByText('Finished videos')).toHaveCount(0)

  // a dropped song lands in Music, with its waveform, length and licence
  await dropOnWindow(page, [media.song])
  await expect(page.getByTestId('library-tab-music')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('library-result')).toHaveText('Added 1 song to your Library.')
  const song = page.getByTestId('library-sound')
  await expect(song).toHaveCount(1)
  await expect(song).toContainText('happy song')
  await expect(song).toContainText('Yours')
  await expect(song.locator('.lib-wave svg').first()).toBeVisible()
  await expect(song.locator('.lib-dur')).toHaveText('8.0 s')

  // a dropped picture lands in Pictures; a clip in Videos, as a strip of frames, never a <video>
  await dropOnWindow(page, [media.picture])
  await expect(page.getByTestId('library-tab-images')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('library-picture')).toContainText('logo.png')
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('library-tab-videos')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('library-clip').locator('img.lib-sheet')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('library-clip')).toContainText('0:12')
  await expect(page.locator('video')).toHaveCount(0)

  // the sound effects that come with Reel Studio, each with its licence
  await page.getByTestId('library-tab-sfx').click()
  await expect(page.getByTestId('library-sound')).toHaveCount(37)
  await expect(page.getByTestId('library-sound').first()).toContainText('CC0')
  await shot(page, 'library-sfx')

  // ---- Fonts: the caption faces that come with Reel Studio, each drawn in itself, and a font of yours ----
  await page.getByTestId('library-tab-fonts').click()
  await expect(page.getByTestId('bin-fontpack').getByTestId('library-font')).toHaveCount(15)
  await expect(page.getByTestId('bin-fontpack').getByTestId('library-font').filter({ hasText: 'Montserrat SemiBold' })).toContainText('SIL Open Font License')
  await dropOnWindow(page, [join(APP_DIR, '..', 'packaging', 'fonts', 'Inter-Bold.ttf')])
  await expect(page.getByTestId('library-result')).toHaveText('Added 1 font to your Library.')
  const mine = page.getByTestId('bin-fonts').getByTestId('library-font')
  await expect(mine).toHaveCount(1)
  await expect(mine).toContainText('Inter Bold')
  await expect(mine).toContainText('Yours')
  // fails if the row draws in the app's own face: the sample's font is the file's
  await expect.poll(() => mine.locator('.lib-font-sample').evaluate((el) => {
    const family = getComputedStyle(el).fontFamily.split(',')[0].replace(/"/g, '').trim()
    let status: string | undefined
    document.fonts.forEach((f) => { if (f.family.replace(/"/g, '') === family) status = f.status })
    return status
  })).toBe('loaded')
  await shot(page, 'library-fonts')

  // ---- My style: add, forget, undo ----
  await page.getByTestId('nav-style').click()
  await expect(page.getByTestId('style-empty')).toBeVisible()
  await page.getByTestId('style-add').click()
  await page.getByTestId('style-add-input').fill('Always use big subtitles')
  await page.keyboard.press('Enter')
  const rule = page.getByTestId('style-rule')
  await expect(rule).toHaveCount(1)
  await expect(rule).toContainText('Big subtitles')
  await expect(rule).toContainText('added by you, just now')
  await page.getByRole('button', { name: 'Forget "Big subtitles"' }).click()
  await expect(rule).toHaveCount(0)
  await expect(page.getByTestId('style-undo')).toBeFocused()
  await page.getByTestId('style-undo').click()
  await expect(rule).toHaveCount(1)
  expect((await page.evaluate(() => window.reel.style.rules())).map((r) => r.text)).toEqual(['Always use big subtitles.'])

  // ---- Learn from my past edits: shows each rule first, saves only what you keep ----
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, FIXTURE)
  // nothing found in the test's empty home folder: Choose files… is the way in, and only it opens the dialog
  await page.getByTestId('style-learn').click()
  await page.getByTestId('learn-choose').click()
  const lesson = page.getByTestId('style-lesson')
  await expect(lesson).toContainText('talking-head.xml (Premiere Pro)')
  await expect(page.getByTestId('style-lesson-rule')).toHaveText([
    /^Keep reels around 5 seconds\.Your timeline runs 4 seconds\./,
    /^Open with a title on screen in the first few seconds\.Your timeline starts with a title\./
  ])
  expect(await page.evaluate(() => window.reel.style.rules())).toHaveLength(1)
  await shot(page, 'style-lesson')
  await page.getByTestId('style-lesson-rule').first().click()
  await expect(page.getByTestId('style-lesson-keep')).toHaveText('Keep 1 rule')
  await page.getByTestId('style-lesson-keep').click()
  await expect(lesson).toHaveCount(0)
  await expect(rule).toHaveCount(2)
  // newest first
  await expect(rule.first()).toContainText('Open with a title on screen in the first few seconds')
  await expect(rule.first()).toContainText('from your Premiere Pro edit talking-head.xml, just now')

  await app.close()
})
