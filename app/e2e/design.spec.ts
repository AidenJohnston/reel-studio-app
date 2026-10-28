// Design critique flows (docs/design-critique.md): toasts that leave by themselves, the whole-window
// drop target, the Working screen's time left and quiet Stop, the Reel screen's Instagram view, hold
// for Original, the ⋯ menu with a confirm, keyboard shortcuts, and the connected-AI states.
//
// Run: npx playwright test e2e/design.spec.ts (after npm run build). Same env as smoke.spec.ts.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, dropFiles, launch, makeMedia, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'design-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

/** Drops real files on the window itself (not on a drop zone), like dragging from Finder/Explorer. */
async function dropOnWindow(page: Page, paths: string[], release = true): Promise<void> {
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = true
    i.id = '__drop_source'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.locator('#__drop_source').setInputFiles(paths)
  await page.evaluate((drop) => {
    const src = document.getElementById('__drop_source') as HTMLInputElement
    const dt = new DataTransfer()
    for (const f of Array.from(src.files ?? [])) dt.items.add(f)
    const target = document.querySelector('.page') ?? document.body
    const types = drop ? ['dragenter', 'dragover', 'drop'] : ['dragenter', 'dragover']
    for (const type of types) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    src.remove()
  }, release)
}

/** Pretend an AI editor is signed in, for the screenshots of the connected states (no AI runs). */
async function stubConnected(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const p = { id: 'codex-cli', connected: true, label: 'ChatGPT (your Codex app)', detail: '0.164.0' }
    ipcMain.removeHandler('ai:active')
    ipcMain.handle('ai:active', async () => ({ ok: true, value: p }))
  })
}

function projectDir(): string {
  const dir = join(ROOT, 'Projects')
  return join(dir, readdirSync(dir)[0])
}

