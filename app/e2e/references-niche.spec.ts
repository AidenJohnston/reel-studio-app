// My style › Reference reels and Your niche, with the stand-in engine and the mock AI. The stand-in measures every reel
// with the same made-up numbers scaled by its length (dev/fake-engine measure-reel); the practice editor
// (REELSTUDIO_MOCK_NOTE) asks two questions, then drafts a fixed niche.
//
// Run: npm run build && npx playwright test e2e/references-niche.spec.ts
// Screenshots go to e2e/screenshots/learning-refs (SHOTS_DIR changes it).
import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, makeMedia, passFirstRun, root } from './helpers'

const DIR = process.env.SHOTS_DIR ?? join(SHOTS, 'learning-refs')
async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(DIR, { recursive: true })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(DIR, `${name}.png`) })
}

function video(name: string, seconds: number): string {
  const out = join(BASE, name)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=540x960:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out])
  return out
}

test('reference reels: files are measured, a TikTok link asks for its file, and the readout is what the editor reads', async () => {
  const { video: first } = makeMedia()
  const second = video('their reel ü.mp4', 20)
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    const section = page.getByTestId('references')
    await expect(page.getByTestId('references-empty')).toBeVisible()
    await snap(page, '01-my-style-sections-empty')

    await section.getByTestId('file-input').first().setInputFiles([first, second])
    const rows = section.getByTestId('reference')
    await expect(rows).toHaveCount(2)
    await expect(section.getByTestId('reference-numbers')).toHaveCount(2)
    await expect(section.getByTestId('reference-numbers').first()).toContainText('2.8 words a second')
    const readout = page.getByTestId('references-readout')
    await expect(readout).toContainText('What these 2 reels have in common')
    await expect(page.getByTestId('readout-pace')).toContainText('2.8')
    await snap(page, '02-references-measured')

    // the editor's tool reads references.json: its readout must be the one on screen
    const stored = JSON.parse(readFileSync(join(root(), 'References', 'references.json'), 'utf8'))
    await expect(readout.locator('.rr-lines li')).toHaveText(stored.readout.lines)

    // a TikTok link is kept, not downloaded, and the row says why and what to do
    await section.getByTestId('references-link').fill('https://www.tiktok.com/@maker/video/7300000000000000000')
    await section.getByTestId('references-link').press('Enter')
    const needs = section.getByTestId('reference-needs-file')
    await expect(needs).toContainText('TikTok’s terms don’t let other apps download its videos')
    await expect(needs).toContainText('Save video')
    await expect(section.getByTestId('references-link')).toHaveValue('')
    await snap(page, '03-reference-link-needs-file')

    // a link that is not one says so where it was typed
    await section.getByTestId('references-link').fill('my favourite reel')
    await section.getByTestId('references-link-add').click()
    await expect(page.getByTestId('references-error')).toContainText('That is not a link')

    // its file, added on its row, is measured like the others
    const linkRow = rows.filter({ has: needs })
    await linkRow.getByTestId('file-input').setInputFiles(second)
    await expect(section.getByTestId('reference-needs-file')).toHaveCount(0)
    await expect(readout).toContainText('What these 3 reels have in common')

    // Remove asks first, deletes the app's copy and never the person's own file
    await rows.first().getByTestId('more').click()
    await page.getByTestId('reference-remove').click()
    await expect(page.getByTestId('confirm')).toContainText('Your original file stays where it is')
    await snap(page, '04-reference-remove-confirm')
    await page.getByTestId('confirm-yes').click()
    await expect(rows).toHaveCount(2)
    expect(existsSync(second)).toBe(true)
  } finally {
    await app.close().catch(() => {})
  }
})

