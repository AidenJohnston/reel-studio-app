// The guided AI setup behind the easy-AI flag (main/easy-ai.ts), from no AI to a first note, against mocks: a local
// server plays GitHub's Codex download and publik, and the mock AI plays Codex's own sign-in (REELSTUDIO_MOCK_CODEX).
// The download, its hash check and the system tar's unpack are the real ones. No browser opens in a test run.
//
// Run: `npx playwright test e2e/easy-ai.spec.ts` after `electron-vite build` (unset ELECTRON_RUN_AS_NODE first).
import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passSample, modelReady, shot } from './helpers'

const PAT = 'pat_e2e_public_token'
const KEY = 'pk_live_e2e_9f2c'
let server: Server
let origin = ''
let pkg: Buffer
const publik = { claimed: false, balance: 50_000, installs: [] as any[], chats: [] as { auth?: string; model?: string }[], events: [] as string[], downloads: 0 }

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** A Codex package with the real layout (bin/codex.exe or bin/codex), packed by the system's own tar. */
function makePackage(): Buffer {
  const dir = join(BASE, 'codex package src')
  const win = process.platform === 'win32'
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', win ? 'codex.exe' : 'codex'), 'stand-in for codex')
  const out = join(BASE, 'codex-package-test.tar.gz')
  const tar = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  execFileSync(tar, ['-czf', out, '-C', dir, 'bin'])
  return readFileSync(out)
}

test.beforeAll(async () => {
  pkg = makePackage()
  server = createServer(async (req, res) => {
    const json = (s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (req.url === '/codex.tar.gz') {
      publik.downloads++
      // slow enough to see "Getting ChatGPT ready" on screen
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(pkg.length) })
      res.write(pkg.subarray(0, 64))
      setTimeout(() => res.end(pkg.subarray(64)), 1500)
      return
    }
    if (req.url === '/api/v1/installs' && req.method === 'POST') {
      const b = await body(req)
      publik.installs.push(b)
      return b?.app_token === PAT ? json(201, { key: KEY, install_id: b.install_id, claim_url: `${origin}/claim/e2e` }) : json(401, { error: { message: 'bad app token' } })
    }
    if (req.url === '/api/v1/wallet') {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { type: 'invalid_api_key' } })
      return json(200, { claim_state: publik.claimed ? 'claimed' : 'anonymous', claim_url: `${origin}/claim/e2e`, plan: { kind: 'none', label: null }, balance_micros: publik.balance, top_up_url: `${origin}/top-up` })
    }
    if (req.url === '/api/v1/telemetry') {
      publik.events.push((await body(req))?.event)
      return json(202, {})
    }
    if (req.url === '/api/v1/chat/completions') {
      const b = await body(req)
      publik.chats.push({ auth: req.headers.authorization, model: b?.model })
      return req.headers.authorization === `Bearer ${KEY}` ? json(200, { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }) : json(401, { error: { message: 'bad key' } })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
test.afterAll(async () => {
  server?.closeAllConnections()
  await new Promise((r) => server?.close(r))
})

/** The app's own lines about the guided setup (main.log), for a failure message: they hold no key or URL. */
function appLog(userData: string): string {
  try {
    const lines = readFileSync(join(userData, 'logs', 'main.log'), 'utf8').split(/\r?\n/)
    return lines.filter((l) => /\[easy-ai\]|\[vendor\]|\[ipc ai:guided/.test(l)).slice(-20).join('\n') || 'main.log has no guided-setup lines'
  } catch {
    return 'no main.log'
  }
}

/** A fresh profile whose user-data folder has a space and an accent, as a real Windows account can. */
function profile(name: string) {
  const root = join(BASE, `easy-${name}`)
  return { userData: join(root, 'Zoë user data'), root: join(root, 'Zoë Müller', 'Documents', 'Reel Studio') }
}

/** The manifesto's words that must not be on the first view of the setup (L1's plain-words list, the setup's part). */
const NOT_ON_FIRST_VIEW = /\b(model|provider|API|API key|token|CLI|terminal|Codex|Claude|Sonnet|Opus|GPT|render)\b/i

async function firstRunToEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('get-started')).toBeVisible()
  await passSample(page)
  await modelReady(page)
  await expect(page.getByTestId('composer-connect')).toBeVisible()
}

/** After the first run: a reel from the video, then one note, which only an editor can answer. */
async function firstNote(page: Page, video: string, shotName: string): Promise<void> {
  await page.getByTestId('editor-continue').click()
  const stage = page.getByTestId('planned-stage')
  await expect(stage).toBeVisible()
  await stage.getByTestId('file-input').setInputFiles([video])
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
  await page.getByTestId('note-input').fill('make the start faster')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
  await shot(page, shotName)
}

test('flag off: the editor picker is today’s, with no guided rows, and the switch in Settings is off', async () => {
  const p = profile('off')
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: p.userData, REELSTUDIO_ROOT: p.root })
  try {
    await firstRunToEditor(page)
    await expect(page.getByTestId('ai-picker')).toBeVisible()
    await expect(page.getByTestId('guided-choices')).toHaveCount(0)
    await expect(page.getByTestId('other-ways')).toHaveCount(0)
    expect(await page.evaluate(() => window.reel.ai.easyStatus())).toEqual({ on: false, publik: false })
    await expect(page.evaluate(() => window.reel.ai.guidedStart('chatgpt'))).rejects.toThrow()
    await page.getByTestId('not-now').click()
    await page.getByTestId('account').click()
    await expect(page.getByTestId('easy-ai')).toHaveAttribute('aria-checked', 'false')
    expect(existsSync(join(p.userData, 'codex'))).toBe(false)
  } finally {
    await app.close()
  }
})

