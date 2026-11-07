// Shared helpers for the Electron end-to-end tests.
import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

export const APP_DIR = resolve(__dirname, '..')
export const SHOTS = join(APP_DIR, 'e2e', 'screenshots')
export const BASE = mkdtempSync(join(process.env.REELSTUDIO_E2E_TMP ?? tmpdir(), `rs-e2e-${process.env.TEST_WORKER_INDEX ?? 'loader'}-`))
// Each worker removes its own folder (about 500 MB of renders) as it exits, passed or failed, whichever reporter ran;
// KEEP_E2E_TMP=1 keeps them for debugging.
if (process.env.KEEP_E2E_TMP !== '1') process.once('exit', () => rmSync(BASE, { recursive: true, force: true }))

/**
 * The profile `launch()` uses by default: its own per spec file. One worker runs every file and loads this module
 * once, so a profile shared by the whole worker would carry one file's first run, projects and settings into the next
 * (smoke.spec then never sees the welcome screen, mirror.spec reads another file's project). The tests of one file
 * share it. Call these inside a test or hook.
 */
function profile(): string {
  return join(BASE, basename(test.info().file).replace(/\.spec\.ts$/, ''))
}
/** Spaces and non-ASCII on purpose: real users have them. */
export const home = (): string => join(profile(), 'Zoë Müller', 'Documents')
export const root = (): string => join(home(), 'Reel Studio')
export const userData = (): string => join(profile(), 'user data')

export function makeMedia(): { video: string; song: string; picture: string; doc: string } {
  const media = join(BASE, 'my files ü')
  mkdirSync(media, { recursive: true })
  const video = process.env.REELSTUDIO_E2E_VIDEO ?? join(media, 'my first take.mp4')
  if (!process.env.REELSTUDIO_E2E_VIDEO) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
  }
  const song = join(media, 'happy song.mp3')
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'libmp3lame', song])
  const picture = join(media, 'logo.png')
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:size=400x300', '-frames:v', '1', picture])
  const doc = join(media, 'notes.txt')
  writeFileSync(doc, 'hello')
  return { video, song, picture, doc }
}

/**
 * `realViewport`: leave the page at the window's real size. Otherwise the page is pinned to
 * 1280 x 820 so screenshots compare, and it stays that size even when the window resizes or goes full screen.
 */
export async function launch(
  extraEnv: Record<string, string> = {},
  { realViewport = false }: { realViewport?: boolean } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    REELSTUDIO_TEST: '1',
    REELSTUDIO_USER_DATA: userData(),
    REELSTUDIO_ROOT: root(),
    REELSTUDIO_MODELS_DIR: process.env.REELSTUDIO_MODELS_DIR ?? join(BASE, 'models'),
    // An empty Hugging Face cache: a listening model on this computer must never be reused into a test profile.
    HF_HUB_CACHE: join(BASE, 'hf-cache'),
    // REELSTUDIO_E2E_AI=package runs against the installed @reelstudio/ai instead of the mock.
    REELSTUDIO_MOCK_AI: process.env.REELSTUDIO_E2E_AI === 'package' ? '0' : '1',
    FAKE_ENGINE_SLOW: '3'
  })
  Object.assign(env, extraEnv)
  // REELSTUDIO_E2E_EXE=<installed app binary> drives a PACKAGED app (e.g. ".../Reel Studio.app/Contents/MacOS/Reel Studio").
  // It must find its own bundled engine, python and ffmpeg, so no dev override reaches it; the test process keeps them
  // (takes.spec runs check_export.py with them).
  const exe = process.env.REELSTUDIO_E2E_EXE
  if (exe) {
    for (const k of ['REELSTUDIO_ENGINE_DIR', 'REELSTUDIO_PYTHON', 'REELENGINE_FFMPEG', 'REELENGINE_FFPROBE', 'PYTHONPATH', 'FAKE_ENGINE_SLOW'])
      if (!(k in extraEnv)) delete env[k]
  } else if (!env.REELSTUDIO_ENGINE_DIR) env.REELSTUDIO_ENGINE_DIR = join(APP_DIR, 'dev', 'fake-engine')
  const app = exe
    ? await electron.launch({ executablePath: exe, args: [], cwd: BASE, env })
    : await electron.launch({ args: [APP_DIR], cwd: APP_DIR, env })
  const page = await app.firstWindow()
  if (!realViewport) await page.setViewportSize({ width: 1280, height: 820 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/**
 * The app's one checkbox (styles.css): a 16 px square with 4 px corners, white when off, green when on. `box` is what
 * draws it: the checkbox itself, or the span a plan or More reels tick draws it on.
 */
export async function expectOneCheckbox(box: Locator, on: boolean): Promise<void> {
  const look = await box.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { width: Math.round(r.width), height: Math.round(r.height), corners: cs.borderTopLeftRadius, fill: cs.backgroundColor }
  })
  expect(look).toEqual({ width: 16, height: 16, corners: '4px', fill: on ? 'rgb(30, 94, 75)' : 'rgb(255, 255, 255)' })
}

