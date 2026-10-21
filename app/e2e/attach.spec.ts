// Pictures on a note (0.1.2 F2), end to end in the built app with the stand-in engine (dev/fake-engine,
// whose `attach` takes JPG/PNG only) and NO AI connected: a plain text paste stays text, a pasted
// screenshot (bytes, no file), a file dropped on the note box (and a video dropped there does NOT start a
// new reel), the paperclip, at most four, remove, Send, the "you" bubble with its thumbnails, and the
// honest no-AI answer.
//
// Run: npm run build && npx playwright test e2e/attach.spec.ts
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, dropFiles, launch, makeMedia, passFirstRun, shot } from './helpers'

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
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 240_000 })
  expect(projects()).toHaveLength(1)
  const slug = projects()[0]

  // ---- a plain text paste is left to the box ----
  const handledText = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="note-input"]') as HTMLTextAreaElement
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
    const box = document.querySelector('[data-testid="note-input"]') as HTMLTextAreaElement
    return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, png)
  expect(handledPic).toBe(true)
  await expect(page.getByTestId('note-attachment')).toHaveCount(1)
  await expect(page.getByTestId('note-attachment').first()).toContainText('image.png')
  await expect(page.getByTestId('note-attachment').first().locator('img')).toBeVisible()

  // ---- a file dropped on the note box is attached; nothing new starts ----
  await dropFiles(page, 'note-drop', [pics[1]])
  await expect(page.getByTestId('note-attachment')).toHaveCount(2)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  // a video dropped on the note box is NOT a new reel (the stand-in engine refuses it as an attachment)
  await dropFiles(page, 'note-drop', [media.video])
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

  // ---- Send: a note can be only files; the bubble shows them; no AI = an honest answer ----
  await expect(page.getByTestId('send')).toBeEnabled()
  await page.getByTestId('send').click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(0)
  const bubble = page.getByTestId('bubble-you').last()
  await expect(bubble.getByTestId('bubble-attachments').locator('img')).toHaveCount(3)
  await expect(page.getByTestId('bubble-editor').last()).toContainText("I can't put your files in the video yet")
  await expect(page.getByTestId('action-open-broll').last()).toBeVisible()
  await shot(page, 'attach-02-sent')
  await app.close()
})
