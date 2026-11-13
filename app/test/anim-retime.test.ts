import { describe, expect, it } from 'vitest'
import { untilStopped, withAnimationRetiming } from '../src/main/anim-retime'
import type { RunEngine } from '../src/main/engine'

const job = { id: 'b2', template: 'big-quote', params: { text: 'Done is better', wordTimes: [0.13, 0.4, 0.7] }, out: '/p/work/animations/big-quote-abc.mov' }

function fakeEngine(jobs: unknown): { run: RunEngine; calls: string[] } {
  const calls: string[] = []
  const run: RunEngine = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`)
    if (command === 'anim-jobs') {
      if (jobs instanceof Error) throw jobs
      return { jobs }
    }
    return { version: 3 }
  }
  return { run, calls }
}

describe('withAnimationRetiming', () => {
  it('renders the re-timed animations before a render, then renders', async () => {
    const { run, calls } = fakeEngine([job])
    const rendered: unknown[] = []
    const wrapped = withAnimationRetiming(run, async (template, params, out) => {
      calls.push(`animation ${template}`)
      rendered.push({ template, params, out })
      return out
    })
    expect(await wrapped('render', ['--project', '/p', '--draft'])).toEqual({ version: 3 })
    expect(calls).toEqual(['anim-jobs --project /p', 'animation big-quote', 'render --project /p --draft'])
    expect(rendered).toEqual([{ template: job.template, params: job.params, out: job.out }])
  })

  it('leaves every other command alone', async () => {
    const { run, calls } = fakeEngine([job])
    const wrapped = withAnimationRetiming(run, async () => {
      throw new Error('not expected')
    })
    await wrapped('anim-context', ['--project', '/p', '--from', 'w1', '--to', 'w4'])
    expect(calls).toEqual(['anim-context --project /p --from w1 --to w4'])
  })

  it('still renders when an animation or the job list fails (the old clip plays)', async () => {
    const lines: string[] = []
    const failing = fakeEngine([job, { ...job, id: 'b5' }])
    const wrapped = withAnimationRetiming(failing.run, async () => {
      throw new Error('renderer crashed')
    }, (l) => lines.push(l))
    expect(await wrapped('render', ['--project', '/p'])).toEqual({ version: 3 })
    expect(lines.filter((l) => l.includes('the old one plays'))).toHaveLength(2)

    const noList = fakeEngine(new Error('older engine'))
    expect(await withAnimationRetiming(noList.run, async (_t, _p, out) => out)('render', ['--project', '/p'])).toEqual({ version: 3 })
    expect(noList.calls).toEqual(['anim-jobs --project /p', 'render --project /p'])
  })

  it('Stop during an animation ends the job: the signal reaches the renderer and nothing renders after it', async () => {
    const { run, calls } = fakeEngine([job, { ...job, id: 'b5' }])
    const stop = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    const wrapped = withAnimationRetiming(run, async (_t, _p, _out, signal) => {
      seen.push(signal)
      stop.abort()
      throw { code: 'CANCELLED', userMessage: 'Stopped.' }
    })
    await expect(wrapped('render', ['--project', '/p'], undefined, stop.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(seen).toEqual([stop.signal])
    expect(calls).toEqual(['anim-jobs --project /p'])
  })

  it('Stop ends the wait at once, even for a render that never finishes (queued behind another)', async () => {
    const { run, calls } = fakeEngine([job])
    const stop = new AbortController()
    const wrapped = withAnimationRetiming(run, () => new Promise<string>(() => {}))
    const done = wrapped('render', ['--project', '/p'], undefined, stop.signal)
    await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    await expect(done).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(calls).toEqual(['anim-jobs --project /p'])
    await expect(untilStopped(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7)
  })
})
