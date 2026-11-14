// The shared Modal (components/ui.tsx) makes the page behind an open dialog inert, keeps toasts usable (by mouse and,
// through Tab, by keyboard), makes
// what appears behind it while it is open inert too, and gives the page back when it closes.
// The redesign opens one dialog at a time (Share and Export are popovers), so #77's nested-dialog steps have
// no way in from the screens and are left out.
//
// Run: npx playwright test e2e/dialog.spec.ts (after npm run build). Same env as smoke.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { launch, makeMedia, makeReel, passFirstRun } from './helpers'

/** Drags files over the element matching `selector`, without letting go. */
async function dragOver(page: Page, selector: string, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = true
    i.id = '__drop_source'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.locator('#__drop_source').setInputFiles(paths)
  await page.evaluate((selector) => {
    const src = document.getElementById('__drop_source') as HTMLInputElement
    const dt = new DataTransfer()
    for (const f of Array.from(src.files ?? [])) dt.items.add(f)
    const target = document.querySelector(selector)!
    for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    src.remove()
  }, selector)
}

/** Whether the element is inside an inert subtree (the `inert` property itself is not inherited). */
const inert = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => !!el.closest('[inert]'))

test('dialogs: the page behind is inert, toasts stay usable, the page comes back when the dialog closes', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)

    const toast = page.getByTestId('toast')
    const confirm = page.getByTestId('confirm')

    await test.step('an error toast shown before the dialog stays closable', async () => {
      // a paste whose files can't be read says so in an error toast (App.tsx)
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('app:clipboardFiles')
        ipcMain.handle('app:clipboardFiles', () => ({ ok: false, error: { code: 'TEST', userMessage: 'The pasted files could not be read.' } }))
      })
      await page.evaluate(() => document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })))
      await expect(toast).toContainText('The pasted files could not be read.')
      await page.getByTestId('more').click()
      await page.getByTestId('delete').click()
      await expect(confirm).toContainText('Delete this reel?')
      expect(await inert(page, 'toast')).toBe(false)
      await toast.getByRole('button', { name: 'Close' }).click()
      await expect(toast).toHaveCount(0)
      await expect(confirm).toBeVisible()
    })

    await test.step("Tab and Shift+Tab reach the error toast's buttons and come back into the dialog (#118)", async () => {
      await page.evaluate(() => document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })))
      await expect(toast).toContainText('The pasted files could not be read.')
      await page.getByTestId('confirm-no').focus()
      const close = toast.getByRole('button', { name: 'Close' })
      await page.keyboard.press('Shift+Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('confirm-no')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('confirm-yes')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('toast-action')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(toast).toHaveCount(0)
      await expect(confirm).toBeVisible()
    })

    await test.step('the page behind the dialog takes no focus', async () => {
      expect(await inert(page, 'nav-home')).toBe(true)
      await page.getByTestId('confirm-no').focus()
      await page.getByTestId('nav-home').focus()
      await expect(page.getByTestId('confirm-no')).toBeFocused()
    })

    await test.step('what appears while the dialog is open: the drop overlay is inert, a new toast is not', async () => {
      await dragOver(page, '[data-testid=confirm]', [media.picture])
      await expect(page.getByTestId('drop-overlay')).toBeVisible()
      await expect.poll(() => inert(page, 'drop-overlay')).toBe(true)
      await page.evaluate(() => window.dispatchEvent(new DragEvent('dragleave', { bubbles: true })))
      await page.evaluate(() => document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })))
      await expect(toast).toContainText('The pasted files could not be read.')
      expect(await inert(page, 'toast')).toBe(false)
      await toast.getByRole('button', { name: 'Close' }).click()
      await expect(toast).toHaveCount(0)
      await expect(confirm).toBeVisible()
    })

    await test.step('after the dialog closes, the page works again', async () => {
      await page.getByTestId('confirm-no').click()
      await expect(confirm).toHaveCount(0)
      expect(await inert(page, 'nav-home')).toBe(false)
      await page.getByTestId('nav-home').focus()
      await expect(page.getByTestId('nav-home')).toBeFocused()
      await page.getByTestId('nav-library').click()
      await expect(page.getByTestId('nav-library')).toHaveAttribute('aria-current', 'page')
    })
  } finally {
    await app.close()
  }
})
