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
})
