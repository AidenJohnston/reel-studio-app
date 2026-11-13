// Pictures on a note (0.1.2 F2), end to end in the built app with the stand-in engine (dev/fake-engine,
// whose `attach` takes JPG/PNG only) and the stand-in AI editor connected: in the change pop-up under the
// player, a plain text paste stays text, a pasted screenshot (bytes, no file), a file dropped on the pop-up
// (and a video dropped there does NOT start a new reel), the paperclip, at most four, remove, send, the
// "you" bubble with its thumbnails and the note's mark on the scrub bar. Then the same paste, drop and
// paperclip on the note box in the Notes panel, and a send from there.
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
  // the reel autoplays on arrival: hold it at 0:00, so the moment and its words are the same every run
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid=player]') as HTMLVideoElement
    v.pause()
    v.currentTime = 0
  })
  await expect(page.getByTestId('change-at')).toContainText('0:00')
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
  const pasteScreenshot = (testid: string): Promise<boolean> =>
    page.evaluate(
      ([b64, id]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
        const box = document.querySelector(`[data-testid="${id}"]`) as HTMLTextAreaElement
        return !box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      },
      [png, testid]
    )
  expect(await pasteScreenshot('change-input')).toBe(true)
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
  await page.getByTestId('change-attach').click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(4)
  await shot(page, 'attach-01-chips')
  // a fifth does not fit
  await page.getByTestId('change-attach').click()
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
  // the person sees the time and their words; the AI reads the words on screen by id
  await expect(bubble).toContainText(/^0:00 Put this here"[^"]+"$/)
  await expect(bubble).not.toContainText('w0')
  // the moment is stored with the word ids main read off this render (the AI's text is built from it)
  const sent = JSON.parse(readFileSync(join(ROOT, 'Projects', slug, 'app.json'), 'utf8')).chat.filter((m: { from: string }) => m.from === 'you').at(-1)
  expect([sent.text, sent.moment.at, sent.moment.words]).toEqual(['Put this here', 0, ['w0', 'w1', 'w2']])
  await expect(bubble.getByTestId('bubble-attachments').locator('img')).toHaveCount(3)
  // Whatever the stand-in AI answers, it makes no new version, so the note's mark says it didn't work.
  await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('scrub-mark')).toHaveAttribute('data-state', 'failed')
  // a screen reader hears the state apart from the request; the mark sits where its middle word plays (w1)
  await expect(page.getByTestId('scrub-mark')).toHaveAttribute('aria-label', "Didn't work, 0:01: Put this here")
  // the next note starts empty
  await page.getByTestId('change-at').click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(0)
  await shot(page, 'attach-02-sent')

  // ---- the note box in the Notes panel takes files the same ways: paste, drop, paperclip, send ----
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('change-pop')).toHaveCount(0)
  expect(await pasteScreenshot('note-input')).toBe(true)
  await expect(page.getByTestId('note-attachment')).toHaveCount(1)
  await dropFiles(page, 'note-drop', [pics[1]])
  await expect(page.getByTestId('note-attachment')).toHaveCount(2)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  // a video dropped on the note box is not a new reel either
  await dropFiles(page, 'note-drop', [media.video])
  await expect(page.getByTestId('toast')).toContainText("That file type isn't supported")
  expect(projects()).toEqual([slug])
  await page.getByTestId('toast').getByRole('button', { name: 'Close' }).click()
  await page.getByTestId('note-attach').click() // the dialog stub above picks two more
  await expect(page.getByTestId('note-attachment')).toHaveCount(4)
  await page.getByTestId('send').click()
  await expect(page.getByTestId('note-attachment')).toHaveCount(0)
  await expect(page.getByTestId('bubble-you').last().getByTestId('bubble-attachments').locator('img')).toHaveCount(4)
  await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 60_000 })

  // ---- fails if the pop-up takes typing while its note is sending: a sent note clears the box, so
  // those words were lost. The note is held in main until the check is done. ----
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('projects:note')
    const waiting: ((v: unknown) => void)[] = []
    ;(globalThis as { __noteWaiting?: typeof waiting }).__noteWaiting = waiting
    ipcMain.handle('projects:note', () => new Promise((answer) => waiting.push(answer)))
  })
  await page.getByTestId('change-at').click()
  await page.getByTestId('scope-whole').check()
  await page.getByTestId('change-input').fill('zoom in on my face')
  await page.getByTestId('change-send').click()
  await expect(page.getByTestId('change-pop')).toHaveAttribute('aria-busy', 'true')
  await page.getByTestId('change-input').click()
  await page.keyboard.type(' and cut the pause')
  await expect(page.getByTestId('change-input')).toHaveValue('zoom in on my face')
  await expect(page.getByTestId('change-attach')).toBeDisabled()
  await app.evaluate(() => {
    for (const answer of (globalThis as { __noteWaiting?: ((v: unknown) => void)[] }).__noteWaiting ?? [])
      answer({ ok: true, value: { jobId: null } })
  })
  await expect(page.getByTestId('change-pop')).toHaveCount(0)
  await app.close()
})
