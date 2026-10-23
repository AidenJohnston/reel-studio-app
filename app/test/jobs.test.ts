// The job lane once part of a job's engine would not stop (ENGINE_STUCK): the video stays closed for
// the rest of the session, nothing cleans up after that engine, and nothing else writes to the video.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { OWNER_LOCK } from '../src/main/owner'
import type { IpcMainInvokeEvent } from 'electron'
import { registerAttachmentIpc, type AttachIpcDeps } from '../src/main/attachments'
import { takeNote } from '../src/main/note-intake'
import { projectDir } from '../src/main/store'
import { setupPaths } from './helpers'

const STUCK = { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop. Restart Reel Studio before you change this video again." }

/** A video whose first edit ended with ENGINE_STUCK while version 2 was still being written. */
async function stuckVideo() {
  setupPaths()
  const slug = 'stuck-reel'
  const dir = projectDir(slug)
  const partial = join(dir, 'versions', 'v2')
  mkdirSync(partial, { recursive: true })
  writeFileSync(join(partial, '.rendering'), '')
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ broll: [] }))
  const jobs = createJobManager(() => undefined, () => undefined)
  let appJsonWhileRunning = ''
  const id = jobs.start(slug, 'first-edit', async () => {
    appJsonWhileRunning = readFileSync(join(dir, 'app.json'), 'utf8')
    throw STUCK
  })
  await jobs.get(id)!.done
  return { slug, dir, partial, jobs, id, appJsonWhileRunning }
}

describe('a job whose engine would not stop', () => {
  it('keeps the video closed, its partial version in place and app.json as the job left it', async () => {
    const { slug, dir, partial, jobs, id, appJsonWhileRunning } = await stuckVideo()
    expect(jobs.isClosed(slug)).toBe(true)
    expect(() => jobs.refuseIfBusy(slug)).toThrow(expect.objectContaining(STUCK))
    expect(() => jobs.start(slug, 'rerender', async () => ({ summary: 'never runs' }))).toThrow(expect.objectContaining(STUCK))
    expect(jobs.runningCount()).toBe(0)
    // the engine may still be writing: no cleanup, and app.json still records the job for the next start
    expect(existsSync(join(partial, '.rendering'))).toBe(true)
    expect(readFileSync(join(dir, 'app.json'), 'utf8')).toBe(appJsonWhileRunning)
    expect(JSON.parse(appJsonWhileRunning).job.id).toBe(id)
    // the job never lets go of the project, so the engine and AI CLIs run by hand stay out too
    expect(existsSync(join(dir, OWNER_LOCK))).toBe(true)
    // other videos are not affected
    expect(jobs.isClosed('another-reel')).toBe(false)
  })

  it('refuses every attachment change with the "would not stop" message, before the engine runs', async () => {
    const { slug, dir, jobs } = await stuckVideo()
    const asset = 'work/assets/attach-2a000000-meme.png'
    mkdirSync(join(dir, 'work', 'assets'), { recursive: true })
    writeFileSync(join(dir, ...asset.split('/')), 'x')
    writeFileSync(join(dir, ...asset.split('/')) + '.attach.json', JSON.stringify({ asset, name: 'meme.png', kind: 'image', bytes: 1 }))
    const engineCalls: string[] = []
    const handlers = new Map<string, Parameters<AttachIpcDeps['handle']>[1]>()
    registerAttachmentIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      runEngine: async (cmd) => void engineCalls.push(cmd),
      log: () => undefined,
      projectDir,
      readProject: async () => {
        throw new Error('a closed video is never read')
      },
      busy: (s) => jobs.isClosed(s),
      refuse: (s) => jobs.refuseIfBusy(s),
      clipboardImage: async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) }),
      choose: async () => ['/tmp/a.png']
    })
    const noEvent = {} as IpcMainInvokeEvent // the handlers never read it
    const call = (ch: string, ...a: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!(noEvent, slug, ...a))
    await expect(call('notes:attachFiles', ['/tmp/a.png'])).rejects.toMatchObject(STUCK)
    await expect(call('notes:attachData', { name: 'a.png', mime: 'image/png', bytes: new Uint8Array([1]) })).rejects.toMatchObject(STUCK)
    await expect(call('notes:attachClipboard')).rejects.toMatchObject(STUCK)
    await expect(call('notes:chooseAttachment')).rejects.toMatchObject(STUCK)
    await expect(call('notes:removeAttachment', asset)).rejects.toMatchObject(STUCK)
    expect(engineCalls).toEqual([])
    expect(existsSync(join(dir, ...asset.split('/')))).toBe(true)
  })

  it('refuses a note with the "would not stop" message before it reaches the chat', async () => {
    const { slug, jobs } = await stuckVideo()
    await expect(takeNote(jobs, slug, 'make the captions bigger', undefined)).rejects.toMatchObject(STUCK)
  })
})
