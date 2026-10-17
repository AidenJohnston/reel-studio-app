// Shared helpers for the Electron end-to-end tests.
import { expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const APP_DIR = resolve(__dirname, '..')
export const SHOTS = join(APP_DIR, 'e2e', 'screenshots')
export const BASE = mkdtempSync(join(tmpdir(), 'rs-e2e-'))
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
