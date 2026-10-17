import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPidRegistry, isOurEngine, processName } from '../src/main/orphans'
import { isAlive } from '../src/main/proctree'
import { PYTHON } from './helpers'

describe('orphaned engine reaper', () => {
  it('names a running process', async () => {
    expect((await processName(process.pid))?.toLowerCase()).toContain('node')
    expect(await processName(999999)).toBeNull()
  })

  it('kills our engine left over from a crashed app, and nothing else (not another python)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-orphan-'))
    // A stand-in "engine": python -m reelengine, from a folder holding a sleeping reelengine package.
    const pkg = join(dir, 'engine', 'reelengine')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, '__init__.py'), '')
    writeFileSync(join(pkg, '__main__.py'), ['import time', 'time.sleep(60)', ''].join('\n'))
    const engine = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'render'], { cwd: join(dir, 'engine'), stdio: 'ignore', windowsHide: true })
    // Somebody else's python that happens to get a recorded pid (pid reuse): must survive.
    const other = spawn(PYTHON, ['-c', 'import time; time.sleep(60)'], { stdio: 'ignore', windowsHide: true })
    await new Promise((r) => setTimeout(r, 500))
    const first = createPidRegistry(dir)
    first.add(engine.pid!)
    first.add(other.pid!)
    first.add(process.pid)
    // "Crash": the registry is never cleaned. A new app instance reaps it.
    const killed = await createPidRegistry(dir).reap()
    expect(killed).toBe(1)
    for (let i = 0; i < 30 && isAlive(engine.pid!); i++) await new Promise((r) => setTimeout(r, 100))
    expect(isAlive(engine.pid!)).toBe(false)
    expect(isAlive(other.pid!)).toBe(true)
    expect(isAlive(process.pid)).toBe(true)
    other.kill()
  }, 60000)

  it('recognises only our engine command line', () => {
    expect(isOurEngine('"C:/x/python.exe" -s -E -X utf8 -u -m reelengine render --project p')).toBe(true)
    expect(isOurEngine('/r/python/bin/python3 -s -E -m reelengine transcribe')).toBe(true)
    expect(isOurEngine('python -m jupyter notebook')).toBe(false)
    expect(isOurEngine('python -c "import reelengine"')).toBe(false)
    expect(isOurEngine(null)).toBe(false)
  })
})
