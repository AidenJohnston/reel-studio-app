import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPidRegistry, isOurEngine, processName } from '../src/main/orphans'
import { isAlive, killTree } from '../src/main/proctree'
import { createEngineRunner } from '../src/main/engine'
import { clearStaleLocks, OWNER_LOCK } from '../src/main/owner'
import { engineEnv, projectsDir } from '../src/main/paths'
import { APP_DIR, PYTHON, setupPaths } from './helpers'

describe('orphaned engine reaper', () => {
  it('names a running process', async () => {
    // Linux can name the test runner's thread mainthread instead of node.
    const child = spawn(PYTHON, ['-c', 'import time; time.sleep(60)'], { stdio: 'ignore', windowsHide: true })
    try {
      await once(child, 'spawn')
      expect((await processName(child.pid!))?.toLowerCase()).toContain('python')
      expect(await processName(999999)).toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
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
    first.add(engine.pid!, null)
    first.add(other.pid!, null)
    first.add(process.pid, null)
    // "Crash": the registry is never cleaned. A new app instance reaps it.
    const { stopped } = await createPidRegistry(dir).reap()
    expect(stopped).toBe(1)
    for (let i = 0; i < 30 && isAlive(engine.pid!); i++) await new Promise((r) => setTimeout(r, 100))
    expect(isAlive(engine.pid!)).toBe(false)
    expect(isAlive(other.pid!)).toBe(true)
    expect(isAlive(process.pid)).toBe(true)
    other.kill()
  }, 60000)

  // Windows has no process groups: there the engine's Job Object ends its children with it (contain.py)
  it.skipIf(process.platform === 'win32')('an engine is registered until all it started is gone, and a project whose engine would not stop stays locked at the next start', async () => {
    setupPaths()
    const settings = mkdtempSync(join(tmpdir(), 'rs-orphan-'))
    const sleeper = join(APP_DIR, 'test', 'fixtures', 'sleeper')
    const project = join(projectsDir(), 'bread')
    const other = join(projectsDir(), 'cake')
    for (const p of [project, other]) {
      mkdirSync(join(p, 'work'), { recursive: true })
      writeFileSync(join(p, OWNER_LOCK), '{"app":"Reel Studio"}')
    }
    const registry = createPidRegistry(settings)

    // the engine crashes and leaves a child: its entry goes only once that child is gone
    let child = 0
    let childAliveAtRemoval = true
    const run = createEngineRunner({
      python: () => PYTHON,
      env: () => ({ ...engineEnv(), PYTHONPATH: sleeper }),
      onSpawn: (pid, p) => registry.add(pid, p),
      onExit: (pid) => {
        childAliveAtRemoval = isAlive(child)
        registry.remove(pid)
      }
    })
    await expect(run('crash', ['--project', project], (pr) => (child = Number(pr.message)))).rejects.toMatchObject({ code: 'ENGINE_CRASHED' })
    expect(childAliveAtRemoval).toBe(false)

    // the app crashed while an engine of `bread` ran, and that engine will not stop (stop() fails)
    const left = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep'], { cwd: sleeper, stdio: 'ignore', detached: true })
    await new Promise((r) => setTimeout(r, 500))
    registry.add(left.pid!, project)
    const next = createPidRegistry(settings, async () => false)
    const { stillRunning } = await next.reap()
    await clearStaleLocks(stillRunning)
    expect(stillRunning).toEqual([project])
    expect(existsSync(join(project, OWNER_LOCK))).toBe(true)
    expect(existsSync(join(other, OWNER_LOCK))).toBe(false)
    expect(JSON.parse(readFileSync(join(settings, 'engines.json'), 'utf8'))).toEqual([{ pid: left.pid, project }])
    await killTree(left.pid!)
  }, 60000)

  it('recognises only our engine command line', () => {
    expect(isOurEngine('"C:/x/python.exe" -s -E -X utf8 -u -m reelengine render --project p')).toBe(true)
    expect(isOurEngine('/r/python/bin/python3 -s -E -m reelengine transcribe')).toBe(true)
    expect(isOurEngine('python -m jupyter notebook')).toBe(false)
    expect(isOurEngine('python -c "import reelengine"')).toBe(false)
    expect(isOurEngine(null)).toBe(false)
  })
})