test('design: drop anywhere, working, reel tools, shortcuts, confirm dialogs, connected states', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)

  // ---- the whole window is a drop target ----
  await dropOnWindow(page, [media.video], false)
  await expect(page.getByTestId('drop-overlay')).toContainText('Drop to make a reel')
  await shot(page, 'd-01-drop-overlay')
  await page.evaluate(() => window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true })))
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await dropOnWindow(page, [media.video, media.picture])

  // ---- Working: first frame, time left, a quiet Stop that asks first ----
  await expect(page.getByText('Making your reel')).toBeVisible()
  // The picture went to the Library; that success toast leaves by itself and has no button.
  const toast = page.getByTestId('toast')
  await expect(toast).toContainText('Added 1 picture to your Library.')
  await expect(toast.locator('button')).toHaveCount(0)
  await expect(toast).toHaveCount(0, { timeout: 7000 })
  await expect(page.getByTestId('working-frame')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('stop').click()
  await expect(page.getByTestId('confirm')).toContainText('Stop making this reel?')
  await shot(page, 'd-02-stop-confirm')
  // Tab stays in the dialog (aria-modal): it used to walk into the page behind it.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('confirm').locator(':focus')).toHaveCount(1)
  }
  await page.keyboard.press('Escape') // Esc = the safe choice: keep going
  await expect(page.getByTestId('confirm')).toHaveCount(0)
  await expect(page.getByText('Making your reel')).toBeVisible()
  // Time left shows once there is enough to go on (the stand-in engine can finish before that).
  const left = page.getByTestId('time-left').filter({ hasText: /left|Almost done/ })
  await expect(left.or(page.getByTestId('player'))).toBeVisible({ timeout: 10 * 60_000 })
  if (await left.isVisible()) await shot(page, 'd-03-working-time-left')

  // ---- Reel: the finish moment (plays muted with "Tap for sound") ----
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByTestId('tap-for-sound')).toBeVisible()
  const fb = await app.evaluate(() => (globalThis as any).__reelFeedback)
  expect(fb.progress[fb.progress.length - 1]).toBe(-1) // taskbar progress cleared when done

  // Space plays and pauses.
  await page.getByTestId('tap-for-sound').click()
  await page.locator('body').click({ position: { x: 600, y: 10 } }).catch(() => {})
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const paused = () => page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).paused)
  const before = await paused()
  await page.keyboard.press('Space')
  await expect.poll(paused).toBe(!before)

  // Instagram view.
  await page.getByTestId('ig-toggle').click()
  await expect(page.getByTestId('ig-overlay')).toBeVisible()
  await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).pause())
  await shot(page, 'd-04-reel-instagram-view')
  await page.getByTestId('ig-toggle').click()
  await expect(page.getByTestId('ig-overlay')).toHaveCount(0)

  // Hold for original.
  const hold = page.getByTestId('hold-original')
  await hold.hover()
  await page.mouse.down()
  await expect(page.getByTestId('original-video')).toHaveClass(/on/)
  await shot(page, 'd-05-hold-original')
  await page.mouse.up()
  await expect(page.getByTestId('original-video')).not.toHaveClass(/on/)

  // The banner can be put away, for this video.
  await page.getByTestId('banner-close').click()
  await expect(page.getByTestId('ai-banner')).toHaveCount(0)

  // ---- drawer: Esc closes, Ctrl/Cmd+Z undoes ----
  await page.getByTestId('edit-myself').click()
  await expect(page.getByTestId('tab-cut')).toBeFocused() // not Close
  const firstWord = page.locator('.word').first()
  const wasCut = (await firstWord.getAttribute('class'))!.includes('cut')
  await firstWord.click()
  await expect(page.getByTestId('drawer-undo')).toBeVisible()
  await page.locator('.drawer-head h2').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
  await expect(page.getByTestId('drawer-undo')).toHaveCount(0)
  expect((await firstWord.getAttribute('class'))!.includes('cut')).toBe(wasCut)
  await page.getByTestId('tab-captions').click()
  await page.getByTestId('cap-look-box').click()
  await expect(page.getByTestId('sub-preview')).toBeVisible()
  await shot(page, 'd-06-drawer-subtitles-box')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('drawer')).toHaveCount(0)

  // ---- ⋯ menu: Delete asks first ----
  await page.getByTestId('more').click()
  await shot(page, 'd-07-more-menu')
  await page.getByTestId('delete').click()
  await expect(page.getByTestId('confirm')).toContainText('Delete this video?')
  await expect(page.getByTestId('confirm-no')).toBeFocused() // the safe choice
  await shot(page, 'd-08-delete-confirm')
  await page.getByTestId('confirm-no').click()
  await expect(page.getByTestId('player')).toBeVisible()

  // ---- Ctrl+E exports (Windows; on a Mac the File menu owns Cmd+E) ----
  if (process.platform !== 'darwin') {
    await page.keyboard.press('Control+E')
    await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 120_000 })
    await page.getByTestId('export-caption').fill('Three things I wish I knew')
    await page.getByTestId('copy-caption').click()
    await expect(page.getByTestId('copy-caption')).toHaveText('Copied')
    await shot(page, 'd-09-export-with-caption')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('export-dialog')).toHaveCount(0)
    // The caption typed in the export box is saved with the video.
    await expect.poll(() => JSON.parse(readFileSync(join(projectDir(), 'project.json'), 'utf8')).post.caption).toBe('Three things I wish I knew')
    await expect(page.getByTestId('did-post')).toContainText('Your post caption')
  }

  // ---- connected states (AI stubbed as signed in; nothing runs) ----
  await stubConnected(app)
  const appJson = join(projectDir(), 'app.json')
  const st = JSON.parse(readFileSync(appJson, 'utf8'))
  st.aiEdited = true
  writeFileSync(appJson, JSON.stringify(st, null, 2))
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('ai-connected-banner')).toContainText('Using ChatGPT through your Codex app.')
  await expect(page.getByTestId('connect-claude')).toHaveCount(0) // folded away
  await expect(page.getByTestId('use-different-ai')).toBeVisible()
  await expect(page.getByTestId('root-display')).toContainText('Reel Studio')
  await expect(page.getByTestId('root-display')).not.toContainText('~')
  await shot(page, 'd-10-settings-connected')
  await page.getByTestId('use-different-ai').click()
  await expect(page.getByTestId('connect-claude')).toBeVisible()
  await expect(page.getByTestId('vendor-chatgpt')).toHaveCount(0) // the one in use is not offered again
  await shot(page, 'd-11-settings-different-ai')
  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('ai-status')).toContainText('AI editor: ChatGPT')
  // With an AI editor on, the no-AI controls must never be drawn, not even for the first frame.
  await page.evaluate(() => {
    ;(window as any).__sawNoAi = false
    new MutationObserver(() => {
      if (document.querySelector('[data-testid=composer-connect],[data-testid=ai-banner]')) (window as any).__sawNoAi = true
    }).observe(document.body, { subtree: true, childList: true })
  })
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('player')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__sawNoAi)).toBe(false)
  await expect(page.getByTestId('did-cut')).toContainText('Kept your best takes')
  await expect(page.getByTestId('ai-banner')).toHaveCount(0)
  await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', 'Tell your editor what to change…')
  await shot(page, 'd-12-reel-with-ai')

  // ---- AI detection that has not answered: the reel still opens at once, only the note box waits ----
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:active')
    const g = globalThis as any
    g.__aiWaiting = []
    ipcMain.handle('ai:active', () => new Promise((answer) => g.__aiWaiting.push(answer)))
  })
  await page.getByTestId('nav-home').click()
  const opened = Date.now()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 1000 })
  await expect(page.getByTestId('export')).toBeEnabled({ timeout: 1000 })
  await expect(page.getByTestId('edit-myself')).toBeEnabled({ timeout: 1000 })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const wasPaused = await paused()
  await page.keyboard.press('Space') // plays or pauses, like on a reel opened normally
  await expect.poll(paused, { timeout: 1000 }).toBe(!wasPaused)
  expect(Date.now() - opened).toBeLessThan(1000)
  await expect(page.getByTestId('note-input')).toBeDisabled()
  await expect(page.getByTestId('ai-banner')).toHaveCount(0)
  await expect(page.getByTestId('composer-connect')).toHaveCount(0)
  // A picture dropped on the note box meanwhile is held: nothing can be sent until the check answers...
  await dropFiles(page, 'note-drop', [media.picture])
  await expect(page.getByTestId('note-attachment-busy')).toBeVisible()
  await page.waitForTimeout(2000) // a picture copies in about 0.2 s, so an early attach would have landed by now
  await expect(page.getByTestId('note-attachment')).toHaveCount(0)
  await expect(page.getByTestId('send')).toBeDisabled()
  // ...then it is attached like any drop.
  await app.evaluate(() => {
    for (const answer of (globalThis as any).__aiWaiting) answer({ ok: true, value: { id: 'chatgpt', connected: true, label: 'ChatGPT', detail: '' } })
  })
  await expect(page.getByTestId('note-attachment')).toHaveCount(1)
  await expect(page.getByTestId('send')).toBeEnabled()
  await page.getByTestId('note-attachment-remove').click()
  await stubConnected(app)

  // ---- Library: a drop anywhere on the window lands in the Library ----
  await page.getByTestId('nav-library').click()
  await dropOnWindow(page, [media.song], false)
  await expect(page.getByTestId('drop-overlay')).toContainText('Drop to add to your Library')
  await page.evaluate(() => window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true })))
  await dropOnWindow(page, [media.song])
  await expect(page.getByTestId('toast')).toContainText('Added 1 song to your Library.')
  await expect(page.getByTestId('bin-music')).toContainText('happy song')
  await shot(page, 'd-13-library-after-drop')
  await app.close()
})
