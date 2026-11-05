// WCAG AA in the built app (round 9.1): the timeline's note marks reach a screen reader, and every target a pointer
// can press is at least 24 by 24 px (2.5.8), on each screen and open popover. Chromium's own accessibility tree is
// read through the DevTools protocol, so the check is what VoiceOver gets, not what the markup suggests.
//
// Run: npm run build && npx playwright test e2e/a11y.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, openSettings, passFirstRun, toEditorStep } from './helpers'

const MINE = mkdtempSync(join(BASE, 'a11y-'))

/**
 * Targets on screen a pointer can't hit across 24 px both ways (WCAG 2.5.8). Measured by hit testing: the centre and
 * the points 11.5 px left, right, above and below it must all land on the control, so a small control with a larger
 * hit area (a ::after) counts what it really catches. A checkbox counts with its label, which presses it too. Text
 * links inside a sentence are exempt (2.5.8's inline exception), as are disabled controls.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=tab], [role^=menuitem], [tabindex="0"]'
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if ((el as HTMLButtonElement).disabled || el.closest('[inert], [aria-hidden="true"]')) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.pointerEvents === 'none' || Number(cs.opacity) === 0) continue
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue
      if (cs.display === 'inline' && (el.parentElement?.textContent ?? '').trim().length > (el.textContent ?? '').trim().length) continue
      const labels = Array.from((el as HTMLInputElement).labels ?? [])
      let ok: boolean
      if (labels.length) {
        const boxes = [r, ...labels.map((l) => l.getBoundingClientRect())]
        const w = Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left))
        const h = Math.max(...boxes.map((b) => b.bottom)) - Math.min(...boxes.map((b) => b.top))
        ok = w >= 24 && h >= 24
      } else {
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        // a point past the window's edge can't be hit-tested; scrolled into view, the rest of the control is there
        const hits = [[0, 0], [-11.5, 0], [11.5, 0], [0, -11.5], [0, 11.5]]
          .map(([dx, dy]) => [cx + dx, cy + dy])
          .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)
          .map(([x, y]) => document.elementFromPoint(x, y))
        // Under an open popover or menu it doesn't belong to, a control can't be pressed right now: it is measured on
        // the screen without that popover. (Windows' wider right inset puts Share's popover over the drag handle.)
        // Anything else over one of its points, a neighbour included, still counts against it.
        if (hits.some((hit) => { const layer = hit?.closest('[role=dialog], [role=menu]'); return !!layer && !layer.contains(el) })) continue
        ok = hits.every((hit) => !!hit && el.contains(hit))
      }
      if (!ok) out.push(`${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return out
  })
}

test('timeline marks are buttons a screen reader reaches, and no target is under 24 px', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  // the practice editor makes notes, so a note with a moment leaves its mark on the timeline
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(MINE, 'Reel Studio'), REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELSTUDIO_MOCK_NOTE: '300' })
  try {
    const small: Record<string, string[]> = {}
    const sweep = async (screen: string) => {
      await page.waitForTimeout(400)
      small[screen] = await smallTargets(page)
    }
    await sweep('welcome')
    await passFirstRun(page)
    await sweep('reels-empty')
    await makeReel(page, media.video)
    // Version 1 plays as it lands; pause it once it has started, so nothing starts it again after
    await expect.poll(() => page.getByTestId('player').evaluate((v: HTMLVideoElement) => !v.paused || v.ended)).toBe(true)
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid=player]') as HTMLVideoElement
      v.pause()
      v.currentTime = 1
    })
    // paused on 0:01, the note box has attached it by itself
    await expect(page.getByTestId('moment-chip')).toContainText('0:01')
    await page.getByTestId('note-input').fill('bigger subtitles here')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    await page.getByTestId('log-play-2').click()

    // fails if the marks sit inside the slider again: a slider's children are presentational, so nobody hears them
    const mark = page.getByTestId('timeline-mark').first()
    await expect(mark).toBeVisible()
    expect(await page.locator('[role=slider] [data-testid=timeline-mark]').count()).toBe(0)
    const cdp = await page.context().newCDPSession(page)
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: { role?: { value: string }; name?: { value: string }; ignored: boolean }[] }
    const marks = nodes.filter((n) => !n.ignored && n.role?.value === 'button' && /^Version 2, at 0:01: /.test(n.name?.value ?? ''))
    expect(marks.map((n) => n.name?.value)).toEqual([expect.stringContaining('bigger subtitles here')])
    // and the keyboard reaches it
    await page.getByTestId('timeline').focus()
    await page.keyboard.press('Tab')
    await expect(mark).toBeFocused()

    await sweep('reel-ready')
    await page.getByTestId('more').click()
    await sweep('reel-more-menu')
    await page.keyboard.press('Escape')
    await page.getByTestId('share').click()
    await sweep('share-open')
    await page.keyboard.press('Escape')
    await page.getByTestId('edit-myself').click()
    for (const t of ['cut', 'captions', 'music', 'broll', 'cover']) {
      const tab = page.getByTestId(`tab-${t}`)
      if (!(await tab.count())) continue
      await tab.click()
      await sweep(`edit-${t}`)
    }
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('new-reel').click()
    await sweep('reel-planned')
    await page.getByTestId('nav-home').click()
    await sweep('reels')
    await openSettings(page)
    await sweep('settings')
    await page.getByTestId('nav-library').click()
    await sweep('library')
    await page.getByTestId('nav-style').click()
    await sweep('my-style')
    expect(Object.entries(small).filter(([, v]) => v.length)).toEqual([])
  } finally {
    await app.close()
  }
})

test('the first run has no target under 24 px', async () => {
  const dir = mkdtempSync(join(BASE, 'a11y-first-'))
  const { app, page } = await launch({ REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_USER_DATA: join(dir, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready' })
  try {
    const small: Record<string, string[]> = {}
    small.welcome = await smallTargets(page)
    await page.getByTestId('get-started').click()
    await page.getByTestId('demo-skip').click()
    await page.waitForTimeout(400)
    small.sample = await smallTargets(page)
    await toEditorStep(page)
    await page.getByTestId('use-claude-code').waitFor()
    small.editor = await smallTargets(page)
    expect(Object.entries(small).filter(([, v]) => v.length)).toEqual([])
  } finally {
    await app.close()
  }
})

// fails if Tab reaches the screen's title row before the sidebar, stops on the sidebar's resize edge between the
// account row and the screen (audit-1028 finding 24), or the edge can no longer be reached and moved from the
// keyboard, or leaves focus nowhere on Esc or when the sidebar folds
test('Tab goes from the sidebar toggle down the sidebar, then to the title row; the resize edge has its own shortcut', async () => {
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: join(MINE, 'order-data'), REELSTUDIO_ROOT: join(MINE, 'order-root') })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-library').click()
    const addFiles = page.getByTestId('titlebar-actions').getByRole('button', { name: 'Add files' })
    await expect(addFiles).toBeVisible()
    await page.getByTestId('sidebar-toggle').focus()
    const order: string[] = []
    for (let i = 0; i < 20; i++) {
      order.push(await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        return el?.dataset.testid ?? el?.textContent?.trim() ?? ''
      }))
      if (await addFiles.evaluate((el) => el === document.activeElement)) break
      await page.keyboard.press('Tab')
    }
    expect(order.slice(0, 2)).toEqual(['sidebar-toggle', 'new-reel'])
    expect(order).not.toContain('sidebar-resize')
    // the account row is the sidebar's last stop; Add files, the title row's first control, comes next
    expect(order.slice(-2)).toEqual(['account', 'Add files'])

    // Cmd/Ctrl+Shift+\ focuses the edge, the arrow keys size the sidebar, Esc goes back to Add files, even after a
    // second press on the edge
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const edge = page.getByTestId('sidebar-resize')
    const toggle = page.getByTestId('sidebar-toggle')
    const width = Number(await edge.getAttribute('aria-valuenow'))
    await page.keyboard.press(`${mod}+Shift+Backslash`)
    await expect(edge).toBeFocused()
    await page.keyboard.press(`${mod}+Shift+Backslash`)
    await page.keyboard.press('ArrowRight')
    await expect(edge).toHaveAttribute('aria-valuenow', String(width + 8))
    await page.keyboard.press('Escape')
    await expect(addFiles).toBeFocused()

    // with nothing focusable to go back to (a click left focus on the page), Esc lands on the sidebar toggle
    await page.getByTestId('library-empty').click()
    await page.keyboard.press(`${mod}+Shift+Backslash`)
    await expect(edge).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(toggle).toBeFocused()

    // fails if the chord can only be found through the edge's accessibility label: on a Mac, View › Resize Sidebar
    // shows it and does the same
    if (process.platform === 'darwin') {
      await app.evaluate(({ Menu, BrowserWindow }) => Menu.getApplicationMenu()!.getMenuItemById('resize-sidebar')!.click({}, BrowserWindow.getAllWindows()[0], undefined))
      await expect(edge).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(toggle).toBeFocused()
    }

    // folding the sidebar while the edge has focus hands focus to the toggle instead of hiding it
    await page.keyboard.press(`${mod}+Shift+Backslash`)
    await expect(edge).toBeFocused()
    await page.keyboard.press(`${mod}+Backslash`)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    await page.keyboard.press(`${mod}+Backslash`)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await app.close()
  }
})
