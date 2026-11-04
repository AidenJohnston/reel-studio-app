import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createEngineRunner } from '../src/main/engine'
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
