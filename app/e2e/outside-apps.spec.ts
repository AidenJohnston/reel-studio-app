// Settings › Editor › How notes run, and Let other AI apps use Reel Studio, end to end with the stand-in engine and the
// mock AI. The second test runs the relay exactly as Settings tells an outside AI app to (the app's own binary as Node,
// from the Claude Desktop entry) and drives the running app through it: a note it sends shows and runs on the Reel
// screen. REELSTUDIO_E2E_EVIDENCE=<folder> also saves each new state there.
import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { chooseClaudeCode, launch, makeMedia, makeReel, openSettings, passFirstRun, shot } from './helpers'

const EVIDENCE = process.env.REELSTUDIO_E2E_EVIDENCE
async function evidence(page: Page, name: string): Promise<void> {
  await shot(page, name)
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

test('fails if a person cannot choose to run notes in their Claude Code app, or is not told when it fell back', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_HARNESS: 'refused' })
  try {
    await passFirstRun(page)
    await openSettings(page)
    // no editor that is an app yet: nothing to choose
    await expect(page.getByTestId('note-runner')).toHaveCount(0)
    expect(await chooseClaudeCode(page)).toBe(true)
    const runner = page.getByTestId('note-runner')
    await expect(runner).toBeVisible()
    await expect(page.getByTestId('note-runner-reelstudio')).toHaveAttribute('aria-checked', 'true')
    await page.locator('[data-setting="note-runner"]').scrollIntoViewIfNeeded()
    await evidence(page, 'note-runner-reelstudio')
    await page.getByTestId('note-runner-claude-code').click()
    await expect(page.getByTestId('note-runner-app')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-setting="note-runner"]')).toContainText('own agent makes each change')
    expect(await page.evaluate(() => window.reel.ai.noteRunner())).toEqual({ runner: 'app', app: 'claude-code' })
    await evidence(page, 'note-runner-app')

    // a note whose self-test fails runs on Reel Studio's editor, and Settings says so afterwards
    await page.getByTestId('nav-home').click()
    await makeReel(page, media.video)
    await page.getByTestId('note-input').fill('cut the first sentence')
    await page.getByTestId('send').click()
    await expect.poll(() => page.evaluate(() => window.reel.ai.noteRunner().then((r) => r.fellBack?.app ?? null)), { timeout: 60_000 }).toBe('claude-code')
    await openSettings(page)
    const fell = page.getByTestId('note-runner-fell-back')
    await expect(fell).toContainText('ran on Reel Studio’s editor instead')
    await fell.scrollIntoViewIfNeeded()
    await evidence(page, 'note-runner-fell-back')
    await page.getByTestId('note-runner-retry').click()
    await expect(fell).toHaveCount(0)
    await expect(page.getByTestId('note-runner-app')).toHaveAttribute('aria-checked', 'true')
  } finally {
    await app.close()
  }
})

/** An MCP client on the relay's stdio. */
function mcp(command: string, args: string[], env: Record<string, string>) {
  const ch: ChildProcessWithoutNullStreams = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  ch.stdout.setEncoding('utf8')
  const waiting = new Map<number, (m: any) => void>()
  let buf = ''
  ch.stdout.on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waiting.get(m.id)?.(m)
    }
  })
  let id = 0
  const rpc = (method: string, params: unknown): Promise<any> =>
    new Promise((r) => {
      const n = ++id
      waiting.set(n, r)
      ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    })
  const call = async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
    const r = (await rpc('tools/call', { name, arguments: args })).result
    return { text: r.content[0].text, isError: r.isError }
  }
  return { rpc, call, stop: () => ch.kill() }
}

test('fails if an outside AI app, set up as Settings says, cannot send a note that shows and runs on the Reel screen', async () => {
  const media = makeMedia()
  // the practice editor: every note thinks for a moment, then makes a version
  const { app, page } = await launch({ REELSTUDIO_MOCK_NOTE: '800' })
  let client: ReturnType<typeof mcp> | null = null
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const slug = await page.locator('.reel-page').getAttribute('data-slug')

    await openSettings(page)
    // the practice editor is no app: How notes run has nothing to offer
    await expect(page.getByTestId('note-runner')).toHaveCount(0)
    const toggle = page.getByTestId('outside-apps')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.locator('[data-setting="outside-apps"]').scrollIntoViewIfNeeded()
    await evidence(page, 'outside-off')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('outside-connected')).toContainText('No AI app is connected yet')
    await expect(page.getByTestId('outside-claude-code')).toContainText('claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 --transport stdio reelstudio')
    await page.locator('[data-setting="outside-apps"]').scrollIntoViewIfNeeded()
    await evidence(page, 'outside-on-claude-code')
    await page.getByTestId('outside-client-claudeDesktop').click()
    await expect(page.getByTestId('outside-claude-desktop')).toContainText('"mcpServers"')
    await evidence(page, 'outside-on-claude-desktop')
    await page.getByTestId('outside-client-codex').click()
    await expect(page.getByTestId('outside-codex')).toContainText('codex mcp add reelstudio --env ELECTRON_RUN_AS_NODE=1')
    await expect(page.getByTestId('outside-chatgpt-web')).toBeVisible()
    await evidence(page, 'outside-on-codex')

    // the relay, started exactly as the Claude Desktop entry says
    const entry = JSON.parse((await page.getByTestId('outside-client-claudeDesktop').click(), await page.getByTestId('outside-claude-desktop').textContent()) ?? '').mcpServers.reelstudio
    client = mcp(entry.command, entry.args, entry.env)
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e-agent' }, capabilities: {} })
    expect(init.result.serverInfo.name).toBe('reelstudio')
    const listed = JSON.parse((await client.call('list_reels', {})).text)
    expect(listed.reels.map((r: { reel: string }) => r.reel)).toContain(slug)
    await expect(page.getByTestId('outside-connected')).toContainText('Connected now: e2e-agent')
    await evidence(page, 'outside-connected')

    // back on the Reel screen, the note the outside app sends shows and runs there
    await page.getByTestId('nav-home').click()
    await page.locator(`.rcard[data-slug="${slug}"] [data-testid="project-card"]`).click()
    await expect(page.locator('.reel-page')).toHaveAttribute('data-slug', slug!)
    const sent = await client.call('send_note', { reel: slug, text: 'make the subtitles bigger' })
    expect(sent).toEqual({ text: expect.stringMatching(/^Sent\./), isError: false })
    await expect(page.getByTestId('chat')).toContainText('make the subtitles bigger')
    await evidence(page, 'outside-note-on-reel')
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    const read = JSON.parse((await client.call('get_reel', { reel: slug })).text)
    expect(read.versions.map((v: { version: number }) => v.version)).toEqual([1, 2])
    expect(JSON.stringify(read)).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|reel-media:/)

    // turned off in Settings: the outside app is cut off and told why
    await openSettings(page)
    await page.getByTestId('outside-apps').click()
    await expect(page.getByTestId('outside-apps')).toHaveAttribute('aria-checked', 'false')
    const refused = await client.call('list_reels', {})
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/turned off/)
  } finally {
    client?.stop()
    await app.close()
  }
})
