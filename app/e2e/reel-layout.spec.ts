import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launch, makeMedia, makeReel, passFirstRun } from './helpers'

const SIZES: [number, number][] = [
  [1100, 720],
  [1280, 820],
  [1512, 982],
  [1920, 1080]
]

async function setSize(app: ElectronApplication, page: Page, [w, h]: [number, number]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([w, h])
}

const box = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  })

// BRIEF layout rule 1: at 1920x1080 play and the time sat in the stage's left corner and the view switch in its right,
// 700 px from a 530 px phone; once under it, the shape pill was cut to "W…".
test('fails if the play controls and timeline are not centred under the phone, or a control in their row is cut short', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_MOCK_CLAUDE: 'ready' }, { realViewport: true })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    for (const size of SIZES) {
      await setSize(app, page, size)
      // one snapshot of the stage: the reel is still settling (the phone takes its size a frame after the window, the
      // row follows it), so it is read until it holds; a real break never does
      const problems = () =>
        page.evaluate(() => {
          const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
          const phone = r('.stage-v .phone')
          const row = r('.stage > .transport')
          const line = r('.stage > .tl')
          const out: string[] = []
          if (Math.abs((row.left + row.right) / 2 - (phone.left + phone.right) / 2) >= 2) out.push(`row centre off the phone's by ${Math.round((row.left + row.right) / 2 - (phone.left + phone.right) / 2)} px`)
          if (row.width > Math.max(phone.width, 440) + 1) out.push(`row ${Math.round(row.width)} px wide under a ${Math.round(phone.width)} px phone`)
          if (Math.abs(line.right - row.right) >= 2) out.push(`timeline ends ${Math.round(line.right - row.right)} px from the row`)
          const kids = Array.from(document.querySelectorAll<HTMLElement>('.stage > .transport .tr-row > *'))
          for (const k of kids) if (k.getBoundingClientRect().right > row.right + 1) out.push(`${k.className} runs past the row`)
          for (const c of Array.from(document.querySelectorAll<HTMLElement>('.stage > .transport *')))
            if (c.offsetParent !== null && c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow !== 'visible') out.push(`"${c.textContent}" is cut short`)
          return out
        })
      await expect.poll(problems, { message: `${size[0]}x${size[1]}` }).toEqual([])
    }
    // design review r12: three lane icons beside one drawn lane read as a puzzle; only a lane with something on it
    // gets its icon. This reel has only its video (no pictures or sounds are drawn).
    await expect(page.locator('.tl-pic, .tl-sound')).toHaveCount(0)
    await expect(page.getByTestId('lane-gutter').locator('[title]')).toHaveCount(1)
    await expect(page.getByTestId('lane-gutter').locator('[title]')).toHaveAttribute('title', 'Your video')
    // the drag-out grip shows over the phone only, not wherever the pointer is on the stage
    const grip = page.getByTestId('drag-handle')
    await page.getByTestId('time').hover()
    await expect.poll(() => grip.evaluate((g) => getComputedStyle(g).opacity)).toBe('0')
    await page.getByTestId('phone').hover()
    await expect.poll(() => grip.evaluate((g) => getComputedStyle(g).opacity)).toBe('1')
  } finally {
    await app.close()
  }
})

// The layout audit's small-target findings (r12): words in Cut were 22 px tall, the cover slider 16 px, Settings' links 16 px.
test('fails if a word in Cut, the cover slider or a link in Settings is under 24 px tall', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_MOCK_CLAUDE: 'ready' })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('tab-cut').click()
    const words = await page.locator('[data-testid="words"] .word').evaluateAll((els) => els.map((w) => w.getBoundingClientRect().height))
    expect(words.length).toBeGreaterThan(0)
    expect(Math.min(...words)).toBeGreaterThanOrEqual(24)
    await page.getByTestId('tab-cover').click()
    expect((await box(page, '[data-testid="cover-slider"]')).height).toBeGreaterThanOrEqual(24)
    await page.getByTestId('drawer-close').click()
    await page.getByTestId('account').click()
    // one left edge: the section list's words start where the screen's title does, as Reels' and Library's content does
    // (centred, as design review r12 had it, Settings showed three left edges at 1440: title, list, sections)
    const textLeft = (sel: string) =>
      page.locator(sel).first().evaluate((el) => {
        const r = document.createRange()
        r.selectNodeContents(el)
        return r.getBoundingClientRect().left
      })
    expect(Math.abs((await textLeft('[data-testid="settings-nav-editor"]')) - (await textLeft('.tb-h')))).toBeLessThan(2)
    // the GitHub releases link went with the getreelstudio.com updater; Automatic updates' "Get my link" is the same
    // .ext-link, and it shows only where updates work (not in a test build)
    for (const id of ['licence-link', 'notices-link']) {
      await page.getByTestId(id).scrollIntoViewIfNeeded()
      expect((await box(page, `[data-testid="${id}"]`)).height, id).toBeGreaterThanOrEqual(24)
    }
  } finally {
    await app.close()
  }
})

// BRIEF layout rule 5 and the audit's new-reel-toast state: "That isn't a video" sat at the window's bottom centre,
// over Choose video; then, centred on the whole page, over the plan panel's header (design review r12).
test("fails if a toast covers the screen's main action or its side panel, or is not centred on the main column", async () => {
  const media = makeMedia()
  const { app, page } = await launch({}, { realViewport: true })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-reel').click()
    const stage = page.getByTestId('planned-stage')
    for (const folded of [false, true]) {
      if (folded) await page.keyboard.press('Meta+Backslash')
      for (const size of SIZES) {
        await setSize(app, page, size)
        await stage.getByTestId('file-input').setInputFiles([media.doc])
        const toast = page.getByTestId('toast')
        await expect(toast).toBeVisible()
        await page.waitForTimeout(250)
        const at = `${size[0]}x${size[1]}${folded ? ' folded' : ''}`
        const t = await box(page, '[data-testid="toast"]')
        const column = await box(page, 'section.stage')
        const panel = await box(page, '.ncol')
        const choose = await box(page, '[data-testid="planned-stage"] .btn.primary')
        const meets = (a: typeof t, b: typeof t) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
        expect(meets(t, choose), at).toBe(false)
        expect(meets(t, panel), at).toBe(false)
        expect(Math.abs((t.left + t.right) / 2 - (column.left + column.right) / 2), at).toBeLessThan(2)
        await page.getByTestId('nav-home').click()
        await page.getByTestId('new-reel').click()
      }
    }
  } finally {
    await app.close()
  }
})
