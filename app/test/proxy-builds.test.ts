import { describe, expect, it, vi } from 'vitest'
import { createProxyBuilds, STILL_STOPPING, type ExitHooks } from '../src/main/proxy-builds'
import type { RunEngine } from '../src/main/engine'

interface Call {
  args: string[]
  exited: boolean
  fail: (e: unknown) => void
  exit: () => void
}

/** Runners whose `proxy` behaves like engine.ts's: it runs until told to fail, and on abort the call
 * rejects at once while the process exits (onExit) a little later. `onAbort`: 'stuck' rejects with
 * ENGINE_STUCK and never exits (Stop could not end it); 'slow' rejects but exits only on `exit()`. */
function controlledEngine(onAbort: 'cancel' | 'stuck' | 'slow' = 'cancel') {
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
          },
          exit: () => exit()
        }
        function exit(): void {
          call.exited = true
          hooks.onExit(pid)
        }
        calls.push(call)
        signal?.addEventListener(
          'abort',
          () => {
            if (onAbort === 'stuck') return reject({ code: 'ENGINE_STUCK', userMessage: 'Restart Reel Studio.' })
            reject({ code: 'CANCELLED' })
            if (onAbort === 'cancel') setTimeout(exit, 50)
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
    builds.start('a', '/p/a', null)
    builds.start('a', '/p/a', null)
    builds.start('b', '/p/b', null)
    expect(calls.map((c) => c.args[1])).toEqual(['/p/a', '/p/b'])

    calls[0].fail({ message: 'boom' })
    await new Promise((r) => setTimeout(r, 0))
    expect(logs.some((l) => l.includes('a failed: boom'))).toBe(true)
    builds.start('a', '/p/a', null)
    expect(calls.map((c) => c.args[1])).toEqual(['/p/a', '/p/b', '/p/a'])
  })

  it('stop returns only after the cancelled engine has exited, so the project can be deleted', async () => {
    const { makeRunner, calls } = controlledEngine()
    const builds = createProxyBuilds(makeRunner, () => undefined)
    builds.start('a', '/p/a', null)
    const first = builds.stop('a')
    await new Promise((r) => setTimeout(r, 10)) // the cancelled call has settled; the engine exits at 50 ms
    builds.start('a', '/p/a', null) // still shutting down: no second engine
    await builds.stop('a') // a second remove waits for the same exit
    expect(calls[0].exited).toBe(true)
    await first
    expect(calls).toHaveLength(1)
    await builds.stop('never-started')
  })

  it("passes the job's owner token, since the job has already written .owner.lock", () => {
    const { makeRunner, calls } = controlledEngine()
    const builds = createProxyBuilds(makeRunner, () => undefined)
    builds.start('a', '/p/a', 'job-token')
    builds.start('b', '/p/b', null)
    expect(calls[0].args).toEqual(['--project', '/p/a', '--owner', 'job-token'])
    expect(calls[1].args).toEqual(['--project', '/p/b'])
  })

  it('stop refuses, and the build stays, while an engine that would not stop may still use the files', async () => {
    const { makeRunner, calls } = controlledEngine('stuck')
    const logs: string[] = []
    const builds = createProxyBuilds(makeRunner, (l) => logs.push(l))
    builds.start('a', '/p/a', 'job')
    await expect(builds.stop('a')).rejects.toMatchObject({ code: 'ENGINE_STUCK' })
    await expect(builds.stop('a')).rejects.toMatchObject({ code: 'ENGINE_STUCK' }) // deleting again is refused too
    builds.start('a', '/p/a', 'job') // no second engine on the same files
    expect(calls).toHaveLength(1)
    expect(logs.some((l) => l.includes('a failed'))).toBe(true)
  })

  it('stop refuses while a cancelled engine has not exited in time, and goes through once it has', async () => {
    vi.useFakeTimers()
    try {
      const { makeRunner, calls } = controlledEngine('slow')
      const builds = createProxyBuilds(makeRunner, () => undefined)
      builds.start('a', '/p/a', 'job')
      const first = builds.stop('a')
      const refused = expect(first).rejects.toBe(STILL_STOPPING)
      await vi.advanceTimersByTimeAsync(15_000)
      await refused
      expect(STILL_STOPPING.userMessage).toBe('Still stopping a background job on this video. Try again in a moment.')
      builds.start('a', '/p/a', 'job')
      expect(calls).toHaveLength(1)
      calls[0].exit()
      await vi.advanceTimersByTimeAsync(0)
      await builds.stop('a') // exited: the project can go now
      builds.start('a', '/p/a', 'job')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