/** The colour painted at one point of the window, read from a 1 px screenshot (an 8-bit RGB or RGBA PNG). */
export async function painted(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  const idat: Buffer[] = []
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at)
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len))
    at += len + 12
  }
  // one row: its filter byte, then the pixel (any filter leaves a lone first pixel as it is)
  return [...inflateSync(Buffer.concat(idat)).subarray(1, 4)]
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/**
 * Picks an item in the Reel screen's View menu under the phone (PreviewControls.tsx ViewMenu): `view-instagram`,
 * `view-clean`, `shape-<id>` or `timeline-toggle`. Opens the menu first unless it is open; picking closes it.
 */
export async function viewMenu(page: Page, item: string): Promise<void> {
  // the button says whether its menu is open: a menu that is closing is still on screen for its exit
  const button = page.getByTestId('view-menu')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await page.getByTestId('view-menu-list').getByTestId(item).click()
}

/** The account row at the bottom of the sidebar opens Settings. */
export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('account').click()
}

/** Welcome, then the sample: skips the demo and goes on to Choose your editor. */
export async function passSample(page: Page): Promise<void> {
  await page.getByTestId('get-started').click()
  await page.getByTestId('demo-skip').click()
  await toEditorStep(page)
}

/** The sample's Continue. A Mac's first run asks about notifications next; Not now passes it (FirstRun.tsx Your Mac). */
export async function toEditorStep(page: Page): Promise<void> {
  await page.getByTestId('demo-next').click()
  const skip = page.getByTestId('mac-skip')
  await expect(skip.or(page.getByTestId('composer-connect'))).toBeVisible()
  if (await skip.isVisible()) await skip.click()
}

/** New reel from the sidebar, then its video from the stage's file picker: Version 1 is made on the Reel screen. */
export async function startReel(page: Page, video: string): Promise<void> {
  // On a planned reel already: New reel stays on it if nothing was done with it (main store.ts planReel), else
  // opens another, which must be on screen before it gets the video.
  const stage = page.getByTestId('planned-stage')
  const reelPage = page.locator('.reel-page')
  const before = (await stage.count()) ? await reelPage.getAttribute('data-slug') : null
  const untouched = !!before && (await page.getByTestId('plan-empty').count()) > 0 && (await page.getByTestId('title').textContent()) === 'New reel'
  await page.getByTestId('new-reel').click()
  if (before && !untouched) await expect(reelPage).not.toHaveAttribute('data-slug', before)
  await stage.getByTestId('file-input').setInputFiles([video])
}

/** startReel, then waits for Version 1's line in the notes. */
export async function makeReel(page: Page, video: string, timeout = 240_000): Promise<void> {
  await startReel(page, video)
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout })
}

/** The listening model is on this computer (the first run starts getting it on Get started). */
export async function modelReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.reel.model.status().then((s) => s.installed)), { timeout: 30_000 }).toBe(true)
}

/** New reel, as File > New Video (Cmd+N) sends it: the app's own command, wherever its button sits on screen. */
export async function newReel(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('app:command', { type: 'new-video' })
  })
}

