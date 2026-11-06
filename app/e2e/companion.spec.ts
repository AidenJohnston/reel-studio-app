// Phone and browser, end to end in the built app with the stand-in engine and the mock AI playing a connected Claude
// Code app: Settings > Phone and browser > Pair a phone, a "phone" opens the code's link, sees the reel, plays and
// saves Version 1, sends a note that makes Version 2 on the computer, watches it arrive, and is removed.
//
// The phone is an Electron window with no preload, sized like a phone, in its own session: to the page it is an
// ordinary browser that has never seen Reel Studio. The server listens on 127.0.0.1 here
// (REELSTUDIO_COMPANION_HOST, test builds only), so no firewall prompt appears.
//
// Run: npm run build && npx playwright test e2e/companion.spec.ts
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, openSettings, passFirstRun, SHOTS } from './helpers'

const MINE = mkdtempSync(join(BASE, 'companion-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

async function openPhone(app: ElectronApplication, url: string): Promise<Page> {
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, u) => {
    const w = new BrowserWindow({ width: 390, height: 844, webPreferences: { partition: 'companion-e2e-phone', sandbox: true, contextIsolation: true } })
    w.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
    void w.loadURL(u)
  }, url)
  const phone = await opened
  await phone.setViewportSize({ width: 390, height: 844 })
  return phone
}

test('a paired phone watches a reel, saves it, sends a note that makes Version 2, and stops working once removed', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({
    REELSTUDIO_ROOT: ROOT,
    REELSTUDIO_USER_DATA: join(MINE, 'user data'),
    REELSTUDIO_MOCK_CLAUDE: 'ready',
    REELSTUDIO_COMPANION_HOST: '127.0.0.1',
    FAKE_ENGINE_SLOW: '1'
  })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected AI')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()
    await page.getByTestId('nav-home').click()
    await makeReel(page, media.video)

    // ---- the computer: Settings > Phone and browser > Pair a phone ----
    await openSettings(page)
    await expect(page.getByTestId('settings-devices')).toContainText('No phones or browsers yet.')
    await page.getByTestId('devices-pair').click()
    const qr = page.getByTestId('pair-qr')
    await expect(qr).toBeVisible()
    const url = (await qr.getAttribute('data-url'))!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#p=[0-9a-f]{32}\.[0-9a-f]{64}$/)
    await expect(page.getByTestId('pair-left')).toContainText(/works once, for [45]:\d\d/)
    await page.screenshot({ path: join(SHOTS, 'companion-01-pair-sheet.png') })

    // ---- the phone opens the code's link ----
    const phone = await openPhone(app, url)
    await expect(page.getByTestId('pair-done')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(SHOTS, 'companion-02-paired.png') })
    // the secret never stays in the phone's address bar
    await expect.poll(() => phone.evaluate(() => location.hash)).toBe('')
    const row = phone.getByTestId('cp-reel-row')
    await expect(row).toHaveCount(1, { timeout: 30_000 })
    await phone.screenshot({ path: join(SHOTS, 'companion-03-phone-reels.png') })
    await row.click()

    // ---- watch and save Version 1 ----
    const player = phone.getByTestId('cp-player')
    await expect(player).toBeVisible()
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    const save = phone.getByTestId('cp-save')
    const saveUrl = new URL((await save.getAttribute('href'))!, url)
    const saved = await fetch(saveUrl, { method: 'HEAD' })
    expect([saved.status, saved.headers.get('content-disposition')]).toEqual([200, expect.stringMatching(/^attachment; filename=".+, version 1\.mp4"/)])
    await phone.screenshot({ path: join(SHOTS, 'companion-04-phone-reel.png') })

    // ---- a note from the phone makes Version 2 on the computer ----
    await phone.getByTestId('cp-note-input').fill('make the captions lowercase')
    await phone.getByTestId('cp-note-send').click()
    await expect(phone.getByTestId('cp-chat')).toContainText('make the captions lowercase')
    await expect(phone.locator('[data-testid="cp-version"][data-n="2"]')).toBeVisible({ timeout: 120_000 })
    await expect(phone.getByTestId('cp-chat')).toContainText('I made the subtitles lowercase.')
    await phone.screenshot({ path: join(SHOTS, 'companion-05-phone-version-2.png') })
    await page.getByTestId('pair-close').click()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('project-card').first().click()
    await expect(page.getByTestId('chat')).toContainText('make the captions lowercase')

    // ---- removed on the computer: the phone forgets its pairing ----
    await openSettings(page)
    await expect(page.getByTestId('device-row')).toHaveCount(1)
    await expect(page.getByTestId('device-row')).toContainText('iPhone')
    await page.screenshot({ path: join(SHOTS, 'companion-06-devices-list.png') })
    await page.getByTestId('device-remove').click()
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click()
    await expect(page.getByTestId('device-row')).toHaveCount(0)
    await expect(phone.getByTestId('cp-not-paired')).toBeVisible({ timeout: 30_000 })
    await phone.screenshot({ path: join(SHOTS, 'companion-07-phone-removed.png') })

    // ---- switched off: nothing listens ----
    await page.getByTestId('devices-on').click()
    await expect(page.getByTestId('devices-on')).toHaveAttribute('aria-checked', 'false')
    expect(await fetch(new URL('/api/time', url)).then(() => 'answered', () => 'refused')).toBe('refused')
  } finally {
    await app.close()
  }
})
