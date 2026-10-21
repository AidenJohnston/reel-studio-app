// Grandma-test fixes, end to end with NO AI connected: honest "What I did", a note that answers
// plainly with the matching button, the caption controls, one-click "Add a song" / "Add pictures",
// the simple Connect screen, and "where did my video go?" after Export.
//
// Run: npm run e2e (or `npx playwright test e2e/ux.spec.ts` after a build). Same env as smoke.spec.ts.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, CLAUDE_CODE_LABEL, CLAUDE_CODE_MISNAMED, USE_CLAUDE_CODE, launch, makeMedia, passFirstRun, shot } from './helpers'

// Its own Reel Studio folder: the smoke test leaves a song in the shared Library, and this test
// needs the "No music yet" state.
const MINE = mkdtempSync(join(BASE, 'ux-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

/** The native file picker cannot be driven, so answer it from the main process. */
async function answerFilePicker(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, file)
}

function projectJson(): any {
  const dir = join(ROOT, 'Projects')
  const slug = readdirSync(dir).find((s) => {
    try {
      readFileSync(join(dir, s, 'project.json'))
      return true
    } catch {
      return false
    }
  })!
  return JSON.parse(readFileSync(join(dir, slug, 'project.json'), 'utf8'))
}

test('no AI: honest checklist, note -> button, caption controls, add song + picture, export', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)

  // Sidebar says plainly that no AI is on, and is a way in.
  await expect(page.getByTestId('sidebar-connect')).toBeVisible()

  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
  const aiSource = await page.evaluate(() => window.reel.app.info().then((i) => i.ai))
  const noAi = aiSource === 'mock' || !(await page.evaluate(() => window.reel.ai.active().then((a) => a.connected && a.id !== 'none')))
  expect(noAi).toBe(true)

  // ---- 1. honest "What I did" ----
  await expect(page.getByTestId('did-cut')).toContainText('Cut the pauses and repeated starts')
  await expect(page.getByTestId('did-post')).toHaveCount(0) // not done: an optional extra, not an empty circle
  await expect(page.getByTestId('extras')).toContainText('Write a post caption')
  await expect(page.getByTestId('what-i-did')).not.toContainText('best takes')
  await expect(page.getByTestId('what-i-did')).not.toContainText('Wrote your post caption')
  await expect(page.getByTestId('add-song')).toBeVisible()
  await expect(page.getByTestId('add-pictures')).toBeVisible()
  await expect(page.getByTestId('edit-myself')).toHaveText('Edit it myself')
  await expect(page.getByTestId('versions')).toContainText('Version 1')
  await shot(page, 'ux-01-reel-no-ai')

  // ---- 2. the post caption: an edit box, never "written" for you ----
  await page.getByTestId('write-post').click()
  await expect(page.getByTestId('post-editor')).toBeVisible()
  await shot(page, 'ux-02-post-editor')
  await page.getByTestId('post-input').fill('Why mornings make me a better editor')
  await page.getByTestId('post-save').click()
  await expect(page.getByTestId('did-post')).toContainText('Your post caption')
  expect(projectJson().post.caption).toBe('Why mornings make me a better editor')

  // ---- 3. a note with no AI: my bubble, a plain answer, the matching button + Connect ----
  const send = page.getByTestId('send')
  await page.getByTestId('note-input').fill('Make the captions bigger please')
  await expect(send).toHaveClass(/primary/) // looks clickable once there is text
  await shot(page, 'ux-03-note-typed')
  await send.click()
  await expect(page.getByTestId('bubble-you').last()).toHaveText('Make the captions bigger please')
  const reply = page.getByTestId('bubble-editor').last()
  await expect(reply).toContainText('no AI editor is connected')
  await expect(reply.getByTestId('action-open-captions')).toHaveText('Open subtitle settings')
  await expect(reply.getByTestId('action-connect')).toHaveText('Connect ChatGPT')
  await expect(page.getByTestId('note-progress')).toHaveCount(0) // nothing pretends to run
  await shot(page, 'ux-04-note-reply')

  // "Connect ChatGPT" goes straight to the simple connect screen.
  await reply.getByTestId('action-connect').click()
  await expect(page.getByTestId('connect-screen')).toBeVisible()
  await expect(page.getByTestId('signin-chatgpt')).toBeVisible()
  await expect(page.getByTestId('claude-key-toggle')).toHaveText('Use an Anthropic API key (advanced)')
  await expect(page.getByTestId('without-ai')).toContainText('Without AI')
  await shot(page, 'ux-05-connect')
  await page.getByTestId('claude-key-toggle').click()
  await expect(page.getByTestId('claude-key-input')).toBeVisible()
  await shot(page, 'ux-06-connect-claude-key')
  await page.getByText('Back to my video').click()
  await expect(page.getByTestId('player')).toBeVisible()

  // ---- 4. caption controls, opened from the reply's button ----
  await page.getByTestId('bubble-editor').last().getByTestId('action-open-captions').click()
  await expect(page.getByTestId('caption-controls')).toBeVisible()
  await expect(page.getByTestId('cap-size-medium')).toHaveAttribute('aria-checked', 'true') // 105 px default
  await expect(page.getByTestId('cap-pos-lower')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('cap-look-white')).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'ux-07-captions-tab')
  await page.getByTestId('cap-size-big').click()
  await page.getByTestId('cap-pos-higher').click()
  await page.getByTestId('cap-look-yellow').click()
  await shot(page, 'ux-08-captions-picked')
  await expect(page.getByTestId('sub-preview')).toBeVisible()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('note-progress')).toBeVisible()
  await expect(page.getByTestId('note-progress')).toBeInViewport() // never scrolled out of sight
  // a manual change says what it is (grandma 2: "Adding pictures" for a colour change) and shows a quick preview first
  await expect(page.getByTestId('note-progress')).toContainText('Updating your subtitles')
  await expect(page.getByTestId('change-preview')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('export-wait')).toBeVisible() // says why Export is greyed
  await shot(page, 'ux-09-new-version-working')
  await expect(page.getByTestId('versions').getByText('Version 2')).toBeVisible({ timeout: 10 * 60_000 })
  const style = projectJson().captions.style
  expect([style.size, style.position, style.color, !!style.box]).toEqual([126, 0.66, '#FFD60A', false])
  // The chat and the version button say what changed (critique 1.8).
  await expect(page.getByTestId('bubble-editor').last()).toHaveText('Version 2: bigger yellow subtitles, moved up.')
  await expect(page.getByTestId('versions').getByText('Version 2')).toHaveAttribute('title', 'Version 2: bigger yellow subtitles, moved up.')
  await expect(page.getByTestId('export')).toHaveText('Export Version 2')

  // ---- 5. "Add a song": one click, the picker, a new version with the song ----
  await answerFilePicker(app, media.song)
  await page.getByTestId('add-song').click()
  await expect(page.getByTestId('versions').getByText('Version 3')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByTestId('did-music')).toContainText('Added music')
  // project.json only takes Library-relative paths (secfix): never the picked file's own path.
  expect(projectJson().music.track).toBe('Library/Music/happy song.mp3')

  // ---- 6. "Add pictures": pick a picture, click the word ----
  await answerFilePicker(app, media.picture)
  await page.getByTestId('add-pictures').click()
  await page.getByTestId('picture-add').click()
  await expect(page.getByTestId('pick-word')).toBeVisible()
  await shot(page, 'ux-10-pick-word')
  await page.locator('.pick-words .word').nth(1).click()
  await expect(page.getByTestId('drawer')).toContainText('Picture above your head')
  await expect(page.getByTestId('broll-thumb')).toBeVisible() // a small picture, not a file name (grandma 2)
  await shot(page, 'ux-10b-pictures-list')
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('versions').getByText('Version 4')).toBeVisible({ timeout: 10 * 60_000 })
  const broll = projectJson().broll
  expect(broll).toHaveLength(1)
  expect(broll[0].asset).toBe('Library/Images/logo.png')
  await expect(page.getByTestId('did-broll')).toContainText('Added 1 picture')
  await shot(page, 'ux-11-reel-after-edits')

  // ---- 7. export: the file name, Show in Explorer/Finder with visible feedback ----
  await page.getByTestId('export').click()
  await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 10 * 60_000 })
  await expect(page.getByTestId('export-name')).toContainText(' - Version 4.mp4')
  const where = process.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'
  await expect(page.getByTestId('show-in-folder')).toHaveText(where)
  await page.getByTestId('show-in-folder').click()
  await expect(page.getByTestId('opened')).toBeVisible()
  await shot(page, 'ux-12-export')
  const exported = readdirSync(join(ROOT, 'Library', 'Exports'))
  expect(exported.some((f) => f.endsWith(' - Version 4.mp4'))).toBe(true)
  expect(exported.some((f) => /\(\d\)/.test(f))).toBe(false)
  await page.getByText('Done', { exact: true }).click()

  // ---- 8. Library: Finished videos first ----
  await page.getByTestId('nav-library').click()
  await expect(page.locator('.bin').first()).toHaveAttribute('data-testid', 'bin-exports')
  await expect(page.locator('.bin').first()).toContainText('Finished videos')
  await shot(page, 'ux-13-library')

  // ---- 9. Settings uses the same simple connect panel ----
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('signin-chatgpt')).toBeVisible()
  await shot(page, 'ux-14-settings')
  await app.close()
})

