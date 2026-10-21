// Shared helpers for the Electron end-to-end tests.
import { expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const APP_DIR = resolve(__dirname, '..')
export const SHOTS = join(APP_DIR, 'e2e', 'screenshots')
// The cleanup reporter owns the run folder and keeps files from failed workers.
export const BASE = mkdtempSync(join(process.env.REELSTUDIO_E2E_TMP ?? tmpdir(), `rs-e2e-${process.env.TEST_WORKER_INDEX ?? 'loader'}-`))
// Spaces and non-ASCII on purpose: real users have them.
export const HOME = join(BASE, 'Zoë Müller', 'Documents')
export const ROOT = join(HOME, 'Reel Studio')
export const USER_DATA = join(BASE, 'user data')

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

export async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    REELSTUDIO_TEST: '1',
    REELSTUDIO_USER_DATA: USER_DATA,
    REELSTUDIO_ROOT: ROOT,
    REELSTUDIO_MODELS_DIR: process.env.REELSTUDIO_MODELS_DIR ?? join(BASE, 'models'),
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
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/** Gets past the first-run screens if this is a fresh profile. */
export async function passFirstRun(page: Page): Promise<void> {
  const welcome = page.getByTestId('get-started')
  await expect(welcome.or(page.getByText('Your videos'))).toBeVisible()
  if (await welcome.isVisible()) {
    await welcome.click()
    // A model already on this computer shows "Next"; otherwise "Do this later".
    // Wait for the model box to know (it hides "Do this later" once the model is found).
    const ready = page.getByTestId('model-next')
    await expect(ready.or(page.getByTestId('download-model'))).toBeVisible()
    await ((await ready.isVisible()) ? ready : page.getByTestId('later')).click()
    await page.getByTestId('skip').click()
  }
  await expect(page.getByText('Your videos')).toBeVisible()
}

/**
 * Drops real files on an element, like dragging them from Finder/Explorer. The files come from a
 * scratch <input type=file> so they are disk-backed (Electron can resolve their paths).
 */
export async function dropFiles(page: Page, testId: string, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = true
    i.id = '__drop_source'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.locator('#__drop_source').setInputFiles(paths)
  await page.evaluate((id) => {
    const src = document.getElementById('__drop_source') as HTMLInputElement
    const dt = new DataTransfer()
    for (const f of Array.from(src.files ?? [])) dt.items.add(f)
    const target = document.querySelector(`[data-testid="${id}"]`)!
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }
    src.remove()
  }, testId)
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
