import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ModelStatus } from '../src/shared/api'
import { createEngineRunner, type EngineProgress, type RunEngine } from '../src/main/engine'
import { createModelManager, type SpeechCheckResult } from '../src/main/models'
import { engineEnv, modelsDir } from '../src/main/paths'
import { isAlive } from '../src/main/proctree'
import { createWorkGate } from '../src/main/work-gate'
import { FAKE_ENGINE, PYTHON, setupPaths } from './helpers'

it('a speech check that hangs is stopped at its deadline, and the usual thread count is kept', async () => {
  setupPaths()
  const model = join(modelsDir(), 'small.en')
  mkdirSync(model, { recursive: true })
  for (const f of ['model.bin', 'config.json', 'tokenizer.json']) writeFileSync(join(model, f), 'x')

  let pid = 0
  const runEngine = createEngineRunner({
    python: () => PYTHON,
    env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE, FAKE_ENGINE_SPEECH_CHECK: '600' }),
    onSpawn: (p) => (pid = p)
  })
  const saved: SpeechCheckResult[] = []
  const threads: (number | null)[] = []
  const models = createModelManager({
    runEngine,
    onChange: () => undefined,
    loadCheck: async () => null,
    saveCheck: async (r) => void saved.push(r),
    useThreads: (n) => threads.push(n),
    gate: createWorkGate(),
    checkDeadlineMs: 1000,
    log: () => undefined
  })

  const t0 = Date.now()
  await models.checkInBackground()
  expect(Date.now() - t0).toBeLessThan(10_000)
  expect(pid).toBeGreaterThan(0)
  expect(isAlive(pid)).toBe(false)
  expect(saved).toEqual([expect.objectContaining({ threads: null })])
  expect(threads).toEqual([null])
  expect(models.status().checkFailed).toBe(true)
}, 20_000)

it('fails if a resumed download starts its bar from zero instead of the bytes already on disk', async () => {
  // Stand-in pins (test builds read REELSTUDIO_TEST_SPEECH_PINS): a finished 100-byte file and a 1000-byte one stopped
  // at 400. A repo nobody has cached, so no copy on this computer is found first.
  const pins = join(mkdtempSync(join(tmpdir(), 'rs-pins-')), 'pins.json')
  writeFileSync(pins, JSON.stringify({ 'small.en': { repo: 'test/never-cached', revision: 'r1', files: [
    { name: 'config.json', size: 100, sha256: '0'.repeat(64) },
    { name: 'model.bin', size: 1000, sha256: '1'.repeat(64) }
  ] } }))
  vi.stubEnv('REELSTUDIO_TEST', '1')
  vi.stubEnv('REELSTUDIO_TEST_SPEECH_PINS', pins)
  vi.stubEnv('REELENGINE_MODEL', 'small.en')
  onTestFinished(() => void vi.unstubAllEnvs())
  setupPaths()
  const model = join(modelsDir(), 'small.en')
  mkdirSync(model, { recursive: true })
  writeFileSync(join(model, 'config.json'), 'x'.repeat(100))
  writeFileSync(join(model, 'model.bin.part'), 'x'.repeat(400))

  const shown: ModelStatus[] = []
  const models = createModelManager({
    runEngine: async () => null, // the engine's own reports are its test's business (engine test_download_resume.py)
    onChange: (s) => shown.push(s),
    loadCheck: async () => null,
    saveCheck: async () => undefined,
    useThreads: () => undefined,
    gate: createWorkGate(),
    checkDeadlineMs: 1000,
    log: () => undefined
  })
  await models.download()
  expect(shown.find((s) => s.downloading)).toMatchObject({ bytes: 500, total: 1100, pct: 45 })
})

it('fails if a retried download of a model of unknown size shows the percent of the run that was stopped', async () => {
  // No pins for this model (an empty stand-in pin list), so main does not know its size.
  const pins = join(mkdtempSync(join(tmpdir(), 'rs-pins-')), 'pins.json')
  writeFileSync(pins, '{}')
  vi.stubEnv('REELSTUDIO_TEST', '1')
  vi.stubEnv('REELSTUDIO_TEST_SPEECH_PINS', pins)
  vi.stubEnv('REELENGINE_MODEL', 'tiny.en')
  onTestFinished(() => void vi.unstubAllEnvs())
  setupPaths()

  let runs = 0
  const shown: ModelStatus[] = []
  const models = createModelManager({
    // The first run reports 40% and then waits to be stopped; the second reports nothing.
    runEngine: (async (_command: string, _args: string[], onProgress?: (p: EngineProgress) => void, signal?: AbortSignal) => {
      if (runs++ > 0) return null
      onProgress?.({ stage: 'download', pct: 40, message: '' })
      await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject({ code: 'CANCELLED', userMessage: 'Stopped.' })))
    }) as RunEngine,
    onChange: (s) => shown.push(s),
    loadCheck: async () => null,
    saveCheck: async () => undefined,
    useThreads: () => undefined,
    gate: createWorkGate(),
    checkDeadlineMs: 1000,
    log: () => undefined
  })
  const first = models.download()
  await vi.waitFor(() => expect(shown.at(-1)?.pct).toBe(40))
  models.cancel()
  await first
  shown.length = 0
  await models.download()
  expect(shown.find((s) => s.downloading)).toMatchObject({ pct: 0, bytes: 0 })
})
