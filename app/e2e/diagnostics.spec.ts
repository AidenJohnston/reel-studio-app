// Settings > About > Copy diagnostics: one click puts a plain-text report on the clipboard, for a bug report.
import { test, expect } from '@playwright/test'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launch, passFirstRun, userData } from './helpers'

test('Copy diagnostics puts a redacted report on the clipboard', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await passFirstRun(page)
    // A log line carrying a home path and an e-mail address: neither may reach the clipboard.
    const logs = join(userData(), 'logs')
    mkdirSync(logs, { recursive: true })
    appendFileSync(join(logs, 'main.log'), `2026-01-01T00:00:00.000Z [test] ${join(homedir(), 'secret')} zoe@example.com\n`)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('copy-diagnostics').click()
    await expect(page.getByTestId('copy-diagnostics')).toHaveText('Copied')
    const text = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(text).toMatch(/^Reel Studio diagnostics\n/)
    expect(text).toMatch(/\nApp: \d+\.\d+\.\d+/)
    expect(text).toMatch(/\nAI editor: .+\n/)
    expect(text).toMatch(/\nRecent log \(last \d+ lines\):\n/)
    expect(text).toContain(`[test] ${join('~', 'secret')} <email>`)
    expect(text.toLowerCase()).not.toContain(homedir().toLowerCase())
  } finally {
    await app.close()
  }
})
