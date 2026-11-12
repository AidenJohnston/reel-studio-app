// Stop in the job manager (main/jobs.ts): what the person is told after pressing Stop.
import { describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { createJobManager } from '../src/main/jobs'
import { projectDir, readAppState } from '../src/main/store'
import { setupPaths } from './helpers'

const LEFT_ON = 'I stopped that note, but I couldn\'t undo its change to "Put a yellow box behind the captions." in My style, so please check it there.'

/** A note stopped by the person, ending as @reelstudio/ai ends a stopped note once it is plain data (its toJSON):
 * jobs.ts reads it only after toUserError normalizes it. The chat it leaves. */
async function stopNote(slug: string, extra: Record<string, unknown> = {}) {
  mkdirSync(projectDir(slug), { recursive: true })
  const jobs = createJobManager(() => undefined, () => undefined)
  const id = jobs.start(slug, 'note', (_emit, signal) => new Promise((_ok, fail) => {
    const stopped = () => fail({ code: 'cancelled', userMessage: 'Stopped.', ...extra })
    if (signal.aborted) stopped()
    else signal.addEventListener('abort', stopped)
  }))
  const job = jobs.get(id)!
  jobs.cancel(id)
  await job.done
  return (await readAppState(slug)).chat.map((m) => m.text)
}

describe('Stop', () => {
  it('says nothing, except what the stop could not undo, such as a My style rule left on', async () => {
    setupPaths()
    expect(await stopNote('quiet')).toEqual([])
    expect(await stopNote('left-on', { tellAfterStop: LEFT_ON })).toEqual([LEFT_ON])
  })
})
