import { describe, expect, it } from 'vitest'
import { createProxyBuilds } from '../src/main/proxy-builds'
import type { RunEngine } from '../src/main/engine'

/** An engine runner whose `proxy` runs until it is told to finish or is aborted, like the real one. */
interface Call {
  args: string[]
  exited: boolean
  finish: (v: unknown) => void
  fail: (e: unknown) => void
}

function controlledEngine() {
  const calls: Call[] = []
  const runEngine = ((command: string, args: string[], _p?: unknown, signal?: AbortSignal) =>
    new Promise((resolve, reject) => {
      expect(command).toBe('proxy')
      const call: Call = {
        args,
        exited: false,
        finish: (v: unknown) => {
          call.exited = true
          resolve(v)
        },
        fail: (e: unknown) => {
          call.exited = true
          reject(e)
        }
      }
      calls.push(call)
      signal?.addEventListener('abort', () => setTimeout(() => call.fail({ code: 'CANCELLED' }), 20), { once: true })
    })) as unknown as RunEngine
  return { runEngine, calls }
}

describe('preview copy builds', () => {
  it('runs one build per project at a time, and a finished or failed one can be started again', async () => {
    const { runEngine, calls } = controlledEngine()
    const logs: string[] = []
    const builds = createProxyBuilds(runEngine, (l) => logs.push(l))
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

  it('stop cancels the running build', async () => {
    const { runEngine, calls } = controlledEngine()
    const builds = createProxyBuilds(runEngine, () => undefined)
    builds.start('a', '/p/a')
    await builds.stop('a')
    expect(calls[0].exited).toBe(true)
    await builds.stop('never-started')
  })
})