test('niche: a short chat drafts it, Save keeps it for the editor, and Edit, Remove and Undo work', async () => {
  const file = join(root(), 'My niche.json')
  const { app, page } = await launch({ REELSTUDIO_MOCK_NOTE: '600' })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    await expect(page.getByTestId('niche-empty')).toBeVisible()
    await page.getByTestId('niche-find').click()
    const sheet = page.getByTestId('niche-sheet')
    await expect(sheet).toContainText('What do you make reels about?')
    await expect(page.getByTestId('niche-input')).toBeFocused()

    await page.getByTestId('niche-input').fill('Sourdough bread at home')
    await page.getByTestId('niche-input').press('Enter')
    await expect(page.getByTestId('niche-editor-line').last()).toHaveText('Who do you picture watching? Be as specific as you can.')
    await snap(page, '05-niche-chat-question')
    await page.getByTestId('niche-input').fill('People who never baked bread')
    await page.getByTestId('niche-input').press('Enter')
    await expect(page.getByTestId('niche-editor-line')).toHaveCount(2)
    await page.getByTestId('niche-input').fill('I explain it without any special gear')
    await page.getByTestId('niche-input').press('Enter')
    await expect(page.getByTestId('niche-draft')).toBeVisible()
    await expect(page.getByTestId('niche-draft')).toContainText('The mistake that ruins most first loaves')
    await snap(page, '06-niche-chat-draft')

    await page.getByTestId('niche-save').click()
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId('niche-who')).toHaveText('People who want to bake bread at home but have never tried sourdough')
    expect(JSON.parse(readFileSync(file, 'utf8')).niche).toMatchObject({ from: 'chat', avoid: ['hack', 'game-changer', 'easy peasy'] })
    await snap(page, '07-niche-saved')

    // Edit: the person's own words, read by the editor next time
    await page.getByTestId('niche-edit').click()
    const form = page.getByTestId('niche-form')
    await form.getByLabel('Who your reels are for').fill('First-time bakers in small flats')
    await snap(page, '08-niche-edit')
    await page.getByTestId('niche-form-save').click()
    await expect(page.getByTestId('niche-who')).toHaveText('First-time bakers in small flats')
    expect(JSON.parse(readFileSync(file, 'utf8')).niche).toMatchObject({ who: 'First-time bakers in small flats', from: 'typed' })

    // Remove takes it away from the editor at once; Undo brings it back
    await page.getByTestId('niche-remove').click()
    await expect(page.getByTestId('niche-removed')).toBeVisible()
    await expect(page.getByTestId('niche-undo')).toBeFocused()
    expect(existsSync(file)).toBe(false)
    await snap(page, '09-niche-removed')
    await page.getByTestId('niche-undo').click()
    await expect(page.getByTestId('niche-who')).toHaveText('First-time bakers in small flats')
    expect(existsSync(file)).toBe(true)
  } finally {
    await app.close().catch(() => {})
  }
})

test('niche with no editor connected: the chat says so and Write it myself saves one', async () => {
  const own = join(BASE, 'no editor', 'Reel Studio')
  const { app, page } = await launch({ REELSTUDIO_ROOT: own, REELSTUDIO_USER_DATA: join(BASE, 'no editor', 'user data') }, { realViewport: true })
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 720))
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    await page.getByTestId('niche-find').click()
    await page.getByTestId('niche-input').fill('Desk stretches')
    await page.getByTestId('niche-input').press('Enter')
    await expect(page.getByTestId('niche-error')).toContainText('Connect an editor')
    // the words come back to send again later
    await expect(page.getByTestId('niche-input')).toHaveValue('Desk stretches')
    await snap(page, '10-niche-no-editor-1100x720')
    await page.getByTestId('niche-write-instead').click()
    const form = page.getByTestId('niche-form')
    await form.getByLabel('Who your reels are for').fill('Office workers with sore backs')
    await form.getByLabel('What they get from watching').fill('Two minute stretches they can do at their desk')
    await form.getByLabel(/Kinds of reel you make/).fill('One stretch, start to finish\nThe posture myth')
    await form.getByLabel(/Words to keep out/).fill('hack, biohacking')
    await page.getByTestId('niche-form-save').click()
    await expect(page.getByTestId('niche-who')).toHaveText('Office workers with sore backs')
    expect(JSON.parse(readFileSync(join(own, 'My niche.json'), 'utf8')).niche).toMatchObject({ angles: ['One stretch, start to finish', 'The posture myth'], avoid: ['hack', 'biohacking'] })
    await snap(page, '11-my-style-1100x720')
    // at the smallest window, nothing in the two sections runs past its right edge
    const past = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid=references] *, [data-testid=niche-section] *'))
        .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5)
        .map((el) => el.outerHTML.slice(0, 80))
    )
    expect(past).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})
