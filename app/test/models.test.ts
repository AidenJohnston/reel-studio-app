import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createEngineRunner } from '../src/main/engine'
import { createModelManager, modelInstalled, type SpeechCheckResult } from '../src/main/models'
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

it('a result saved by the check from before the GPU was proved runs again once; a current one does not', async () => {
  setupPaths()
  const model = join(modelsDir(), 'small.en')
  mkdirSync(model, { recursive: true })
  for (const f of ['model.bin', 'config.json', 'tokenizer.json']) writeFileSync(join(model, f), 'x')
  const runEngine = createEngineRunner({ python: () => PYTHON, env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE, FAKE_ENGINE_SPEECH_CHECK: '0' }) })
  const checkWith = async (loaded: SpeechCheckResult | null): Promise<SpeechCheckResult[]> => {
    const saved: SpeechCheckResult[] = []
    const models = createModelManager({
      runEngine,
      onChange: () => undefined,
      loadCheck: async () => loaded,
      saveCheck: async (r) => void saved.push(r),
      useThreads: () => undefined,
      gate: createWorkGate(),
      checkDeadlineMs: 15_000,
      log: () => undefined
    })
    await models.checkInBackground()
    return saved
  }
  const [current] = await checkWith(null)
  expect(current).toBeDefined()
  // an NVIDIA computer's record from the old check: this machine, no thread count, no check marker
  expect(await checkWith({ machine: current.machine, threads: null })).toHaveLength(1)
  expect(await checkWith(current)).toHaveLength(0)
}, 60_000)

// A video picked on the welcome starts Version 1 while the welcome's listening download runs; the first edit waits on
// download() (main index.ts startFirstEdit), so a second call must answer only once the files are in.
it('fails if a download asked for while one is under way answers before the listening files are in', async () => {
  setupPaths()
  const hub = process.env.HF_HUB_CACHE
  process.env.HF_HUB_CACHE = mkdtempSync(join(tmpdir(), 'rs-hf-')) // no copy on this computer to reuse
  try {
    const runEngine = createEngineRunner({ python: () => PYTHON, env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE, FAKE_ENGINE_DOWNLOAD_STEP: '0.05' }) })
    const models = createModelManager({
      runEngine,
      onChange: () => undefined,
      loadCheck: async () => null,
      saveCheck: async () => undefined,
      useThreads: () => undefined,
      gate: createWorkGate(),
      checkDeadlineMs: 5000,
      log: () => undefined
    })
    const welcome = models.download()
    const firstEdit = models.download()
    expect((await firstEdit).installed).toBe(true)
    expect(modelInstalled()).toBe(true)
    expect((await welcome).installed).toBe(true)
    await models.checkInBackground()
  } finally {
    if (hub === undefined) delete process.env.HF_HUB_CACHE
    else process.env.HF_HUB_CACHE = hub
  }
}, 20_000)
