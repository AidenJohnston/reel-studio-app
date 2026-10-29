import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isAlive } from '../src/main/proctree'

test.skip(process.platform !== 'darwin', 'Mac self-test process-group regression')

test('fails if the engine survives the self-test exit', async () => {
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
