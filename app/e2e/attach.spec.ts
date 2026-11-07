// Pictures on a note (0.1.2 F2), end to end in the built app with the stand-in engine (dev/fake-engine,
// whose `attach` takes JPG/PNG only) and the stand-in AI editor connected: in the note box in the notes
// column, a plain text paste stays text, a pasted screenshot (bytes, no file), a file dropped on the box
// (and a video dropped there does NOT start a new reel), the paperclip, at most four, remove, send, and the
// "you" bubble with its moment and thumbnails.
//
// Run: npm run build && npx playwright test e2e/attach.spec.ts
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, chooseClaudeCode, dropFiles, launch, makeMedia, makeReel, passFirstRun, shot, openSettings } from './helpers'

const MINE = mkdtempSync(join(BASE, 'attach-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const projects = (): string[] => readdirSync(join(ROOT, 'Projects')).filter((s) => !s.startsWith('.'))
const USER_DATA = join(MINE, 'user data')
/**
 * The attachment files of a note not sent yet. They wait in the app's note staging (main/attachments.ts attachDir,
 * one folder per reel under user data) and move into the reel's work/assets when the note runs, so both are read.
 */
const assetsOf = (slug: string): string[] => {
  const staging = join(USER_DATA, 'note-staging')
  const dirs = [join(ROOT, 'Projects', slug, 'work', 'assets'), ...(existsSync(staging) ? readdirSync(staging).map((d) => join(staging, d, 'work', 'assets')) : [])]
  return dirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d)).filter((f) => f.startsWith('attach-'))
}

test('note attachments: paste, drop, paperclip, chips, send', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const pics = [1, 2, 3].map((i) => {
    const p = join(MINE, `meme ${i} ü.png`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${['ff0000', '00aa00', '0000ff'][i - 1]}:size=300x200`, '-frames:v', '1', p])
    return p
  })
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: USER_DATA, REELSTUDIO_MOCK_CLAUDE: 'ready' })
  await passFirstRun(page)
  await openSettings(page)
  expect(await chooseClaudeCode(page)).toBe(true)
  await page.getByTestId('nav-home').click()
  await makeReel(page, media.video)
  expect(projects()).toHaveLength(1)
  const slug = projects()[0]
  // the reel autoplays on arrival: hold it at 0:00 once it has started, so the moment and its words are the same
  // every run
  await expect.poll(() => page.getByTestId('player').evaluate((v: HTMLVideoElement) => !v.paused || v.ended)).toBe(true)
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid=player]') as HTMLVideoElement
    v.pause()
    v.currentTime = 0
  })
  // pausing on a moment attaches it by itself; its × leaves the offer, which attaches it again in one click
  await expect(page.getByTestId('moment-chip')).toHaveAttribute('data-auto', 'true')
  await expect(page.getByTestId('moment-chip')).toContainText('0:00')
  await page.getByTestId('moment-remove').click()
  await expect(page.getByTestId('moment-suggest')).toContainText('0:00')
  await page.getByTestId('moment-suggest').click()
  await expect(page.getByTestId('moment-chip')).toContainText('0:00')
  await expect(page.getByTestId('moment-chip')).not.toHaveAttribute('data-auto')

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

  // ---- a typed time past the end is caught in the note box, not sent, and nothing is lost ----
  await page.getByTestId('note-input').fill('At 9:00: zoom in here')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('change-alert')).toContainText("There's no 9:00 in this reel")
  await expect(page.getByTestId('note-attachment')).toHaveCount(3)
  await expect(page.getByTestId('moment-chip')).toContainText('0:00')
  await page.getByTestId('note-input').fill('')

  // ---- send: a note can be only files, at this moment; the bubble shows them ----
  await expect(page.getByTestId('send')).toBeEnabled()
  await page.getByTestId('send').click()
  await expect(page.getByTestId('moment-chip')).toHaveCount(0)
  const bubble = page.getByTestId('log-note').last()
  // the person sees the time and their words; the AI reads the words on screen by id
  await expect(bubble.locator('.bubble')).toHaveText(/^0:00Put this here$/)
  await expect(bubble).not.toContainText('w0')
  // the moment is stored with the word ids main read off this render (the AI's text is built from it)
  const sent = JSON.parse(readFileSync(join(ROOT, 'Projects', slug, 'app.json'), 'utf8')).chat.filter((m: { from: string }) => m.from === 'you').at(-1)
  expect([sent.text, sent.moment.at, sent.moment.words]).toEqual(['Put this here', 0, ['w0', 'w1', 'w2']])
  await expect(bubble.locator('.q-att img')).toHaveCount(3)
  await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 60_000 })
  // the next note starts empty
  await expect(page.getByTestId('note-attachment')).toHaveCount(0)
  await shot(page, 'attach-02-sent')

  // ---- the moment goes with the note when the person stopped on it, or when the note says "here" ----
  // fails if a note sent after pausing, or one that says "this part", goes out with no moment (10-28 audit, finding 3)
  const player = page.getByTestId('player')
  const holdAtStart = async () => {
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => !v.paused || v.ended)).toBe(true)
    await player.evaluate((v: HTMLVideoElement) => {
      v.pause()
      v.currentTime = 0
    })
  }
  await holdAtStart()
  await expect(page.getByTestId('moment-chip')).toHaveAttribute('data-auto', 'true')
  await page.getByTestId('note-input').fill('make the subtitles bigger')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('log-note').last().locator('.bubble')).toHaveText(/^0:00make the subtitles bigger$/)
  await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 60_000 })
  await holdAtStart()
  await page.getByTestId('moment-remove').click()
  await expect(page.getByTestId('moment-suggest')).toContainText('0:00')
  await page.getByTestId('note-input').fill('cut this part')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('log-note').last().locator('.bubble')).toHaveText(/^0:00cut this part$/)
  await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 60_000 })
  await app.close()
})