// The one build offers the person's own Claude Code app in its real state. The mock AI plays each state
// (REELSTUDIO_MOCK_CLAUDE); no terminal ever opens in mock mode, the launcher file is still written and checked.
async function claudeScreen(state: string) {
  const mine = mkdtempSync(join(BASE, `claude-${state}-`))
  const userData = join(mine, 'user data')
  const { app, page } = await launch({
    REELSTUDIO_MOCK_CLAUDE: state,
    REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio'),
    REELSTUDIO_USER_DATA: userData
  })
  await passFirstRun(page)
  const info = await page.evaluate(() => window.reel.app.info())
  // one build: no flavour field, just these
  expect(Object.keys(info).sort()).toEqual(['ai', 'dev', 'engine', 'firstRunDone', 'platform', 'root', 'rootDisplay', 'test', 'version'])
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('signin-chatgpt')).toBeVisible()
  return { app, page, info, userData, panel: page.locator('.panel').first() }
}

test('Claude Code app ready: "Use Claude (your Claude Code app)" comes first, but only a click turns it on', async () => {
  const { app, page, info, panel } = await claudeScreen('ready')
  test.skip(info.ai !== 'mock', 'the mock plays the Claude Code states')
  await expect(page.getByTestId('use-claude-code')).toHaveText(USE_CLAUDE_CODE)
  await expect(panel.locator('button.btn.big').first()).toHaveAttribute('data-testid', 'use-claude-code')
  await expect(page.getByTestId('use-claude-code')).toHaveClass(/primary/)
  await expect(page.getByTestId('signin-chatgpt')).not.toHaveClass(/primary/)
  await expect(panel).toContainText('It uses your own Claude plan and its usage limits.')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none') // never picked on its own
  await shot(page, 'ux-15-connect-claude-ready')
  await page.getByTestId('use-claude-code').click()
  await expect(page.getByTestId('ai-connected')).toHaveText('Using Claude through your Claude Code app.')
  // the sidebar follows at once, still on Settings (main announces the change)
  await expect(page.getByTestId('ai-status')).toContainText(`AI editor: ${CLAUDE_CODE_LABEL}`)
  expect(await page.locator('body').innerText()).not.toMatch(CLAUDE_CODE_MISNAMED)
  expect(await page.locator('body').innerText()).not.toContain('—')
  await shot(page, 'ux-16-connect-claude-using')
  await app.close()
})

