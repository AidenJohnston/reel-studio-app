// Grandma-test fixes, end to end with NO AI connected: an honest Version 1, no AI offer except one connect
// line, the caption controls, a song and a picture under Edit it myself, the simple Connect screen, and
// "where did my video go?" after Export.
//
// Run: npm run e2e (or `npx playwright test e2e/ux.spec.ts` after a build). Same env as smoke.spec.ts.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, CLAUDE_CODE_LABEL, CLAUDE_CODE_MISNAMED, USE_CLAUDE_CODE, launch, makeMedia, makeReel, passFirstRun, shot, openSettings } from './helpers'

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

function projectSlug(): string {
  const dir = join(ROOT, 'Projects')
  return readdirSync(dir).find((s) => {
    try {
      readFileSync(join(dir, s, 'project.json'))
      return true
    } catch {
      return false
    }
  })!
}

function projectJson(): any {
  return JSON.parse(readFileSync(join(ROOT, 'Projects', projectSlug(), 'project.json'), 'utf8'))
}

test('no AI: honest first version, one connect prompt, caption controls, a song and a picture, export', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)

  // Sidebar says plainly that no AI is on, and is a way in.
  await expect(page.getByTestId('ai-status')).toHaveText('No editor')

  await makeReel(page, media.video, 10 * 60_000)
  const aiSource = await page.evaluate(() => window.reel.app.info().then((i) => i.ai))
  const noAi = aiSource === 'mock' || !(await page.evaluate(() => window.reel.ai.active().then((a) => a.connected && a.id !== 'none')))
  expect(noAi).toBe(true)

  // ---- 1. honest: Version 1 says it is a basic version, and nobody says "I" ----
  await expect(page.getByTestId('log-video')).toContainText('Your video')
  await expect(page.locator('.nt-res[data-v="1"]')).toContainText('Basic version')
  // it offers what an AI would add, and never claims to have done it
  await expect(page.getByTestId('chat')).not.toContainText(/Kept your best takes|picked your best takes/i)
  await expect(page.getByTestId('chat')).not.toContainText('Wrote your caption')
  await expect(page.getByTestId('edit-myself')).toContainText('Edit it myself')
  await expect(page.getByTestId('version-on-screen')).toContainText('Version 1')
  await shot(page, 'ux-01-reel-no-ai')

  // ---- 2. the post caption is not part of the video: it lives in Share, not in Edit it myself ----
  await page.getByTestId('edit-myself').click()
  await expect(page.getByTestId('tab-cut')).toBeVisible()
  await expect(page.getByTestId('tab-post')).toHaveCount(0)
  await page.getByTestId('drawer-close').click()
  await expect(page.getByTestId('drawer')).toHaveCount(0)

  // ---- 3. no AI: nothing offers an AI change; the editor picker sits where the note box was ----
  await expect(page.getByTestId('note-input')).toHaveCount(0)
  await expect(page.getByTestId('moment-suggest')).toHaveCount(0)
  await page.keyboard.press('c') // pointing at a spot opens nothing either
  await expect(page.getByTestId('pointer')).toHaveCount(0)
  const picker = page.getByTestId('composer-connect')
  await expect(picker).toContainText('Connect an editor to leave notes')
  // no Codex app on this computer: its row links to OpenAI's install page (Reel Studio installs nothing)
  await expect(picker.getByTestId('vendor-install-page-chatgpt')).toBeVisible()
  await expect(picker.getByTestId('without-ai')).toHaveText('Without an editor, Reel Studio makes a basic version: pauses and retakes removed, subtitles and a cover.')
  await expect(picker.getByTestId('claude-key-toggle')).toBeHidden()
  await shot(page, 'ux-03-no-ai-connect')
  await picker.getByTestId('ai-advanced').click()
  await expect(picker.getByTestId('claude-key-toggle')).toHaveText('Add key')
  await picker.getByTestId('claude-key-toggle').click()
  await expect(picker.getByTestId('claude-key-input')).toBeVisible()
  await shot(page, 'ux-06-connect-claude-key')

  // ---- 4. subtitles under Edit it myself: a quick preview first, then the version, said in plain words ----
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('caption-controls')).toBeVisible()
  await expect(page.getByTestId('cap-size-medium')).toHaveAttribute('aria-checked', 'true') // 105 px default
  await expect(page.getByTestId('cap-pos-lower')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('cap-look-clean')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('cap-color-white')).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'ux-07-captions-tab')
  await page.getByTestId('cap-size-big').click()
  await page.getByTestId('cap-pos-higher').click()
  await page.getByTestId('cap-color-yellow').click()
  await shot(page, 'ux-08-captions-picked')
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('note-progress')).toBeVisible()
  await expect(page.getByTestId('note-progress')).toBeInViewport() // never scrolled out of sight
  // a manual change says what it is (grandma 2: "Adding pictures" for a colour change) and shows a quick preview first
  await expect(page.getByTestId('note-progress')).toContainText(/Making your changes|Making Version 2/)
  await expect(page.getByTestId('change-preview')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('share')).toBeDisabled() // and Share waits for it
  await shot(page, 'ux-09-new-version-working')
  await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 10 * 60_000 })
  const style = projectJson().captions.style
  expect([style.size, style.position, style.color, !!style.box]).toEqual([126, 0.66, '#FFD60A', false])
  // The notes log says what changed (critique 1.8): the version's line, open on the newest.
  // one sentence of what the person did, a short fact from the rows on the line, and the rows alone under it
  await expect(page.getByTestId('log-hand').last().locator('.bubble')).toHaveText('You made the subtitles bigger and yellow, and moved them up.')
  await expect(page.getByTestId('version-fact-2')).toHaveText('Bigger yellow subtitles')
  await expect(page.locator('.nt-res[data-v="2"] + .acc')).toContainText(/Subtitle/)
  await expect(page.locator('.nt-res[data-v="2"] + .acc')).not.toContainText('Version 2:')
  // The title bar names the version on screen from its receipts (#60), next to its number. The stand-in engine
  // writes none, so give Version 2 the receipt the real engine writes for this change and reopen the reel.
  await expect(page.getByTestId('version-title')).toHaveCount(0)
  const v2 = join(ROOT, 'Projects', projectSlug(), 'versions', 'v2')
  writeFileSync(
    join(v2, 'receipts.json'),
    JSON.stringify([{ renderId: 'e2e', facts: [{ kind: 'captions.style', field: 'size', before: 105, after: 126 }] }])
  )
  await page.getByTestId('nav-home').click()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('version-on-screen')).toHaveText('Version 2')
  await expect(page.getByTestId('version-title')).toHaveText('Bigger subtitles')
  await shot(page, 'ux-version-name')

  // A song the editor found outside the Library (#71): music.track is its frozen copy, and the Music tab names it
  // by its asset-ledger title, never the hash. The stand-in AI never freezes one, so put it there as resolve_asset does.
  const reelDir = join(ROOT, 'Projects', projectSlug())
  const frozen = `work/assets/frozen/music/${'ab'.repeat(32)}.mp3`
  mkdirSync(join(reelDir, 'work', 'assets', 'frozen', 'music'), { recursive: true })
  copyFileSync(media.song, join(reelDir, frozen))
  writeFileSync(
    join(reelDir, 'work', 'assets', 'manifest.jsonl'),
    JSON.stringify({ committedPath: frozen, title: 'beach walk', provenance: { intent: 'work/downloads/beach walk.mp3' } }) + '\n'
  )
  const withSong = projectJson()
  withSong.music = { enabled: true, track: frozen, level: 'under-voice' }
  writeFileSync(join(reelDir, 'project.json'), JSON.stringify(withSong, null, 2))
  await page.getByTestId('nav-home').click()
  await page.getByTestId('project-card').first().click()
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-music').click()
  await expect(page.getByTestId('music-elsewhere')).toHaveText('beach walk')
  await expect(page.getByRole('radio', { name: 'beach walk' })).toBeChecked()
  await shot(page, 'ux-music-elsewhere')
  await page.getByRole('radio', { name: 'No music' }).check()
  await page.getByRole('radio', { name: 'beach walk' }).check() // still there to go back to
  await expect(page.getByRole('radio', { name: 'beach walk' })).toBeChecked()
  await page.getByTestId('edit-myself').click()

  // ---- 5. a song: Music under Edit it myself, the picker, a new version with the song ----
  await answerFilePicker(app, media.song)
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-music').click()
  await page.getByTestId('music-add').click()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('log-play-3')).toBeVisible({ timeout: 10 * 60_000 })
  // project.json only takes Library-relative paths (secfix): never the picked file's own path.
  expect(projectJson().music.track).toBe('Library/Music/happy song.mp3')

  // Compare shows the reel without Instagram's header, under the switch; keeping a version brings the person's own view
  // back (10-28 audit, finding 6). The View menu says Clean while it is held.
  const instagram = await page.getByTestId('ig-overlay').isVisible()
  await page.getByTestId('compare-3').click()
  await expect(page.getByTestId('compare')).toBeVisible()
  await expect(page.getByTestId('ig-overlay')).toBeHidden()
  await expect(page.getByTestId('view-menu')).toHaveAttribute('aria-label', /^View: Clean,/)
  await shot(page, 'ux-compare-clean')
  await page.getByTestId('done-compare').click()
  await expect(page.getByTestId('ig-overlay')).toBeVisible({ visible: instagram })

  // ---- 6. pictures: pick a picture, click the word ----
  await answerFilePicker(app, media.picture)
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-broll').click()
  await page.getByTestId('picture-add').click()
  await expect(page.getByTestId('pick-word')).toBeVisible()
  await shot(page, 'ux-10-pick-word')
  await page.locator('.pick-words .word').nth(1).click()
  await expect(page.getByTestId('drawer')).toContainText('Above your head')
  await expect(page.getByTestId('broll-thumb')).toBeVisible() // a small picture, not a file name (grandma 2)
  await shot(page, 'ux-10b-pictures-list')
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('log-play-4')).toBeVisible({ timeout: 10 * 60_000 })
  const broll = projectJson().broll
  expect(broll).toHaveLength(1)
  expect(broll[0].asset).toBe('Library/Images/logo.png')
  await shot(page, 'ux-11-reel-after-edits')

  // ---- 7. Share: Show in Explorer/Finder saves the file and names it ----
  await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
  await page.getByTestId('share').click()
  const where = process.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'
  await expect(page.getByTestId('share-finder')).toContainText(where)
  await page.getByTestId('share-finder').click()
  await expect(page.getByTestId('share-pop')).toContainText(' - Version 4.mp4', { timeout: 10 * 60_000 })
  await shot(page, 'ux-12-share')
  const exported = readdirSync(join(ROOT, 'Library', 'Exports'))
  expect(exported.some((f) => f.endsWith(' - Version 4.mp4'))).toBe(true)
  expect(exported.some((f) => /\(\d\)/.test(f))).toBe(false)
  await page.keyboard.press('Escape')

  // ---- 8. Library: no Finished videos bin; reels live on Reels ----
  await page.getByTestId('nav-library').click()
  await expect(page.getByTestId('library-tab-images')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Finished videos')).toHaveCount(0)
  await shot(page, 'ux-13-library')

  // ---- 9. Settings uses the same simple connect panel ----
  await openSettings(page)
  await expect(page.getByTestId('vendor-install-page-chatgpt')).toBeVisible()
  await shot(page, 'ux-14-settings')
  await app.close()
})

