// Runs the engine runner against the REAL engine. Skipped unless REELSTUDIO_REAL_ENGINE_DIR is set:
//   REELSTUDIO_REAL_ENGINE_DIR=<repo>/engine  REELSTUDIO_REAL_MODELS=<models dir>  REELENGINE_MODEL=base.en
//   REELSTUDIO_E2E_VIDEO=<a raw take>   npx vitest run test/real-engine.test.ts
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { engineEnv } from '../src/main/paths'
import { makeClip, setupPaths } from './helpers'

const ENGINE = process.env.REELSTUDIO_REAL_ENGINE_DIR
const venvPy = (dir: string): string =>
  process.platform === 'win32' ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python')

describe.skipIf(!ENGINE)('real engine through the runner', () => {
  const stderr: string[] = []
  const run = createEngineRunner({
    python: () => venvPy(ENGINE!),
    env: () => ({
      ...engineEnv(),
      PYTHONPATH: ENGINE!,
      ...(process.env.REELSTUDIO_REAL_MODELS ? { REELENGINE_MODELS: process.env.REELSTUDIO_REAL_MODELS } : {})
    }),
    log: (l) => stderr.push(l)
  })

  it('probe, classify, init, transcribe, analyze, autocut, render --draft', async () => {
    const { home, root } = setupPaths()
    const video = process.env.REELSTUDIO_E2E_VIDEO ?? makeClip(join(home, 'take ü.mp4'), 6)
    const probe = (await run('probe', [video])) as { kind: string; duration: number }
    expect(probe.duration).toBeGreaterThan(1)

    const doc = join(home, 'notes ü.txt')
    writeFileSync(doc, 'hello')
    const cls = (await run('classify', ['--root', root, doc])) as { files: { dest?: string; userMessage?: string }[] }
    expect(cls.files[0].dest).toBeUndefined()
    expect(cls.files[0].userMessage).toBeTruthy()

    const project = join(root, 'Projects', 'réel test')
    mkdirSync(project, { recursive: true })
    await run('init', ['--project', project, '--title', 'Réel test', '--slug', 'reel-test', video])
    const msgs: string[] = []
    const t0 = Date.now()
    await run('transcribe', ['--project', project], (p) => msgs.push(`${Math.round(p.pct)} ${p.message}`))
    const tTranscribe = Date.now() - t0
    expect(existsSync(join(project, 'work', 'transcript.json'))).toBe(true)
    await run('analyze', ['--project', project])
    await run('autocut', ['--project', project])
    const r = (await run('render', ['--project', project, '--draft'])) as { version: number; file: string }
    expect(r.version).toBe(1)
    expect(existsSync(r.file)).toBe(true)
    console.log(`transcribe ${tTranscribe} ms; progress: ${msgs.slice(0, 3).join(' | ')} ... ${msgs.at(-1)}; render ${r.file}`)
  }, 900_000)

  it('offline model download fails with a plain sentence', async () => {
    const { home } = setupPaths()
    const offline = createEngineRunner({
      python: () => venvPy(ENGINE!),
      env: () => ({ ...engineEnv(), PYTHONPATH: ENGINE!, REELENGINE_MODELS: join(home, 'models'), REELENGINE_MODEL_MIRROR: 'http://127.0.0.1:9' })
    })
    const err = (await offline('download-model', ['--name', 'tiny.en']).catch((e) => e)) as { code: string; userMessage: string }
    expect(err.code).toBe('OFFLINE')
    expect(err.userMessage).toMatch(/internet/i)
  }, 120_000)
})
