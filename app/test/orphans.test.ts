import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
    // detached like every engine the app starts (engine.ts): its own process group on macOS/Linux
    const engine = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'render'], { cwd: join(dir, 'engine'), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
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

  it('the engine list on disk is never half written while it is rewritten (a force quit then would leave it so)', async () => {
    const settings = mkdtempSync(join(tmpdir(), 'rs-orphan-'))
    const file = join(settings, 'engines.json')
    const stop = join(settings, 'stop')
    const registry = createPidRegistry(settings)
    registry.add(4242, '/projects/bread')
    const reader = spawn(process.execPath, ['-e', `
      const fs = require('fs'); let reads = 0, torn = 0
      console.log('ready')
      while (!fs.existsSync(${JSON.stringify(stop)})) {
        try { JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8')); reads++ } catch { torn++ }
      }
      console.log(JSON.stringify({ reads, torn }))`], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    reader.stdout.on('data', (d) => (out += d))
    while (!out.includes('ready')) await new Promise((r) => setTimeout(r, 20))
    for (let i = 0; i < 150; i++) {
      registry.add(5000 + i, '/projects/cake')
      registry.remove(5000 + i)
    }
    writeFileSync(stop, '')
    await once(reader, 'exit')
    const { reads, torn } = JSON.parse(out.split('\n').filter(Boolean).at(-1)!)
    expect(reads).toBeGreaterThan(0)
    expect(torn).toBe(0)
  }, 60000)

  // A virus scanner or indexer reading engines.json at the moment of a rewrite makes Windows refuse the rename
  // (EPERM). The engine just registered must still reach the file once the reader lets go, or a crash then
  // leaves it running unseen.
  it.runIf(process.platform === 'win32')('an engine registered while another program reads the list is written once it lets go', async () => {
    const settings = mkdtempSync(join(tmpdir(), 'rs-orphan-'))
    const file = join(settings, 'engines.json')
    const registry = createPidRegistry(settings)
    registry.add(4242, '/projects/bread')
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
      `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); 'held'; Start-Sleep -Milliseconds 600; $f.Close()`])
    await new Promise<void>((resolve) => holder.stdout.on('data', (d: Buffer) => d.toString().includes('held') && resolve()))
    registry.add(4243, '/projects/cake')
    await once(holder, 'exit')
    const pids = (): number[] => JSON.parse(readFileSync(file, 'utf8')).map((e: { pid: number }) => e.pid)
    for (let i = 0; i < 100 && !pids().includes(4243); i++) await new Promise((r) => setTimeout(r, 50))
    expect(pids()).toEqual([4242, 4243])
  }, 20000)

  it('a start that cannot read the engine list keeps closed only the videos an engine or ffmpeg is still working in', async () => {
    setupPaths() // its folders have spaces and non-ASCII names, like real users'
    const settings = mkdtempSync(join(tmpdir(), 'rs-orphan-'))
    const [bread, cake, rolls] = ['bread', 'cake', 'bread-rolls'].map((slug) => join(projectsDir(), slug))
    for (const p of [bread, cake, rolls]) mkdirSync(join(p, 'work'), { recursive: true })
    // what an older version's crash in the middle of rewriting it left
    writeFileSync(join(settings, 'engines.json'), `[{"pid":4242,"project":${JSON.stringify(bread).slice(0, 12)}`)
    // the crashed run's engine still rendering bread, and an ffmpeg a dead engine left writing into cake
    // (under the real path the engine resolved: on macOS the temp folder is behind a symlink)
    const engine = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep', '--project', bread], { cwd: join(APP_DIR, 'test', 'fixtures', 'sleeper'), stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    // its own group, stopped as a whole: on Windows `ffmpeg` may be a shim that runs the real one as a child
    const ffmpeg = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'anullsrc=r=8000', '-t', '60', '-y', join(realpathSync.native(cake), 'work', 'mix.wav')], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    // an app opened from the Finder has no locale
    const locale = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE }
    for (const k of Object.keys(locale)) delete process.env[k]
    try {
      await Promise.all([once(engine, 'spawn'), once(ffmpeg, 'spawn')])
      for (let start = 0; start < 2; start++) {
        const { stillRunning, unknown } = await createPidRegistry(settings).reap()
        expect(unknown).toBe(true)
        expect(stillRunning.sort()).toEqual([bread, cake].sort())
      }
      await killTree(engine.pid!)
      await killTree(ffmpeg.pid!)
      // nothing works in them any more: they open, and the next start no longer looks
      expect((await createPidRegistry(settings).reap()).stillRunning).toEqual([])
      expect((await createPidRegistry(settings).reap()).unknown).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(locale)) if (v !== undefined) process.env[k] = v
      if (engine.exitCode === null) await killTree(engine.pid!)
      if (ffmpeg.exitCode === null) await killTree(ffmpeg.pid!)
    }
  }, 60000)

  it.skipIf(process.platform === 'win32')('stopping an engine never signals a lone process that took over its pid', async () => {
    // not detached: it leads no process group, like an unrelated process that was handed a dead engine's pid
    const other = spawn(PYTHON, ['-c', 'import time; time.sleep(60)'], { stdio: 'ignore' })
    await once(other, 'spawn')
    await killTree(other.pid!)
    await new Promise((r) => setTimeout(r, 200))
    expect(isAlive(other.pid!)).toBe(true)
    other.kill()
  })

  it.skipIf(process.platform === 'win32')('an engine from a 0.1.x list (no video named) that would not stop keeps the video it works in closed', async () => {
    setupPaths()
    const settings = mkdtempSync(join(tmpdir(), 'rs-orphan-'))
    const open = join(projectsDir(), 'bread')
    mkdirSync(join(open, 'work'), { recursive: true })
    mkdirSync(join(projectsDir(), 'cake', 'work'), { recursive: true })
    const left = spawn(PYTHON, ['-s', '-E', '-m', 'reelengine', 'sleep', '--project', open], { cwd: join(APP_DIR, 'test', 'fixtures', 'sleeper'), stdio: 'ignore', detached: true })
    await once(left, 'spawn')
    writeFileSync(join(settings, 'engines.json'), JSON.stringify([left.pid]))
    const { stillRunning, unknown } = await createPidRegistry(settings, async () => false).reap()
    expect(unknown).toBe(true)
    expect(stillRunning).toEqual([open])
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
