import { expect, it, vi } from 'vitest'
import { lockProjectEngine } from '../src/main/project-engine'

it('forwards additional caller options unchanged through the project lock, even after cancellation', async () => {
  const onExit = vi.fn()
  const extra = { onExit }
  const controller = new AbortController()
  const signal = controller.signal
  const runner = vi.fn(async (...options: [string, string[], undefined, AbortSignal, typeof extra]) => {
    options[4].onExit()
    return 'finished'
  })
  const run = lockProjectEngine(runner)
  const args = ['--project', '/fixture/project']
  expect(await run('render', args, undefined, signal, extra)).toBe('finished')
  expect(runner).toHaveBeenCalledWith('render', args, undefined, signal, extra)
  controller.abort()
  expect(await run('render', args, undefined, signal, extra)).toBe('finished')
  expect(onExit).toHaveBeenCalledTimes(2)
})
