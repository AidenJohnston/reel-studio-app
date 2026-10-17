// "Send to my phone", end to end: export, open the panel, read the link from the rendered QR code,
// fetch it with Node the way a phone would (the page, then the video with a Range header), and see the
// desktop flip to "Sent!". Then the Reel-screen button, and the fallbacks when no phone shows up.
//
// The link listens on 127.0.0.1 here (REELSTUDIO_PHONE_HOST, test builds only), so no firewall prompt
// appears on the machine running the tests. The address choice itself is unit-tested (test/phone-share.test.ts).
//
// Run: npx playwright test e2e/phone.spec.ts (after npm run build).
import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, SHOTS } from './helpers'

const MINE = mkdtempSync(join(BASE, 'phone-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** Decode the QR code as a phone camera would (OpenCV), when this machine has it. */
function decodeQr(png: string): string | null {
  try {
    const out = execFileSync(
      'python',
      ['-I', '-c', 'import cv2,sys; img=cv2.imread(sys.argv[1]); t,_,_=cv2.QRCodeDetector().detectAndDecode(img); print(t)', png],
      { encoding: 'utf8', timeout: 30_000 }
    )
    return out.trim()
  } catch {
    return null
  }
}

async function qrUrl(page: Page): Promise<string> {
  const qr = page.getByTestId('phone-qr')
  await expect(qr).toBeVisible()
  const url = (await qr.getAttribute('data-url'))!
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/$/)
  const png = join(SHOTS, 'phone-qr-only.png')
  await qr.screenshot({ path: png })
  const decoded = decodeQr(png)
  if (decoded !== null) expect(decoded, 'the QR code a camera reads is the link').toBe(url)
  else console.log('[phone.spec] python + OpenCV not available: QR decode skipped, data-url used')
  return url
}

test('send to my phone: QR link, phone fetch, Sent!, fallbacks', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({
    REELSTUDIO_ROOT: ROOT,
    REELSTUDIO_USER_DATA: join(MINE, 'user data'),
    REELSTUDIO_PHONE_HOST: '127.0.0.1',
    REELSTUDIO_PHONE_WAIT_MS: '6000'
  })
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByTestId('export')).toBeEnabled({ timeout: 10 * 60_000 })

  // ---- export, then the big button ----
  await page.getByTestId('export').click()
  await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('export-dialog')).not.toContainText('Phone Link')
  await page.getByTestId('export-caption').fill('Three things I wish I knew')
  await page.screenshot({ path: join(SHOTS, 'phone-01-export-dialog.png') })
  await page.getByTestId('send-to-phone').click()
  await expect(page.getByTestId('phone-lead')).toHaveText(
    "Point your phone's camera at this code. Your video opens on your phone; tap Share, then Save Video (or open Instagram)."
  )
  const url = await qrUrl(page)
  await expect(page.getByTestId('phone-waiting')).toContainText('Waiting for your phone')
  if (process.platform === 'win32') await expect(page.getByTestId('firewall-note')).toContainText('click Allow')
  await page.screenshot({ path: join(SHOTS, 'phone-02-panel-waiting.png') })

  // ---- the phone: the page, then the video with a Range header ----
  const origin = new URL(url).origin
  expect((await fetch(origin + '/')).status).toBe(404) // nothing without the token
  const pageRes = await fetch(url, { headers: { 'User-Agent': IPHONE_UA } })
  expect(pageRes.status).toBe(200)
  const html = await pageRes.text()
  expect(html).toContain('<video src="video.mp4#t=0.1"')
  expect(html).toContain('Three things I wish I knew') // the caption typed in the dialog travels with it
  const vid = await fetch(url + 'video.mp4', { headers: { Range: 'bytes=0-1023', 'User-Agent': IPHONE_UA } })
  expect(vid.status).toBe(206)
  expect(vid.headers.get('content-type')).toBe('video/mp4')
  expect(vid.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/)
  const head = Buffer.from(await vid.arrayBuffer())
  expect(head.length).toBe(1024)
  expect(head.subarray(4, 8).toString('latin1')).toBe('ftyp') // a real mp4
  await expect(page.getByTestId('phone-sent')).toHaveText('Sent! Check your phone.')
  await page.screenshot({ path: join(SHOTS, 'phone-03-panel-sent.png') })

  // ---- what the phone shows (an iPhone-sized window) ----
  await app.evaluate(({ BrowserWindow }, u) => {
    const w = new BrowserWindow({ width: 390, height: 1100, show: false, webPreferences: { sandbox: true } })
    w.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
    void w.loadURL(u)
  }, url)
  const phone = await app.waitForEvent('window', (p) => p.url().startsWith(origin))
  await phone.waitForLoadState('load')
  await phone.setViewportSize({ width: 390, height: 1100 })
  await expect(phone.locator('h1')).toHaveText('Your video is here')
  await expect(phone.locator('#android')).toBeHidden() // an iPhone sees only the iPhone steps
  await expect(phone.locator('#ios')).toBeVisible()
  await phone.waitForTimeout(800)
  await phone.screenshot({ path: join(SHOTS, 'phone-04-phone-page.png'), fullPage: true })
  await phone.close()

  // ---- closing the panel closes the link ----
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  await expect.poll(() => fetch(url).then((r) => r.status, () => 'closed')).toBe('closed')

  // ---- the Reel-screen button exports straight into the panel; no phone visit -> fallbacks ----
  await page.getByTestId('send-to-phone-reel').click()
  const url2 = await qrUrl(page)
  expect(url2).not.toBe(url) // a fresh one-time link
  await expect(page.getByTestId('phone-fallbacks')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('phone-fallbacks')).toContainText('Email it to yourself')
  await expect(page.getByTestId('phone-fallbacks')).toContainText('iCloud Drive')
  await expect(page.getByTestId('phone-fallbacks')).toContainText('Use a cable')
  if (process.platform === 'darwin') await expect(page.getByTestId('phone-airdrop')).toBeVisible()
  await page.getByTestId('phone-email').click()
  await expect(page.getByTestId('phone-emailed')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'phone-05-panel-help.png') })
  await page.getByTestId('phone-fallbacks').screenshot({ path: join(SHOTS, 'phone-06-fallbacks.png') })
  await page.getByTestId('phone-back').click()
  await expect(page.getByText('Saved to your computer')).toBeVisible()
  await expect.poll(() => fetch(url2).then((r) => r.status, () => 'closed')).toBe('closed')

  await app.close()
})