test('Claude Code app not signed in: a sign-in window, then it waits and connects', async () => {
  const { app, page, info, userData, panel } = await claudeScreen('signs_in')
  test.skip(info.ai !== 'mock', 'the mock plays the Claude Code states')
  await expect(panel.locator('button.btn.big').first()).toHaveAttribute('data-testid', 'signin-chatgpt')
  await expect(page.getByTestId('signin-chatgpt')).toHaveClass(/primary/)
  await expect(page.getByTestId('claude-code-signin')).toHaveText('Sign in to your Claude Code app')
  await expect(panel).toContainText('A window opens. Sign in there with your Claude account. Reel Studio never sees it.')
  await expect(panel).toContainText('It uses your own Claude plan and its usage limits.')
  expect(await page.locator('body').innerText()).not.toMatch(CLAUDE_CODE_MISNAMED)
  await shot(page, 'ux-17-connect-claude-signed-out')
  await page.getByTestId('claude-code-signin').click()
  await expect(page.getByTestId('claude-code-waiting')).toBeVisible()
  await shot(page, 'ux-18-connect-claude-waiting')
  // the mock "signs in" 1.5 s after the window opens; the 3 s re-check notices and switches to it
  await expect(page.getByTestId('ai-connected')).toHaveText('Using Claude through your Claude Code app.', { timeout: 15_000 })
  const launcher = join(userData, 'claude-sign-in', process.platform === 'win32' ? 'Sign in to Claude.cmd' : 'Sign in to Claude.command')
  const script = readFileSync(launcher, 'utf8')
  expect(script).toContain('auth login --claudeai')
  expect(script).toContain('Sign in to Claude in this window.')
  await app.close()
})

test('Claude Code app not installed: a quiet "Use Claude instead" with plain install steps', async () => {
  const { app, page, info, panel } = await claudeScreen('missing')
  test.skip(info.ai !== 'mock', 'the mock plays the Claude Code states')
  await expect(page.getByTestId('signin-chatgpt')).toHaveClass(/primary/)
  await expect(page.getByTestId('claude-code-install')).toHaveCount(0)
  await page.getByTestId('claude-code-toggle').click()
  const steps = page.getByTestId('claude-code-install')
  await expect(steps.locator('a')).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup')
  await expect(steps).toContainText('Follow the steps for your computer.')
  await expect(steps).toContainText('Come back here and click Check again.')
  await expect(panel).toContainText('It needs a paid Claude plan (Pro or Max).')
  await expect(page.getByTestId('claude-code-check')).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(CLAUDE_CODE_MISNAMED)
  await shot(page, 'ux-19-connect-claude-missing')
  await app.close()
})

test('Claude Code app broken: a plain line and the install page', async () => {
  const { app, page, info } = await claudeScreen('broken')
  test.skip(info.ai !== 'mock', 'the mock plays the Claude Code states')
  const choice = page.locator('[data-testid=claude-code-choice][data-state=broken]')
  await expect(choice).toContainText('did not start')
  await expect(choice.locator('a')).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup')
  await shot(page, 'ux-20-connect-claude-broken')
  await app.close()
})
