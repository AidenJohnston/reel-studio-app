import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initPaths } from '../src/main/paths'

export const APP_DIR = resolve(__dirname, '..')
export const FAKE_ENGINE = join(APP_DIR, 'dev', 'fake-engine')
export const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/** A temp "Documents" folder whose path has spaces and non-ASCII characters, like real users. */
export function tempHome(): string {
  const base = mkdtempSync(join(tmpdir(), 'rs-test-'))
  const home = join(base, 'Zoë Müller', 'Documents 文档')
  mkdirSync(home, { recursive: true })
  return home
}

export function setupPaths(home = tempHome()): { home: string; root: string } {
  const env = { ...process.env }
  delete env.REELSTUDIO_ROOT
  delete env.REELSTUDIO_ENGINE_DIR
  initPaths({
    isPackaged: false,
    resourcesPath: '',
    documentsDir: home,
    userDataDir: join(home, '..', 'userdata'),
    appDir: APP_DIR,
    env: { ...env, REELSTUDIO_ENGINE_DIR: FAKE_ENGINE }
  })
  return { home, root: join(home, 'Reel Studio') }
}

/** A 3-second 9:16 test clip with sound, made by ffmpeg. */
export function makeClip(path: string, seconds = 3): string {
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=270x480:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
    ],
    { windowsHide: true }
  )
  return path
}
