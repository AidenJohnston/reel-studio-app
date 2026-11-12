import { describe, expect, it } from 'vitest'
import { createProxyBuilds, type ExitHooks } from '../src/main/proxy-builds'
import type { RunEngine } from '../src/main/engine'

interface Call {
  args: string[]
  exited: boolean
  fail: (e: unknown) => void
}

/** Runners whose `proxy` behaves like engine.ts's: it runs until told to fail, and on abort the call
 * rejects at once while the process exits (onExit) a little later. */
function controlledEngine() {
  const calls: Call[] = []
  const makeRunner = (hooks: ExitHooks): RunEngine =>
    ((command: string, args: string[], _p?: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        expect(command).toBe('proxy')
        const pid = 1000 + calls.length
        hooks.onSpawn(pid)
        const call: Call = {
          args,
          exited: false,
          fail: (e: unknown) => {
            reject(e)
            exit()
          }
        }
        function exit(): void {
          call.exited = true
          hooks.onExit(pid)
        }
        calls.push(call)
        signal?.addEventListener(
          'abort',
          () => {
            reject({ code: 'CANCELLED' })
            setTimeout(exit, 50)
          },
          { once: true }
        )
      })) as unknown as RunEngine
  return { makeRunner, calls }
}

describe('preview copy builds', () => {
  it('runs one build per project at a time, and a failed one can be started again', async () => {
    const { makeRunner, calls } = controlledEngine()
    const logs: string[] = []
    const builds = createProxyBuilds(makeRunner, (l) => logs.push(l))
    builds.start('a', '/p/a')
    builds.start('a', '/p/a')
    builds.start('b', '/p/b')
    expect(calls.map((c) => c.args[1])).toEqual(['/p/a', '/p/b'])

    calls[0].fail({ message: 'boom' })
    await new Promise((r) => setTimeout(r, 0))
    expect(logs.some((l) => l.includes('a failed: boom'))).toBe(true)
    builds.start('a', '/p/a')
    expect(calls.map((c) => c.args[1])).toEqual(['/p/a', '/p/b', '/p/a'])
  })

  it('stop returns only after the cancelled engine has exited, so the project can be deleted', async () => {
    const { makeRunner, calls } = controlledEngine()
    const builds = createProxyBuilds(makeRunner, () => undefined)
    builds.start('a', '/p/a')
    const first = builds.stop('a')
    await new Promise((r) => setTimeout(r, 10)) // the cancelled call has settled; the engine exits at 50 ms
    builds.start('a', '/p/a') // still shutting down: no second engine
    await builds.stop('a') // a second remove waits for the same exit
    expect(calls[0].exited).toBe(true)
    await first
    expect(calls).toHaveLength(1)
    await builds.stop('never-started')
  })
})
