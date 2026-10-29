// The shared Modal (components/ui.tsx) makes the page behind an open dialog inert, keeps toasts usable,
// and gives the page back only when the last open dialog closes.
//
// Run: npx playwright test e2e/dialog.spec.ts (after npm run build). Same env as smoke.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { launch, makeMedia, passFirstRun } from './helpers'

/** Drags files over the element matching `selector` and, if `release`, drops them there. */
async function dragFiles(page: Page, selector: string, paths: string[], release: boolean): Promise<void> {
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = true
    i.id = '__drop_source'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.locator('#__drop_source').setInputFiles(paths)
  await page.evaluate(
    ({ selector, release }) => {
      const src = document.getElementById('__drop_source') as HTMLInputElement
      const dt = new DataTransfer()
      for (const f of Array.from(src.files ?? [])) dt.items.add(f)
      const target = document.querySelector(selector)!
      for (const type of release ? ['dragenter', 'dragover', 'drop'] : ['dragenter', 'dragover'])
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
      src.remove()
    },
    { selector, release }
  )
}

/** Whether the element is inside an inert subtree (the `inert` property itself is not inherited). */
const inert = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => !!el.closest('[inert]'))

test('dialogs: the page behind is inert, toasts stay usable, the page comes back after the last dialog', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('new-video').click()
    await page.getByTestId('file-input').setInputFiles([media.video])
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 5 * 60_000 })

    const toast = page.getByTestId('toast')
    const confirm = page.getByTestId('confirm')
    const exportDialog = page.getByTestId('export-dialog')
    const openDelete = async () => {
      await page.getByTestId('more').click()
      await page.getByTestId('delete').click()
      await expect(confirm).toContainText('Delete this video?')
      await expect(page.getByTestId('confirm-no')).toBeFocused()
    }
    // Cmd/Ctrl+E and File > Export send this event (App.tsx); it opens the Export dialog over the confirm.
    const openExportOnTop = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('reel:export')))
      await expect(exportDialog).toContainText('Saved to your computer', { timeout: 120_000 })
    }

    await test.step('an error toast shown before the dialog stays closable', async () => {
      await dragFiles(page, 'main', [media.picture], true)
      await expect(toast).toContainText('Drop a video file')
      await openDelete()
      expect(await inert(page, 'toast')).toBe(false)
      await toast.getByRole('button', { name: 'Close' }).click()
      await expect(toast).toHaveCount(0)
      await expect(confirm).toBeVisible()
    })

    await test.step('the page behind the dialog takes no focus', async () => {
      expect(await inert(page, 'nav-settings')).toBe(true)
      await page.getByTestId('confirm-no').focus()
      await page.getByTestId('nav-settings').focus()
      await expect(page.getByTestId('confirm-no')).toBeFocused()
    })

    await test.step('a node added while the dialog is open: the drop overlay is inert, a new toast is not', async () => {
      await dragFiles(page, '[data-testid=confirm]', [media.picture], false)
      await expect(page.getByTestId('drop-overlay')).toBeVisible()
      await expect.poll(() => inert(page, 'drop-overlay')).toBe(true)
      await dragFiles(page, '[data-testid=confirm]', [media.picture], true)
      await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
      await expect(toast).toContainText('Drop a video file')
      expect(await inert(page, 'toast')).toBe(false)
      await toast.getByRole('button', { name: 'Close' }).click()
      await expect(toast).toHaveCount(0)
      await expect(confirm).toBeVisible()
    })

    await test.step('nested dialogs, the inner one closed first: the page stays inert until the outer one closes', async () => {
      await openExportOnTop()
      expect(await inert(page, 'confirm')).toBe(true) // the outer dialog is behind the inner one
      await exportDialog.getByRole('button', { name: 'Done' }).click()
      await expect(exportDialog).toHaveCount(0)
      expect(await inert(page, 'confirm')).toBe(false)
      expect(await inert(page, 'nav-settings')).toBe(true)
      await page.getByTestId('confirm-no').click()
      await expect(confirm).toHaveCount(0)
      expect(await inert(page, 'nav-settings')).toBe(false)
    })

    await test.step('nested dialogs, the outer one closed first: the page stays inert until the inner one closes', async () => {
      await openDelete()
      await openExportOnTop()
      // The outer dialog is inert, so nothing a person can do closes it now; close it from code, as a
      // dialog that closes by itself would.
      await page.getByTestId('confirm-no').dispatchEvent('click')
      await expect(confirm).toHaveCount(0)
      expect(await inert(page, 'nav-settings')).toBe(true)
      await page.getByTestId('nav-settings').focus()
      await expect(page.getByTestId('nav-settings')).not.toBeFocused()
      await exportDialog.getByRole('button', { name: 'Done' }).click()
      await expect(exportDialog).toHaveCount(0)
    })

    await test.step('after the last dialog closes, the page works again', async () => {
      expect(await inert(page, 'nav-settings')).toBe(false)
      await page.getByTestId('nav-settings').focus()
      await expect(page.getByTestId('nav-settings')).toBeFocused()
      await page.getByTestId('nav-library').click()
      await expect(page.getByTestId('nav-library')).toHaveAttribute('aria-current', 'page')
    })
  } finally {
    await app.close()
  }
})
