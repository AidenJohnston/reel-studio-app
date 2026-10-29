import { describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createEngineRunner, killAllEngines, LineSplitter, parseEngineLine, type EngineError } from '../src/main/engine'
import { isAlive } from '../src/main/proctree'
import { APP_DIR, FAKE_ENGINE, makeClip, PYTHON, setupPaths } from './helpers'
import { engineEnv } from '../src/main/paths'

describe('LineSplitter', () => {
  it('joins lines split across chunks, including a split UTF-8 character and CRLF', () => {
    const lines: string[] = []
    const s = new LineSplitter((l) => lines.push(l))
    const bytes = Buffer.from('{"a":"Zoë"}\r\n{"b":"文档"}\n\n{"c":1}', 'utf8')
    // Cut inside the multi-byte characters on purpose.
    for (let i = 0; i < bytes.length; i += 3) s.push(bytes.subarray(i, i + 3))
    s.end()
    expect(lines).toEqual(['{"a":"Zoë"}', '{"b":"文档"}', '{"c":1}'])
  })
})

describe('parseEngineLine', () => {
  it('reads progress, clamping pct', () => {
    expect(parseEngineLine('{"event":"progress","stage":"transcribe","pct":142,"message":"Listening to your video"}')).toEqual({
      event: 'progress',
      stage: 'transcribe',
      pct: 100,
      message: 'Listening to your video'
    })
  })
  it('reads done and error', () => {
    expect(parseEngineLine('{"event":"done","result":{"version":2}}')).toEqual({ event: 'done', result: { version: 2 } })
    const e = parseEngineLine('{"event":"error","code":"NO_AUDIO","message":"x","userMessage":"This video has no sound. Try a different file."}')
    expect(e).toMatchObject({ event: 'error', code: 'NO_AUDIO', userMessage: 'This video has no sound. Try a different file.' })
  })
  it('gives errors without a userMessage a friendly one', () => {
    const e = parseEngineLine('{"event":"error","code":"BOOM"}')
    expect(e?.event === 'error' && e.userMessage.length > 20).toBe(true)
  })
  it('ignores non-protocol output', () => {
    expect(parseEngineLine('Downloading...')).toBeNull()
    expect(parseEngineLine('[1,2]')).toBeNull()
    expect(parseEngineLine('{"event":"weird"}')).toBeNull()
  })
})

function runner(engineDir = FAKE_ENGINE, extra: NodeJS.ProcessEnv = {}, onSpawn?: (pid: number) => void) {
  return createEngineRunner({
    python: () => PYTHON,
    env: () => ({ ...engineEnv(), PYTHONPATH: engineDir, ...extra }),
    onSpawn
  })
}

function runTerminalThenKill(command: 'done' | 'error'): Promise<unknown> {
  setupPaths()
  let pid = 0
  const run = runner(join(APP_DIR, 'test', 'fixtures', 'terminal-then-wait'), {}, (p) => (pid = p))
  // The fixture reports progress after its terminal result, so the result is parsed before the kill.
  return run(command, [], () => process.kill(pid, 'SIGKILL'))
}