/**
 * Gets past the first-run screens if this is a fresh profile, without an editor, and leaves it on Reels with no
 * reels, as every spec that uses it expects. The first run ends on a new reel with no video; onboarding.spec checks
 * that reel, so here it is removed.
 */
export async function passFirstRun(page: Page): Promise<void> {
  const welcome = page.getByTestId('get-started')
  const home = page.getByRole('heading', { name: 'Reels' })
  await expect(welcome.or(home)).toBeVisible()
  if (await welcome.isVisible()) {
    await passSample(page)
    await modelReady(page)
    // an editor already connected (the mock Claude, the practice editor) turns Not now into Continue
    await page.getByTestId('not-now').or(page.getByTestId('editor-continue')).click()
    await expect(page.getByTestId('planned-stage')).toBeVisible()
    await page.getByTestId('nav-home').click()
    await page.evaluate(async () => {
      for (const p of await window.reel.projects.list()) await window.reel.projects.remove(p.slug)
    })
    // Reels read its list when it opened, with the reel still in it
    await page.reload()
  }
  await expect(home).toBeVisible()
}

/** The project folders under a root's Projects folder (none before its first reel). */
export function projectFolders(root: string): string[] {
  const dir = join(root, 'Projects')
  return existsSync(dir) ? readdirSync(dir).filter((s) => !s.startsWith('.')) : []
}

/**
 * The one project folder that appeared since `before` (from projectFolders), as a path. A root can hold other tests'
 * projects, and readdir order is the file system's (NTFS lists names sorted), so the first folder listed can be another's.
 */
export function newProjectFolder(root: string, before: string[]): string {
  const made = projectFolders(root).filter((s) => !before.includes(s))
  expect(made, 'exactly one new project').toHaveLength(1)
  return join(root, 'Projects', made[0])
}

/**
 * Drops real files on an element (`release` false: drags them over it and holds), like dragging them from Finder/Explorer. The files come from a
 * scratch <input type=file> so they are disk-backed (Electron can resolve their paths).
 */
export async function dropFiles(page: Page, testId: string, paths: string[], release = true): Promise<void> {
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = true
    i.id = '__drop_source'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.locator('#__drop_source').setInputFiles(paths)
  await page.evaluate(([id, drop]) => {
    const src = document.getElementById('__drop_source') as HTMLInputElement
    const dt = new DataTransfer()
    for (const f of Array.from(src.files ?? [])) dt.items.add(f)
    const target = document.querySelector(`[data-testid="${id}"]`)!
    for (const type of drop ? ['dragenter', 'dragover', 'drop'] : ['dragenter', 'dragover']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }
    src.remove()
  }, [testId, release] as const)
}

/** The labels the one build uses for the person's own Claude Code app. Reel Studio itself is never "Claude Code". */
export const USE_CLAUDE_CODE = 'Use Claude (your Claude Code app)'
export const CLAUDE_CODE_LABEL = 'Claude (your Claude Code app)'
/** Any "Claude Code" that is not "Claude Code app" would be the app calling itself Claude Code. */
export const CLAUDE_CODE_MISNAMED = /Claude Code(?! app)/

/**
 * Clicks "Use Claude (your Claude Code app)" on the Connect panel in view, if this computer's Claude Code app is
 * signed in. Nothing picks it on its own (it spends the person's own Claude plan), so a run that wants it says so.
 * Returns whether it is now the AI editor. First run and the Connect screen move on by themselves after the click.
 */
export async function chooseClaudeCode(page: Page, timeout = 20_000): Promise<boolean> {
  const btn = page.getByTestId('use-claude-code')
  await btn.waitFor({ timeout }).catch(() => {})
  if (!(await btn.isVisible())) return false
  await btn.click()
  const active = () => page.evaluate(() => (window as any).reel.ai.active().then((a: { id: string }) => a.id))
  await expect.poll(active, { timeout: 30_000 }).toBe('claude-cli')
  return true
}

