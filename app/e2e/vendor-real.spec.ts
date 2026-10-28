// REAL machine, REAL vendors, opt-in: Connect Claude / Connect ChatGPT against the real @reelstudio/ai, the vendors'
// real installers and the vendors' real sign-in, inside a throwaway home (the app's test switch
// REELSTUDIO_TEST_VENDOR_HOME), so the Claude Code and Codex apps already on this computer are never touched.
//
//   REELSTUDIO_E2E_REAL_VENDOR=claude|chatgpt   which card to click (required; otherwise every test is skipped)
//   REELSTUDIO_E2E_SIGNIN=1                     wait (up to 10 min) for a person to finish the sign-in in the browser,
//                                                then check it became the AI editor and run one tiny request through it
//   REELSTUDIO_E2E_VENDOR_HOME=<dir>             reuse a throwaway home (else a new temp one); delete it afterwards
//
// Without REELSTUDIO_E2E_SIGNIN it stops at "the CLI's own sign-in started" (Claude: the sign-in link it handed to
// BROWSER; Codex: 127.0.0.1:1455 listening) and clicks Cancel.
// Run after `electron-vite build`, with ELECTRON_RUN_AS_NODE unset:
//   REELSTUDIO_E2E_AI=package REELSTUDIO_E2E_REAL_VENDOR=chatgpt npx playwright test e2e/vendor-real.spec.ts
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, passFirstRun, shot } from './helpers'

const VENDOR = process.env.REELSTUDIO_E2E_REAL_VENDOR as 'claude' | 'chatgpt' | undefined
const SIGNIN = process.env.REELSTUDIO_E2E_SIGNIN === '1'

test.skip(!VENDOR || process.env.REELSTUDIO_E2E_AI !== 'package', 'opt-in: REELSTUDIO_E2E_AI=package REELSTUDIO_E2E_REAL_VENDOR=claude|chatgpt')

function listening(port: number): boolean {
  try {
    const out = process.platform === 'win32' ? execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }) : execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    return process.platform === 'win32' ? new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING`).test(out) : out.includes(`:${port}`)
  } catch {
    return false
  }
}

test(`real ${VENDOR}: install into a throwaway home, start the vendor's own sign-in`, async () => {
  test.setTimeout(SIGNIN ? 25 * 60_000 : 12 * 60_000)
  const home = process.env.REELSTUDIO_E2E_VENDOR_HOME || mkdtempSync(join(BASE, 'vendor-home-'))
  mkdirSync(home, { recursive: true })
  // Claude honours BROWSER: the sign-in link lands in a file instead of a browser tab (unless a person signs in).
  const urls = join(home, 'browser-urls')
  mkdirSync(urls, { recursive: true })
  let browser = ''
  if (!SIGNIN) {
    if (process.platform === 'win32') {
      browser = join(home, 'capture.cmd')
      writeFileSync(browser, `@echo off\r\n>"${urls}\\url-%RANDOM%.txt" echo %*\r\n`)
    } else {
      browser = join(home, 'capture.sh')
      writeFileSync(browser, `#!/bin/sh\necho "$1" > "${urls}/url-$$.txt"\n`, { mode: 0o755 })
    }
  }
  const mine = mkdtempSync(join(BASE, `real-${VENDOR}-`))
  const { app, page } = await launch({
    REELSTUDIO_TEST_VENDOR_HOME: home,
    ...(browser ? { REELSTUDIO_TEST_BROWSER: browser } : {}),
    REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio'),
    REELSTUDIO_USER_DATA: join(mine, 'user data')
  })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    const card = page.getByTestId(`vendor-${VENDOR}`)
    await expect(card).not.toHaveAttribute('data-step', 'loading')
    const before = await card.getAttribute('data-state')
    console.log(`${VENDOR} before: ${before}`)
    const t0 = Date.now()
    await page.getByTestId(`connect-${VENDOR}`).click()
    if (before === 'missing' || before === 'broken') {
      await expect(card).toHaveAttribute('data-step', 'installing')
      await shot(page, `real-${VENDOR}-installing`)
    }
    await expect(card).toHaveAttribute('data-step', /signing_in|failed|done/, { timeout: 11 * 60_000 })
    console.log(`${VENDOR} reached ${await card.getAttribute('data-step')} after ${Math.round((Date.now() - t0) / 1000)} s`)
    expect(await card.getAttribute('data-step')).toBe('signing_in')
    await shot(page, `real-${VENDOR}-browser`)
    if (!SIGNIN) {
      if (VENDOR === 'claude') {
        await expect.poll(() => readdirSync(urls).length, { timeout: 30_000 }).toBeGreaterThan(0)
        const link = readFileSync(join(urls, readdirSync(urls)[0]), 'utf8')
        expect(link).toMatch(/redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2Fcallback/) // the CLI listens on 127.0.0.1 itself
        console.log('claude handed its own sign-in link (localhost callback) to BROWSER')
      } else {
        await expect.poll(() => listening(1455), { timeout: 30_000 }).toBe(true)
        console.log('codex is listening on 127.0.0.1:1455')
      }
      await page.getByTestId(`vendor-cancel-${VENDOR}`).click()
      await expect(page.getByTestId(`connect-${VENDOR}`)).toBeVisible()
      if (VENDOR === 'chatgpt') await expect.poll(() => listening(1455), { timeout: 15_000 }).toBe(false)
      return
    }
    // a person signs in in the browser now
    await expect(page.getByTestId('ai-connected')).toHaveText(VENDOR === 'claude' ? 'Using Claude through your Claude Code app.' : 'Using ChatGPT through your Codex app.', { timeout: 11 * 60_000 })
    await shot(page, `real-${VENDOR}-connected`)
    const r = await page.evaluate(() => (window as any).reel.ai.active())
    expect(r.id).toBe(VENDOR === 'claude' ? 'claude-cli' : 'codex-cli')
    console.log(`connected: ${JSON.stringify(r)}`)
  } finally {
    await app.close()
  }
})