describe('engine runner (against the stand-in engine)', () => {
  it('runs init -> transcribe -> autocut -> render on a path with spaces and unicode', async () => {
    const { home, root } = setupPaths()
    const clip = makeClip(join(home, 'my take ü.mp4'))
    const run = runner()
    const project = join(root, 'Projects', 'mein-video')
    mkdirSync(project, { recursive: true })
    const stages: string[] = []
    await run('init', ['--project', project, '--title', 'Mein Video', '--slug', 'mein-video', clip])
    await run('transcribe', ['--project', project], (p) => stages.push(p.message))
    await run('autocut', ['--project', project])
    const r = (await run('render', ['--project', project, '--draft'])) as { version: number; path: string }
    expect(stages).toContain('Listening to your video')
    expect(r.version).toBe(1)
    expect(r.path).toContain('Zoë Müller')
  }, 60000)

  it('rejects with the engine userMessage on an error event', async () => {
    setupPaths()
    const run = runner()
    await expect(run('probe', ['/no/such/file.mp4'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
      userMessage: expect.stringContaining('could not find')
    })
  })

  it("ignores the user's Python setup (stale PYTHONHOME, PYTHONSTARTUP) and a hostile cwd", async () => {
    const { home } = setupPaths()
    const clip = makeClip(join(home, 'probe me.mp4'))
    // A stale PYTHONHOME makes a normal python die with "init_fs_encoding"; -E ignores it.
    const run = runner(undefined, { PYTHONHOME: join(home, 'gone-anaconda'), PYTHONSTARTUP: join(home, 'nope.py') })
    const r = (await run('probe', [clip])) as { duration: number }
    expect(r.duration).toBeGreaterThan(0)
  })

  it('reports a crash without an error event as ENGINE_CRASHED', async () => {
    setupPaths()
    const run = createEngineRunner({ python: () => PYTHON, env: () => ({ ...engineEnv(), PYTHONPATH: join(APP_DIR, 'nothing-here') }) })
    const err = (await run('probe', ['x']).catch((e) => e)) as EngineError
    expect(err.code).toBe('ENGINE_CRASHED')
    expect(err.userMessage).toMatch(/try again/i)
  })

  it('reports a missing python as ENGINE_MISSING', async () => {
    setupPaths()
    const run = createEngineRunner({ python: () => join(APP_DIR, 'no-python-here.exe'), env: () => engineEnv() })
    await expect(run('doctor', [])).rejects.toMatchObject({ code: 'ENGINE_MISSING' })
  })

  it.skipIf(process.platform === 'win32')('reports and logs the signal that killed the engine on POSIX', async () => {
    setupPaths()
    const logs: string[] = []
    const run = createEngineRunner({
      python: () => PYTHON,
      env: () => engineEnv(),
      log: (line) => logs.push(line),
      onSpawn: (pid) => process.kill(pid, 'SIGKILL')
    })
    await expect(run('doctor', [])).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      message: expect.stringContaining('SIGKILL')
    })
    expect(logs).toContain('[engine doctor] closed exitCode=null signal=SIGKILL')
  })

  it.skipIf(process.platform !== 'win32')('reports a killed engine with a nonzero exit code on Windows', async () => {
    setupPaths()
    const logs: string[] = []
    const run = createEngineRunner({
      python: () => PYTHON,
      env: () => engineEnv(),
      log: (line) => logs.push(line),
      onSpawn: (pid) => process.kill(pid, 'SIGKILL')
    })
    await expect(run('doctor', [])).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      message: expect.stringMatching(/^exit -?[1-9]\d*:/)
    })
    expect(logs).toContainEqual(expect.stringMatching(/^\[engine doctor\] closed exitCode=-?[1-9]\d* signal=none$/))
  })

  it('keeps a done result when the engine is killed during shutdown', async () => {
    await expect(runTerminalThenKill('done')).resolves.toEqual({ imported: ['song.mp3'] })
  })

  it('keeps a structured error when the engine is killed during shutdown', async () => {
    await expect(runTerminalThenKill('error')).rejects.toEqual({
      code: 'CLASSIFY_FAILED',
      userMessage: 'Try another file.',
      message: 'fixture classification error'
    })
  })

  it('cancel kills the engine and everything it started', async () => {
    setupPaths()
    let pid = 0
    let grandchild = 0
    const run = runner(join(APP_DIR, 'test', 'fixtures', 'sleeper'), {}, (p) => (pid = p))
    const ac = new AbortController()
    const t0 = Date.now()
    const p = run('sleep', [], (pr) => {
      grandchild = Number(pr.message)
      ac.abort()
    }, ac.signal)
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(Date.now() - t0).toBeLessThan(15000)
    expect(pid).toBeGreaterThan(0)
    expect(grandchild).toBeGreaterThan(0)
    // taskkill /T /F (or the process group kill) takes a moment.
    for (let i = 0; i < 40 && (isAlive(pid) || isAlive(grandchild)); i++) await new Promise((r) => setTimeout(r, 100))
    expect(isAlive(pid)).toBe(false)
    expect(isAlive(grandchild)).toBe(false)
  }, 30000)

  it.skipIf(process.platform === 'win32')('shutdown stops waiting for a cancelled engine whose pipes never close', async () => {
    setupPaths()
    let escaped = 0
    const run = runner(join(APP_DIR, 'test', 'fixtures', 'pipe-holder'))
    const ac = new AbortController()
    const p = run('hold', [], (pr) => {
      escaped = Number(pr.message)
      ac.abort()
    }, ac.signal)
    try {
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
      const t0 = Date.now()
      await killAllEngines()
      // killTree's 1.5 s grace before SIGKILL, then the 5 s limit on `close`.
      expect(Date.now() - t0).toBeLessThan(9000)
      // The grandchild still holds the engine's stdout, so `close` really could not have fired.
      expect(isAlive(escaped)).toBe(true)
    } finally {
      if (escaped) process.kill(escaped, 'SIGKILL')
    }
  }, 20000)

  it('an already-aborted signal never starts the engine', async () => {
    setupPaths()
    let started = false
    const run = runner(FAKE_ENGINE, {}, () => (started = true))
    const ac = new AbortController()
    ac.abort()
    await expect(run('doctor', [], undefined, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(started).toBe(false)
  })
})
