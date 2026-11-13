import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isAlive } from '../src/main/proctree'

test('fails if the engine survives the self-test exit', async () => {
  test.skip(process.platform !== 'darwin', 'Mac self-test process-group regression')
  test.setTimeout(180_000)
  const scratch = mkdtempSync(join(tmpdir(), 'rs-self-test-exit-'))
  const engine = join(scratch, 'engine')
  const pidFile = join(scratch, 'engine.pid')
  const resultFile = join(scratch, 'result.json')
  mkdirSync(join(engine, 'reelengine'), { recursive: true })
  writeFileSync(join(engine, 'reelengine', '__init__.py'), '')
  writeFileSync(join(engine, 'reelengine', '__main__.py'), `
import os, signal, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))
while True:
    time.sleep(1)
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CLIPROXY_API_KEY
  const app = await electron.launch({
    args: [resolve(__dirname, '..'), '--self-test', '--out', resultFile],
    env: {
      ...env,
      REELSTUDIO_USER_DATA: join(scratch, 'user data'),
      REELSTUDIO_ROOT: join(scratch, 'projects'),
      REELSTUDIO_MODELS_DIR: join(scratch, 'models'),
      REELENGINE_CACHE: join(scratch, 'cache'),
      REELSTUDIO_ENGINE_DIR: engine,
      REELSTUDIO_PYTHON: '/usr/bin/python3',
      REELENGINE_FFPROBE: execFileSync('/usr/bin/which', ['ffprobe'], { encoding: 'utf8' }).trim()
    }
  })
  try {
    const code = await new Promise<number | null>((resolveExit) => app.process().once('exit', resolveExit))
    expect(code).toBe(1)
    expect(JSON.parse(readFileSync(resultFile, 'utf8')).ok).toBe(false)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    expect(isAlive(pid)).toBe(false)
  } finally {
    await app.close().catch(() => {})
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (pid > 0) process.kill(-pid, 'SIGKILL')
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('fails if a self-test that cannot write its result keeps running', async () => {
  test.setTimeout(60_000)
  const scratch = mkdtempSync(join(tmpdir(), 'rs-self-test-out-'))
  // A file where --out needs a folder: making that folder fails on every system.
  const blocker = join(scratch, 'not a folder')
  writeFileSync(blocker, '')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CLIPROXY_API_KEY
  // Spawned directly, not through Playwright: this run can end before Playwright would have attached.
  const electronBin = createRequire(__filename)('electron') as string
  const child = spawn(electronBin, [resolve(__dirname, '..'), '--self-test', '--out', join(blocker, 'result.json')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...env,
      REELSTUDIO_USER_DATA: join(scratch, 'user data'),
      REELSTUDIO_ROOT: join(scratch, 'projects'),
      REELSTUDIO_MODELS_DIR: join(scratch, 'models'),
      REELENGINE_CACHE: join(scratch, 'cache'),
      // No engine and no python: the checks fail at once, and the run goes straight to writing its result.
      REELSTUDIO_ENGINE_DIR: join(scratch, 'engine'),
      REELSTUDIO_PYTHON: join(scratch, 'no python')
    }
  })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  try {
    const code = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit))
    expect(code).toBe(1)
    expect(stderr).toContain('self-test failed')
  } finally {
    child.kill()
    rmSync(scratch, { recursive: true, force: true })
  }
})