/** One kept word to aim a note at: a plain word of 4+ letters said once in the cut, about 60% of the way in. */
export function pickKeptWord(projectDir: string): { id: string; word: string; index: number } {
  const p = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
  const words: { id: string; w: string }[] = JSON.parse(readFileSync(join(projectDir, p.transcript?.file ?? 'work/transcript.json'), 'utf8')).words
  const at = new Map(words.map((w, i) => [w.id, i]))
  const kept: number[] = []
  for (const r of p.cut?.keep ?? []) for (let i = at.get(r.from) ?? -1; i >= 0 && i <= (at.get(r.to) ?? -2); i++) kept.push(i)
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z']/g, '')
  const counts = new Map<string, number>()
  for (const i of kept) counts.set(clean(words[i].w), (counts.get(clean(words[i].w)) ?? 0) + 1)
  const STOP = new Set(['that', 'this', 'with', 'have', 'just', 'like', 'what', 'when', 'your', 'they', 'then', 'there', 'were', 'been', 'from', 'about', 'really'])
  const ok = kept.filter((i) => /^[a-z]{4,}$/.test(clean(words[i].w)) && counts.get(clean(words[i].w)) === 1 && !STOP.has(clean(words[i].w)))
  if (!ok.length) throw new Error('no plain kept word to aim the note at')
  const target = kept[Math.floor(kept.length * 0.6)]
  const i = ok.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  return { id: words[i].id, word: clean(words[i].w), index: i }
}

/**
 * The 0.1.2 meme flow with a REAL AI: drop a meme on the note box with "put this over my face" and no moment
 * (the editor must ASK, not guess), then name the moment in a second note with no file (the editor must place the
 * file it was given before on that word). Returns what happened, read back from project.json.
 */
export async function attachMemeFlow(page: Page, projectDir: string, file: string, snapAs: (name: string) => Promise<void>): Promise<Record<string, unknown>> {
  const project = () => JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
  const replies = page.locator('.bubble.editor:not(.working):not(.reply-pending)')
  const send = async (text: string): Promise<{ reply: string; sec: number }> => {
    const before = await replies.count()
    const t = Date.now()
    await page.getByTestId('note-input').fill(text)
    await page.keyboard.press('Enter')
    // a note can add more than one bubble (what was done, then "remember this?"): wait for at least one
    await expect.poll(() => replies.count(), { timeout: 30 * 60_000, intervals: [1000] }).toBeGreaterThan(before)
    await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 10 * 60_000 })
    const all = await replies.allInnerTexts()
    return { reply: all.slice(before).join(' | '), sec: Math.round((Date.now() - t) / 1000) }
  }
  const out: Record<string, unknown> = {}
  await dropFiles(page, 'note-drop', [file])
  await expect(page.getByTestId('note-attachment')).toHaveCount(1, { timeout: 120_000 })
  await snapAs('attach-01-chip')
  const sidecars = readdirSync(join(projectDir, 'work', 'assets')).filter((f) => f.startsWith('attach-') && f.endsWith('.attach.json'))
  const asset: string = JSON.parse(readFileSync(join(projectDir, 'work', 'assets', sidecars.sort().pop()!), 'utf8')).asset
  out.asset = asset
  const brollBefore = (project().broll ?? []).length
  const ask = await send('put this over my face')
  out.askReply = ask.reply
  out.askSec = ask.sec
  out.askAddedBroll = (project().broll ?? []).filter((b: any) => b.asset === asset).length
  out.askBrollCount = [brollBefore, (project().broll ?? []).length]
  await snapAs('attach-02-asked')
  const target = pickKeptWord(projectDir)
  out.target = target
  const place = await send(`put it over my face when I say "${target.word}"`)
  out.placeReply = place.reply
  out.placeSec = place.sec
  const p = project()
  const words: { id: string }[] = JSON.parse(readFileSync(join(projectDir, p.transcript?.file ?? 'work/transcript.json'), 'utf8')).words
  const at = new Map(words.map((w, i) => [w.id, i]))
  const placed = (p.broll ?? []).filter((b: any) => b.asset === asset)
  out.placed = placed
  out.placedOnWord = placed.some((b: any) => (at.get(b.anchor?.from) ?? 1e9) <= target.index && target.index <= (at.get(b.anchor?.to) ?? -1))
  out.noteAttachments = (p.notes ?? []).map((n: any) => n.attachments ?? null)
  await snapAs('attach-03-placed')
  return out
}