test('Sign in with ChatGPT on a computer with no Codex: one press gets it ready, signs in, and the first note works', async () => {
  const media = makeMedia()
  const p = profile('chatgpt')
  const sha256 = createHash('sha256').update(pkg).digest('hex')
  const { app, page } = await launch({
    REELSTUDIO_USER_DATA: p.userData,
    REELSTUDIO_ROOT: p.root,
    REELSTUDIO_EASY_AI: '1',
    REELSTUDIO_MOCK_EDITS: '1',
    REELSTUDIO_MOCK_CODEX: 'missing',
    REELSTUDIO_TEST_CODEX_PACKAGE: JSON.stringify({ url: `${origin}/codex.tar.gz`, sha256, bytes: pkg.length })
  })
  try {
    await firstRunToEditor(page)
    const choices = page.getByTestId('guided-choices')
    await expect(choices).toBeVisible()
    // no publik app token in this run: only ChatGPT is offered, and today's rows wait under Other ways, closed
    await expect(page.getByTestId('guided-publik')).toHaveCount(0)
    await expect(page.getByTestId('other-ways')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('guided-start-chatgpt')).toHaveClass(/\bprimary\b/)
    expect(await page.getByTestId('composer-connect').innerText()).not.toMatch(NOT_ON_FIRST_VIEW)
    await shot(page, 'easy-ai-01-chatgpt-first-view')

    await page.getByTestId('guided-start-chatgpt').click()
    const row = page.getByTestId('guided-chatgpt')
    await expect(row).toHaveAttribute('data-step', 'getting')
    await expect(row).toContainText('Getting ChatGPT ready on this computer')
    await shot(page, 'easy-ai-02-chatgpt-getting')
    // the sentence first: if the row failed instead, this assertion prints what it said, with the app's own log of why
    await expect(row)
      .toContainText('A ChatGPT page opened in your browser', { timeout: 30_000 })
      .catch((e: Error) => {
        throw new Error(`${e.message}\n\nThe app's log:\n${appLog(p.userData)}`)
      })
    await expect(row).toHaveAttribute('data-step', 'waiting')
    await shot(page, 'easy-ai-03-chatgpt-waiting')
    // the sign-in finishes on its own; the editor is ChatGPT and the first run's button says Continue
    await expect(page.getByTestId('editor-continue')).toBeVisible({ timeout: 20_000 })
    expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('codex-cli')
    await shot(page, 'easy-ai-04-chatgpt-done')
    expect(publik.downloads).toBe(1)
    const releases = readdirSync(join(p.userData, 'codex'))
    expect(releases).toHaveLength(1) // the unpacked package only: no archive, no staging folder
    expect(existsSync(join(p.userData, 'codex', releases[0], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))).toBe(true)

    await firstNote(page, media.video, 'easy-ai-05-chatgpt-first-note')
  } finally {
    await app.close()
  }
})

test('Use Reel Studio’s AI: publik’s page, then this computer’s key connects, and the first note works', async () => {
  const media = makeMedia()
  const p = profile('publik')
  publik.claimed = false
  const { app, page } = await launch({
    REELSTUDIO_USER_DATA: p.userData,
    REELSTUDIO_ROOT: p.root,
    REELSTUDIO_EASY_AI: '1',
    REELSTUDIO_MOCK_EDITS: '1',
    REELSTUDIO_TEST_PUBLIK_ORIGIN: origin,
    REELSTUDIO_TEST_PUBLIK_TOKEN: PAT
  })
  try {
    await firstRunToEditor(page)
    await expect(page.getByTestId('guided-publik')).toBeVisible()
    expect(await page.getByTestId('composer-connect').innerText()).not.toMatch(NOT_ON_FIRST_VIEW)
    await shot(page, 'easy-ai-06-publik-first-view')

    await page.getByTestId('guided-start-publik').click()
    const row = page.getByTestId('guided-publik')
    await expect(row).toContainText('A page opened in your browser. Sign in there')
    await expect(row).toHaveAttribute('data-step', 'waiting')
    await expect(page.getByTestId('guided-reopen-publik')).toBeVisible()
    await shot(page, 'easy-ai-07-publik-waiting')
    expect(publik.installs.at(-1)).toMatchObject({ app_token: PAT, app_slug: 'reel-studio' })
    // the person signs in on publik's page
    publik.claimed = true
    await expect(page.getByTestId('editor-continue')).toBeVisible({ timeout: 20_000 })
    const active = await page.evaluate(() => window.reel.ai.active())
    expect(active).toMatchObject({ id: 'custom', connected: true, label: 'Reel Studio AI' })
    expect(publik.chats.at(-1)).toEqual({ auth: `Bearer ${KEY}`, model: 'publik-smart' })
    await expect.poll(() => publik.events).toContain('app_opened')
    // the key never reaches the page, and is not readable on disk
    const seen = await page.evaluate(async () => JSON.stringify([await window.reel.ai.connections(), await window.reel.ai.active(), await window.reel.ai.easyStatus()]))
    expect(seen).not.toContain(KEY)
    for (const f of readdirSync(p.userData).filter((n) => n.startsWith('publik'))) expect(readFileSync(join(p.userData, f)).toString('utf8')).not.toContain(KEY)
    await shot(page, 'easy-ai-08-publik-done')

    await firstNote(page, media.video, 'easy-ai-09-publik-first-note')

    // the way back out: Sign out removes the key and the connection
    await page.getByTestId('account').click()
    await page.getByTestId('guided-sign-out-publik').click()
    await expect(page.getByTestId('ai-status')).toHaveText('No editor')
    expect(await page.evaluate(() => window.reel.ai.connections())).toEqual([])
    await expect(page.getByTestId('guided-choices')).toBeVisible()
    await shot(page, 'easy-ai-10-publik-signed-out')
  } finally {
    await app.close()
  }
})