// The one build offers the person's own Claude Code app in its real state. The mock AI plays each state
// (REELSTUDIO_MOCK_CLAUDE). Installing and signing in are connect.spec.ts's (#90).
async function claudeScreen(state: string, env: Record<string, string> = {}) {
  const mine = mkdtempSync(join(BASE, `claude-${state}-`))
  const userData = join(mine, 'user data')
  const { app, page } = await launch({
    REELSTUDIO_MOCK_CLAUDE: state,
    REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio'),
    REELSTUDIO_USER_DATA: userData,
    ...env
  })
  await passFirstRun(page)
  const info = await page.evaluate(() => window.reel.app.info())
  // one build: no flavour field, just these
  expect(Object.keys(info).sort()).toEqual(['ai', 'dev', 'engine', 'fasterExports', 'firstRunAgain', 'firstRunDone', 'footageIndex', 'models', 'phoneView', 'platform', 'root', 'rootDisplay', 'sharing', 'soundEffects', 'test', 'timeline', 'userName', 'version'])
  await openSettings(page)
  await expect(page.getByTestId('vendor-claude')).not.toHaveAttribute('data-step', 'loading')
  return { app, page, info, userData, panel: page.locator('#sec-editor') }
}

test('Claude Code app ready: "Use Claude (your Claude Code app)" comes first, but only a click turns it on', async () => {
  const { app, page, info, panel } = await claudeScreen('ready')
  test.skip(info.ai !== 'mock', 'the mock plays the Claude Code states')
  await expect(page.getByTestId('use-claude-code')).toHaveAccessibleName(USE_CLAUDE_CODE)
  await expect(panel.locator('[data-testid="vendor-claude"], [data-testid="vendor-chatgpt"]').locator('.pv-main > button').first()).toHaveAttribute('data-testid', 'use-claude-code')
  await expect(page.getByTestId('use-claude-code')).toHaveClass(/primary/)
  await expect(page.getByTestId('vendor-chatgpt').locator('.btn.primary')).toHaveCount(0) // one filled button
  await expect(panel).toContainText('Signed in. It uses your Claude plan’s limits.')
  expect((await page.evaluate(() => window.reel.ai.active())).id).toBe('none') // never picked on its own
  await shot(page, 'ux-15-connect-claude-ready')
  await page.getByTestId('use-claude-code').click()
  await expect(page.getByTestId('ai-connected')).toHaveText('Connected')
  await page.getByTestId('nav-home').click() // the sidebar re-reads the AI editor on every screen change
  await expect(page.getByTestId('ai-status')).toHaveText('Editor: Claude')
  expect(await page.locator('body').innerText()).not.toMatch(CLAUDE_CODE_MISNAMED)
  expect(await page.locator('body').innerText()).not.toContain('—')
  await shot(page, 'ux-16-connect-claude-using')
  await app.close()
})

