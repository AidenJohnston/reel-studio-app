import { describe, expect, it } from 'vitest'
import type { RunEngine } from '../src/main/engine'
import { withRenderSlot } from '../src/main/render-slot'

describe('render slot', () => {
  it('passes every argument to the runner, for a render and for any other command', async () => {
    const seen: unknown[][] = []
    // untyped on purpose: a runner argument added after this one (#37's exit callback) must get through too
    const runner = (async (...a: unknown[]) => void seen.push(a)) as unknown as RunEngine
    const run = withRenderSlot(runner, () => undefined).run as unknown as (...a: unknown[]) => Promise<unknown>
    const signal = new AbortController().signal
    const onProgress = (): void => undefined
    const onExit = (): void => undefined
    await run('transcribe', ['--project', 'p'], onProgress, signal, onExit)
    await run('render', ['--project', 'p', '--owner', 't'], onProgress, signal, onExit)
    expect(seen).toEqual([
      ['transcribe', ['--project', 'p'], onProgress, signal, onExit],
      ['render', ['--project', 'p', '--owner', 't'], onProgress, signal, onExit]
    ])
  })

  it('renders take turns first come first served, one stopped while it waits never runs, and one whose engine would not stop keeps the slot', async () => {
    const started: string[] = []
    const finish = new Map<string, (how: 'ok' | 'stuck') => void>()
    const runner: RunEngine = (_command, args) => {
      const name = args[1]
      started.push(name)
      return new Promise((resolve, reject) =>
        finish.set(name, (how) => (how === 'ok' ? resolve({}) : reject({ code: 'ENGINE_STUCK', message: 'still running', userMessage: 'Restart Reel Studio.' })))
      )
    }
    const slot = withRenderSlot(runner, () => undefined)
    const render = (name: string, signal?: AbortSignal) => slot.run('render', ['--project', name], undefined, signal)
    const settle = () => new Promise((r) => setImmediate(r))

    const a = render('a')
    const stopB = new AbortController()
    const b = render('b', stopB.signal)
    const c = render('c')
    void render('d')
    await settle()
    stopB.abort()
    await expect(b).rejects.toMatchObject({ code: 'CANCELLED' })
    finish.get('a')!('ok')
    await a
    await settle()
    expect(started).toEqual(['a', 'c'])

    finish.get('c')!('stuck')
    await expect(c).rejects.toMatchObject({ code: 'ENGINE_STUCK' })
    await settle()
    expect(started).toEqual(['a', 'c'])
  })
})
