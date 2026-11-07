import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createFootageIndexer } from '../src/main/footage-index'
import { createJobManager } from '../src/main/jobs'
import { addToLibrary } from '../src/main/library'
import type { RunEngine } from '../src/main/engine'
import { setupPaths } from './helpers'
import { ensureRoot } from '../src/main/store'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

it('stops indexing before a job starts and resumes only when all jobs finish', async () => {
  const entered = deferred(), aborted = deferred(), drained = deferred(), jobEntered = deferred(), jobDone = deferred()
  const resumed = deferred(), secondEntered = deferred(), secondDone = deferred()
  let secondCompletion = Promise.resolve()
  let indexing = false
  let runs = 0
  const runEngine: RunEngine = async (_cmd, _args, _progress, signal) => {
    runs++
    if (runs > 1) { resumed.resolve(); return { files: 1, stagesRun: 1, pending: 0 } }
    indexing = true
    entered.resolve()
    signal?.addEventListener('abort', aborted.resolve, { once: true })
    await drained.promise
    indexing = false
    return { files: 1, stagesRun: 1, pending: 2 }
  }
  // idle work is the job manager's last argument, after the work gate and the updater's check
  const jobs = createJobManager(() => {}, () => {}, undefined, undefined, undefined, undefined, {
    pause: () => indexer.pause(), resume: () => indexer.resume()
  })
  const indexer = createFootageIndexer({ runEngine, root: () => 'isolated', busy: () => jobs.runningCount() > 0 })
  const first = indexer.request()
  await entered.promise
  let overlapped = false
  const jobId = jobs.start(null, 'note', async () => {
    overlapped = indexing
    jobEntered.resolve()
    await jobDone.promise
    return { summary: 'Edited' }
  })
  const completion = jobs.get(jobId)!.done
  try {
    await Promise.race([aborted.promise, jobEntered.promise])
    expect(overlapped, 'the job must wait for the index process to drain').toBe(false)
    drained.resolve()
    await jobEntered.promise
    await first
    const secondId = jobs.start(null, 'note', async () => {
      secondEntered.resolve()
      await secondDone.promise
      return { summary: 'Edited another video' }
    })
    secondCompletion = jobs.get(secondId)!.done
    await secondEntered.promise
    await indexer.request()
    expect(runs, 'index requests stay queued while a job holds the lane').toBe(1)
    jobDone.resolve()
    await completion
    expect(runs, 'another running job still holds the lane').toBe(1)
    secondDone.resolve()
    await secondCompletion
    await resumed.promise
    expect(runs).toBe(2)
  } finally {
    drained.resolve()
    jobDone.resolve()
    secondDone.resolve()
    await Promise.all([completion, secondCompletion])
    await indexer.stop()
  }
})

it('adding Library footage schedules another pass and leaves the indexed file alone', async () => {
  const { home, root } = setupPaths()
  await ensureRoot()
  const exec = promisify(execFile)
  const fixture = resolve(__dirname, '../../ai/test/fixtures/index-footage.py')
  const engine = resolve(__dirname, '../../engine')
  const uvArgs = ['run', '--no-project', '--python', '3.11', '--with-editable', `${engine}[dev]`, 'python', fixture, root]
  await exec('uv', uvArgs, { cwd: engine })
  const passes: unknown[] = []
  const runEngine: RunEngine = async (command) => {
    if (command === 'classify') throw new Error('use extension fallback')
    const { stdout } = await exec('uv', [...uvArgs, '--index-only'], { cwd: engine })
    const result: unknown = JSON.parse(stdout.trim().split('\n').at(-1)!)
    passes.push(result)
    return result
  }
  const indexer = createFootageIndexer({ runEngine, root: () => root, busy: () => false })
  let added = Promise.resolve()
  try {
    await indexer.request()
    const file = join(home, 'new.mp4')
    await writeFile(file, Buffer.concat([await readFile(join(root, 'Library/take.mp4')), Buffer.from('new')]))
    const result = await addToLibrary([file], runEngine, () => {}, () => { added = indexer.request() })
    await added
    expect(result[0].dest).toBe(join(root, 'Library/B-roll/new.mp4'))
    expect(passes).toMatchObject([{ files: 1, stagesRun: 0, pending: 0 }, { files: 2, stagesRun: 3, pending: 0 }])
  } finally { await indexer.stop() }
})