test('fails if "Use Claude" says Connected before the check call answers, or a failed check hides why', async () => {
  const slow = await claudeScreen('ready', { REELSTUDIO_MOCK_CLAUDE_CHECK: '2500' })
  test.skip(slow.info.ai !== 'mock', 'the mock plays the Claude Code states')
  await slow.page.getByTestId('use-claude-code').click()
  await expect(slow.panel).toContainText('Checking Claude…')
  await expect(slow.page.getByTestId('ai-connected')).toHaveCount(0)
  await expect(slow.page.getByTestId('ai-connected')).toHaveText('Connected', { timeout: 10_000 })
  await slow.app.close()

  const limited = await claudeScreen('ready', { REELSTUDIO_MOCK_CLAUDE_CHECK: 'limited' })
  await limited.page.getByTestId('use-claude-code').click()
  // which limit and when it resets, never a bare "at its limit"
  await expect(limited.panel.getByRole('alert')).toHaveText(/^The account in your Claude Code app has hit its weekly limit\. It resets .+\.$/)
  await expect(limited.page.getByTestId('vendor-retry-claude')).toBeVisible()
  await expect(limited.page.getByTestId('ai-connected')).toHaveCount(0)
  expect((await limited.page.evaluate(() => window.reel.ai.active())).id).toBe('none')
  await limited.app.close()
})
