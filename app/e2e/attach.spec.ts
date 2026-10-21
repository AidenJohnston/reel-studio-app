// Pictures on a note (0.1.2 F2), end to end in the built app with the stand-in engine (dev/fake-engine,
// whose `attach` takes JPG/PNG only) and the stand-in AI editor connected: in the change pop-up under the
// player, a plain text paste stays text, a pasted screenshot (bytes, no file), a file dropped on the pop-up
// (and a video dropped there does NOT start a new reel), the paperclip, at most four, remove, send, the
// "you" bubble with its thumbnails and the note's mark on the scrub bar.
//
// Run: npm run build && npx playwright test e2e/attach.spec.ts
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, chooseClaudeCode, dropFiles, launch, makeMedia, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'attach-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const projects = (): string[] => readdirSync(join(ROOT, 'Projects')).filter((s) => !s.startsWith('.'))
const assetsOf = (slug: string): string[] => readdirSync(join(ROOT, 'Projects', slug, 'work', 'assets')).filter((f) => f.startsWith('attach-'))

test('note attachments: paste, drop, paperclip, chips, send', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const pics = [1, 2, 3].map((i) => {
    const p = join(MINE, `meme ${i} ü.png`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${['ff0000', '00aa00', '0000ff'][i - 1]}:size=300x200`, '-frames:v', '1', p])
    return p
  })
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready' })
  await passFirstRun(page)
  await page.getByTestId('nav-settings').click()
  expect(await chooseClaudeCode(page)).toBe(true)
  await page.getByTestId('nav-home').click()
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
  expect(projects()).toHaveLength(1)
  const slug = projects()[0]
  await page.getByTestId('change-at').click()
  // the words on screen at the playhead, read from this render's timeline
  await expect(page.getByTestId('change-context')).toContainText('Around "')

  // ---- a plain text paste is left to the box ----
  const handledText = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="change-input"]') as HTMLTextAreaElement
    const dt = new DataTransfer()
    dt.setData('text/plain', 'make it louder')
    return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  expect(handledText).toBe(false)

  // ---- a pasted screenshot: bytes with no file behind them ----
  const png = readFileSync(pics[0]).toString('base64')
  const handledPic = await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    const box = document.querySelector('[data-testid="change-input"]') as HTMLTextAreaElement
    return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, png)
  expect(handledPic).toBe(true)
  await expect(page.getByTestId('note-attachment')).toHaveCount(1)
  await expect(page.getByTestId('note-attachment').first()).toContainText('image.png')
  await expect(page.getByTestId('note-attachment').first().locator('img')).toBeVisible()

  // ---- a file dropped on the pop-up is attached; nothing new starts ----
  await dropFiles(page, 'change-pop', [pics[1]])
  await expect(page.getByTestId('note-attachment')).toHaveCount(2)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  // a video dropped on the pop-up is NOT a new reel (the stand-in engine refuses it as an attachment)
  await dropFiles(page, 'change-pop', [media.video])
  await expect(page.getByTestId('toast')).toContainText("That file type isn't supported")
  expect(projects()).toEqual([slug])
  await expect(page.getByTestId('player')).toBeVisible()
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click()

  // ---- the paperclip (the native picker is answered from main) ----
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: f })
  }, [pics[2], pics[0]])
  await page.getByTestId('note-attach').click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(4)
  await shot(page, 'attach-01-chips')
  // a fifth does not fit
  await page.getByTestId('note-attach').click()
  await expect(page.getByTestId('toast')).toContainText('up to 4 files')
  await expect(page.getByTestId('note-attachment')).toHaveCount(4)
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click()
  expect(assetsOf(slug).filter((f) => !f.endsWith('.json'))).toHaveLength(4)

  // ---- remove one: its file, sidecar and still go ----
  await page.getByTestId('note-attachment-remove').nth(3).click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(3)
  await expect.poll(() => assetsOf(slug).filter((f) => !f.endsWith('.json')).length).toBe(3)
  expect(assetsOf(slug).filter((f) => f.endsWith('.attach.json'))).toHaveLength(3)

  // ---- a typed time past the end is caught in the pop-up, not sent ----
  await page.getByTestId('change-input').fill('At 9:00: zoom in here')
  await page.getByTestId('change-send').click()
  await expect(page.getByTestId('change-alert')).toContainText("There's no 9:00 in this video")
  await page.getByTestId('change-input').fill('')

  // ---- send: a note can be only files, at this moment; the bubble shows them; the moment gets a mark ----
  await expect(page.getByTestId('change-send')).toBeEnabled()
  await page.getByTestId('change-send').click()
  await expect(page.getByTestId('change-pop')).toHaveCount(0)
  const bubble = page.getByTestId('bubble-you').last()
  await expect(bubble).toContainText(/^At 0:00 \(around "[^"]+", words w0, w1, w2\): Put this here$/)
  await expect(bubble.getByTestId('bubble-attachments').locator('img')).toHaveCount(3)
  await expect(page.getByTestId('bubble-editor').last()).toContainText('I saved your note')
  // the stand-in AI makes no new version, so the note did not change the video
  await expect(page.getByTestId('scrub-mark')).toHaveAttribute('data-state', 'failed')
  // the next note starts empty
  await page.getByTestId('change-at').click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(0)
  await shot(page, 'attach-02-sent')
  await app.close()
})
