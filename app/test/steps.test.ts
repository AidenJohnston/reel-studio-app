// The first edit's rows, fed the status lines real runs logged (main.log, 2026-10-22) through the job manager.
import { describe, expect, it } from 'vitest'
import { createJobManager } from '../src/main/jobs'
import type { JobEvent, JobUpdate, Phase } from '../src/shared/api'
import type { Step, StepId } from '../src/shared/steps'

type Line = [message: string, phase?: Phase, noAI?: true]

// Sam's run with no AI editor: build 3df7d6b, redesign-build/try, 84 s.
const LISTEN_AND_RETAKES: Line[] = [
  ['Copying your video'],
  ['Listening to your video', 'listen'],
  ['Getting your video ready', 'listen'],
  ['Waking up the listening model', 'listen'],
  ['Finished listening', 'listen'],
  ['Finding your retakes', 'analyze'],
  ['Looking for your best takes', 'analyze'],
  ['Picking your best takes', 'analyze'],
  ['Found your best takes', 'analyze']
]
const FINAL_RENDER: Line[] = [
  ['Getting your video ready', 'final'],
  ['Cutting your sound', 'final'],
  ['Adding music', 'final'],
  ['Balancing the sound', 'final'],
  ['Writing your captions', 'final'],
  ['Making your video', 'final'],
  ['Making your cover', 'final'],
  ['Checking your video', 'final'],
  ['Your video is ready', 'final']
]
const simple = (lines: Line[]): Line[] => lines.map(([m, p]) => [m, p, true])
const NO_AI: Line[] = [
  ...LISTEN_AND_RETAKES,
  ['Cutting out the pauses', undefined, true],
  ['Your first cut is ready', undefined, true],
  ...simple(FINAL_RENDER)
]

// The coordinator's run with Claude (redesign-build/try-walk, 141 s): previews rendered inside the edit, then a
// second look ("Checking your captions", "Watching your video and planning the edit") before the final video.
const PREVIEW: Line[] = [['Making a preview'], ['Getting your video ready'], ['Cutting your sound'], ['Placing your pictures'], ['Writing your captions'], ['Making your video'], ['Making your cover'], ['Your video is ready']]
const WITH_AI: Line[] = [
  ...LISTEN_AND_RETAKES,
  ['Watching your video and planning the edit', 'edit'],
  ['Picking your best takes', 'edit'],
  ['Adding pictures', 'edit'],
  ['Choosing a cover', 'edit'],
  ...PREVIEW,
  ['Looking over the preview', 'edit'],
  ['Adding pictures', 'edit'],
  ...PREVIEW,
  ['Almost done', 'edit'],
  ['Checking your captions', 'edit'],
  ['Watching your video and planning the edit', 'edit'],
  ['Almost done', 'edit'],
  ['Finishing your video', 'final'],
  ['Making the final video'],
  ...FINAL_RENDER.map(([m]): Line => [m])
]

/** The rows the job reported right after each line. A JobUpdate goes through as it is. */
async function replay(lines: (Line | JobUpdate)[]): Promise<{ after: (message: string, nth?: number) => Step[]; all: Step[][] }> {
  const events: JobEvent[] = []
  const jobs = createJobManager((e) => events.push(e), () => undefined)
  const seen: { message: string; steps: Step[] }[] = []
  await new Promise<void>((resolve) => {
    jobs.start(null, 'first-edit', async (emit) => {
      for (const line of lines) {
        const before = events.length
        const update: JobUpdate = Array.isArray(line)
          ? { type: 'status', message: line[0], pct: 0, ...(line[1] ? { phase: line[1] } : {}), ...(line[2] ? { noAI: line[2] } : {}) }
          : line
        emit(update)
        const e = events.slice(before).find((x) => x.type === 'status')
        if (update.type === 'status' && e?.type === 'status' && e.steps) seen.push({ message: update.message, steps: e.steps })
      }
      resolve()
      return { summary: 'ok' }
    })
  })
  return {
    all: seen.map((s) => s.steps),
    after: (message, nth = 0) => seen.filter((s) => s.message === message)[nth].steps
  }
}

const state = (steps: Step[], id: StepId) => steps.find((s) => s.id === id)!.state

describe('first edit rows', () => {
  it('fails if a row the work has not reached is shown done when the final video starts (Sam, no AI)', async () => {
    const r = await replay(NO_AI)
    const start = r.after('Getting your video ready', 1)
    expect(state(start, 'retakes')).toBe('done')
    expect(state(start, 'sound')).toBe('now')
    for (const id of ['subtitles', 'video', 'cover', 'check'] as StepId[]) expect(state(start, id)).toBe('todo')
    const encode = r.after('Making your video')
    expect(state(encode, 'subtitles')).toBe('done')
    expect(state(encode, 'video')).toBe('now')
  })

  it('fails if the AI row is ticked done in an edit made without an AI editor', async () => {
    const r = await replay(NO_AI)
    const row = r.after('Your video is ready').find((s) => s.id === 'edit')!
    expect(row.state).toBe('skipped')
  })

  it('fails if previews or the second look inside the AI edit move the rows forward or back', async () => {
    const r = await replay(WITH_AI)
    const edit = r.all.slice(r.all.findIndex((s) => state(s, 'edit') === 'now'), r.all.findIndex((s) => state(s, 'sound') === 'now'))
    expect(edit.length).toBeGreaterThan(20)
    for (const steps of edit) expect(steps.filter((s) => s.state === 'now').map((s) => s.id)).toEqual(['edit'])
    const order = r.all.map((s) => s.findIndex((x) => x.state === 'now'))
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1])
    const end = r.after('Checking your video')
    expect(end.filter((s) => s.state === 'done').map((s) => s.id)).toEqual(['copy', 'listen', 'retakes', 'edit', 'sound', 'subtitles', 'video', 'cover'])
  })

  it("fails if the engine's line on a slow listen is not beside Listening, or stays once the words are heard", async () => {
    // the engine's CPU fallback on a computer with an NVIDIA card it can't use (transcribe.py CPU_FALLBACK_NOTE)
    const note = 'Slower: listening on the processor, not your graphics card'
    const r = await replay([
      ['Listening to your video', 'listen'],
      ['Waking up the listening model', 'listen'],
      { type: 'status', message: 'Listening to your video', pct: 9, phase: 'listen', note },
      ['Listening to your video', 'listen'],
      { type: 'heard', words: ['And', 'so'] },
      ['Finding your retakes', 'analyze']
    ])
    const listen = (steps: Step[]) => steps.find((s) => s.id === 'listen')!
    expect(listen(r.after('Listening to your video', 2))).toEqual({ id: 'listen', state: 'now', result: note })
    expect(listen(r.after('Finding your retakes'))).toEqual({ id: 'listen', state: 'done', result: '2 words' })
  })

  it('fails if the AI row says done when the AI stopped and the simple edit stepped in', async () => {
    const r = await replay([...LISTEN_AND_RETAKES, ['Picking your best takes', 'edit'], ['Cutting out the pauses', undefined, true], ...simple(FINAL_RENDER)])
    expect(state(r.after('Cutting your sound'), 'edit')).toBe('stopped')
  })
})
