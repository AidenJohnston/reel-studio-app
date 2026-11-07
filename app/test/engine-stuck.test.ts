// Stop on an engine the OS cannot kill (engine.ts onAbort). Its own file: the kill has to fail, so killTree is replaced
// for every test here; the real one cleans up after.
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { engineEnv } from '../src/main/paths'
import { APP_DIR, PYTHON, setupPaths } from './helpers'

vi.mock('../src/main/proctree', async (original) => ({
  ...(await original<typeof import('../src/main/proctree')>()),
  // the process survives SIGKILL, as one stuck in uninterruptible disk or device I/O does
  killTree: vi.fn(async () => false)
}))

it('fails if Stop never settles when the engine survives being killed', async () => {
  setupPaths()
  let pid = 0
  const run = createEngineRunner({
    python: () => PYTHON,
    env: () => ({ ...engineEnv(), PYTHONPATH: join(APP_DIR, 'test', 'fixtures', 'sleeper') }),
    onSpawn: (p) => (pid = p)
  })
  const ac = new AbortController()
  let grandchild = 0
  try {
    const p = run('sleep', [], (pr) => {
      grandchild = Number(pr.message)
      ac.abort()
    }, ac.signal)
    // the sleeper never exits on its own within this test: only the failed kill can end the job
    await expect(p).rejects.toMatchObject({ code: 'ENGINE_STUCK' })
  } finally {
    const { killTree } = await vi.importActual<typeof import('../src/main/proctree')>('../src/main/proctree')
    if (pid) await killTree(pid)
    if (grandchild) {
      try {
        process.kill(grandchild, 'SIGKILL')
      } catch {
        /* already gone with its group */
      }
    }
  }
}, 20000)
