// Settings > About > Report a problem: the review step shows what will be sent, the report reaches the server with
// only what was ticked, and when sending fails the person is offered support@ and a copy of the report.
import { test, expect } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launch, passFirstRun, shot } from './helpers'

interface Got {
  headers: IncomingMessage['headers']
  form: FormData
}

/** A stand-in for dl.getreelstudio.com/v1/support: answers `status` and keeps every report it parsed. */
async function fakeServer(): Promise<{ server: Server; url: string; got: Got[]; status: { code: number; body?: unknown } }> {
  const got: Got[] = []
  const status: { code: number; body?: unknown } = { code: 201 }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData()
      got.push({ headers: req.headers, form })
      res.writeHead(status.code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status.body ?? (status.code === 201 ? { ok: true, id: 'RS-ABCDEFGH' } : { error: 'server error' })))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/support`, got, status }
}

test('Report a problem: review, send, and the way out when sending fails', async () => {
  const fake = await fakeServer()
  const { app, page } = await launch({ REELSTUDIO_SUPPORT_URL: fake.url })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('report-problem-open').click()
    const form = page.getByTestId('report-problem')
    await expect(form).toBeVisible()
    // nothing private is ticked to begin with
    await expect(page.getByTestId('report-diagnostics')).not.toBeChecked()
    await expect(page.getByTestId('report-screenshot')).not.toBeChecked()
    await expect(page.getByTestId('report-key')).toHaveCount(0) // no download key on this computer
    await page.getByTestId('report-what').fill('Export stopped at 80% and the app froze')
    await page.getByTestId('report-expected').fill('A finished reel')
    await page.getByTestId('report-diagnostics').check()
    await page.getByTestId('report-screenshot').check()
    await shot(page, 'report-problem-form')
    await page.getByTestId('report-review').click()

    const preview = page.getByTestId('report-preview')
    await expect(preview).toContainText('Export stopped at 80% and the app froze')
    await expect(preview).toContainText('A finished reel')
    await expect(page.getByTestId('report-preview-key')).toHaveText('Not included')
    await expect(page.getByTestId('report-preview-diagnostics')).toContainText('Included')
    await expect(page.getByTestId('report-preview-screenshot').locator('img')).toBeVisible()
    await shot(page, 'report-problem-review')
    await page.getByTestId('report-send').click()
    await expect(page.getByTestId('report-id')).toHaveText('RS-ABCDEFGH')
    await shot(page, 'report-problem-sent')

    expect(fake.got.length).toBe(1)
    const { form: f, headers } = fake.got[0]
    expect(f.get('what')).toBe('Export stopped at 80% and the app froze')
    expect(f.get('expected')).toBe('A finished reel')
    expect(f.get('email')).toBeNull()
    expect(String(f.get('appVersion'))).toMatch(/^\d+\.\d+\.\d+/)
    expect(String(f.get('os'))).toMatch(/^(Windows|macOS|linux) /)
    // multipart/form-data sends text newlines as CRLF (the HTML form encoding); the Worker turns them back into LF
    expect(String(f.get('diagnostics'))).toMatch(/^Reel Studio diagnostics\r?\n/)
    const screenshot = f.get('screenshot') as File
    expect(['image/png', 'image/jpeg']).toContain(screenshot.type)
    expect(screenshot.size).toBeGreaterThan(1000)
    expect(screenshot.size).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(headers.authorization).toBeUndefined()
    await page.getByTestId('report-done').click()

    // The server is down: the person sees why, and is offered support@ and a copy to paste.
    fake.status.code = 500
    await page.getByTestId('report-problem-open').click()
    await page.getByTestId('report-what').fill('Second report')
    await page.getByTestId('report-review').click()
    await page.getByTestId('report-send').click()
    await expect(page.getByTestId('report-error')).toContainText('support@getreelstudio.com')
    await expect(page.getByTestId('report-email-instead')).toBeVisible()
    await expect(page.getByTestId('report-retry')).toBeVisible()
    await expect(page.getByTestId('report-retry')).toBeFocused() // the way forward, not the gone Send button
    await shot(page, 'report-problem-failed')
    await page.getByTestId('report-copy').click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Second report')

    // The server refuses a field (400): resending the same report would fail again, so there is no Try again. Edit
    // leads, goes back to the form with the draft kept and the field marked, and sending needs a fresh review.
    fake.status.code = 400
    fake.status.body = { error: 'not an email address', field: 'email' }
    // Edit from the 500 above: back to the form, nothing marked, the keyboard on "What happened?"
    await page.getByTestId('report-edit').click()
    await expect(page.getByTestId('report-what')).toHaveValue('Second report')
    await expect(page.getByTestId('report-what')).toBeFocused()
    await expect(page.getByTestId('report-what')).not.toHaveAttribute('aria-invalid', 'true')
    // Back from the review step lands there too
    await page.getByTestId('report-review').click()
    await page.getByTestId('report-back').click()
    await expect(page.getByTestId('report-what')).toBeFocused()
    // The server refuses the email (stricter than the form): no Try again, Edit leads, and Edit puts the keyboard on
    // the refused field with it marked. Sending needs a fresh review.
    await page.getByTestId('report-email').fill('second@example.com')
    await page.getByTestId('report-review').click()
    await page.getByTestId('report-send').click()
    await expect(page.getByTestId('report-error')).toContainText('email: not an email address')
    await expect(page.getByTestId('report-retry')).toHaveCount(0)
    await expect(page.getByTestId('report-edit')).toHaveClass(/primary/)
    await expect(page.getByTestId('report-edit')).toBeFocused()
    await shot(page, 'report-problem-refused')
    await page.keyboard.press('Enter') // Edit, from the keyboard
    await expect(page.getByTestId('report-email')).toBeFocused()
    await expect(page.getByTestId('report-email')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('report-what')).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('report-field-error')).toContainText('not an email address')
    await expect(page.getByTestId('report-send')).toHaveCount(0) // the form has no Send: only a fresh review does
    // Replace the address with fill(), not a select-all shortcut, so the test does not depend on the platform's keys.
    // That focus landed here is checked above.
    await page.getByTestId('report-email').fill('second.try@example.com')
    fake.status.code = 201
    fake.status.body = undefined
    const before = fake.got.length
    await page.getByTestId('report-review').click()
    await expect(page.getByTestId('report-preview')).toContainText('second.try@example.com')
    await page.getByTestId('report-send').click()
    await expect(page.getByTestId('report-id')).toHaveText('RS-ABCDEFGH')
    expect(fake.got.length).toBe(before + 1)
    expect(fake.got[fake.got.length - 1].form.get('email')).toBe('second.try@example.com')

    // A field the page validates itself is marked and focused through the same IPC error path (field passes main → page).
    await page.getByTestId('report-done').click()
    await page.getByTestId('report-problem-open').click()
    await page.getByTestId('report-what').fill('Has a bad email')
    await page.getByTestId('report-email').fill('not an email')
    await page.getByTestId('report-what').focus()
    await page.getByTestId('report-review').click()
    await expect(page.getByTestId('report-email')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('report-email')).toBeFocused()
    await expect(page.getByTestId('report-what')).not.toHaveAttribute('aria-invalid', 'true')
  } finally {
    await app.close()
    fake.server.close()
  }
})
