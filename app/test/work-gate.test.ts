// A job and the listening model's background timing check never run at the same time (main/work-gate.ts), in the
// two windows a review reproduced: a job starting while the check reads its saved settings, and a job starting while
// the check is running, whose cancel rejects before the process has exited.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { RunEngine } from '../src/main/engine'
import { createJobManager } from '../src/main/jobs'
import { createModelManager } from '../src/main/models'
import { modelsDir } from '../src/main/paths'
import { createWorkGate } from '../src/main/work-gate'
import { setupPaths } from './helpers'

it('a job that starts while the check reads its settings, or while it runs, never overlaps it', async () => {
  setupPaths()
  const model = join(modelsDir(), 'small.en')
  mkdirSync(model, { recursive: true })
  for (const f of ['model.bin', 'config.json', 'tokenizer.json']) writeFileSync(join(model, f), 'x')

  // A stand-in engine: work takes 200 ms; a cancel rejects at once and the process exits 100 ms later, like killTree.
  const events: string[] = []
  const engine = ((command: string, _args: string[], _onProgress?: unknown, signal?: AbortSignal, onProcessExit?: () => void) =>
    new Promise((resolve, reject) => {
      events.push(`${command} start`)
      const exit = (): void => {
        events.push(`${command} exit`)
        onProcessExit?.()
      }
      const t = setTimeout(() => {
        exit()
        resolve(command === 'speech-check' ? { threads: 4, runs: [], complete: true } : null)
      }, 200)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject({ code: 'CANCELLED', userMessage: 'Stopped.' })
        setTimeout(exit, 100)
      })
    })) as RunEngine

  const gate = createWorkGate()
  const jobs = createJobManager(() => undefined, () => undefined, undefined, undefined, gate)
  let settings: Promise<null> = Promise.resolve(null)
  const models = createModelManager({
    runEngine: engine,
    onChange: () => undefined,
    loadCheck: () => settings,
    saveCheck: async () => undefined,
    useThreads: () => undefined,
    gate,
    log: () => undefined
  })
  const runJob = async (): Promise<void> => {
    const id = jobs.start(null, 'rerender', async (_emit, signal) => {
      await engine('transcribe', [], undefined, signal)
      return { summary: 'done' }
    })
    await jobs.get(id)!.done
  }

  // 1. The job starts while the check is still reading its saved settings: the check must not start at all.
  let release!: (v: null) => void
  settings = new Promise((r) => (release = r))
  const check1 = models.checkInBackground()
  const job1 = runJob()
  release(null)
  await Promise.all([check1, job1])
  expect(events).toEqual(['transcribe start', 'transcribe exit'])

  // 2. The job starts while the check runs: the check is stopped, and the job's work waits for its process to exit.
  events.length = 0
  settings = Promise.resolve(null)
  const check2 = models.checkInBackground()
  await expect.poll(() => events).toContain('speech-check start')
  await Promise.all([runJob(), check2])
  expect(events).toEqual(['speech-check start', 'speech-check exit', 'transcribe start', 'transcribe exit'])
})
