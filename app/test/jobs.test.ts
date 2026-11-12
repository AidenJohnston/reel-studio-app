// The job lane once part of a job's engine would not stop (ENGINE_STUCK): the video stays closed for
// the rest of the session, nothing cleans up after that engine, and nothing else writes to the video.
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import type { IpcMainInvokeEvent } from 'electron'
import { registerAttachmentIpc, type AttachIpcDeps } from '../src/main/attachments'
import { takeNote } from '../src/main/note-intake'
import { projectDir, readAppState, recoverInterrupted, updateAppState } from '../src/main/store'
import { setupPaths } from './helpers'

// Off: the real fs.promises.rm. On: removing that one path is refused, as Windows refuses while a file in
// it is open (a player, a virus scanner).
const refuseRm = vi.hoisted(() => ({ path: '', refused: 0, code: 'EPERM' }))
vi.mock(import('node:fs'), async (real) => {
  const fs = await real()
  return {
    ...fs,
    promises: {
      ...fs.promises,
      rm: async (...args: Parameters<typeof fs.promises.rm>) => {
        if (String(args[0]) === refuseRm.path) {
          refuseRm.refused++
          throw Object.assign(new Error(`${refuseRm.code}: rm '${args[0]}'`), { code: refuseRm.code })
        }
        return fs.promises.rm(...args)
      }
    }
  }
})

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

describe('a job whose unfinished version cannot be removed', () => {
  it('leaves it for the next start, which removes it without reporting the job as cut short', async () => {
    setupPaths()
    const slug = 'locked-reel'
    const dir = projectDir(slug)
    const partial = join(dir, 'versions', 'v2')
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(partial, '.rendering'), '')
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ broll: [] }))
    const logs: string[] = []
    const jobs = createJobManager(() => undefined, (line) => logs.push(line))
    refuseRm.path = partial
    refuseRm.refused = 0
    try {
      const id = jobs.start(slug, 'rerender', async () => {
        throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' }
      })
      await jobs.get(id)!.done
    } finally {
      refuseRm.path = ''
    }
    expect(refuseRm.refused).toBe(1)
    expect(existsSync(partial)).toBe(true)
    expect(logs).toContainEqual(expect.stringMatching(/could not remove an unfinished version/))

    // a start while the file is still held open does not fail, and the mark stays for the next one
    refuseRm.path = partial
    try {
      expect(await recoverInterrupted()).toEqual([])
    } finally {
      refuseRm.path = ''
    }
    expect(refuseRm.refused).toBe(2)
    expect(existsSync(partial)).toBe(true)

    // the next start
    expect(await recoverInterrupted()).toEqual([slug])
    expect(existsSync(partial)).toBe(false)
    const s = await readAppState(slug)
    expect(s.lastError?.code).toBe('RENDER_FAILED')
    expect(s.chat.map((m) => m.text)).not.toContainEqual(expect.stringMatching(/closed before I finished/))
    expect(await recoverInterrupted()).toEqual([])
  })

  /** Projects a crash left with a job in app.json and an unfinished version 2. */
  async function interrupted(...slugs: string[]) {
    setupPaths()
    for (const slug of slugs) {
      mkdirSync(join(projectDir(slug), 'versions', 'v2'), { recursive: true })
      writeFileSync(join(projectDir(slug), 'versions', 'v2', '.rendering'), '')
      await updateAppState(slug, (s) => {
        s.job = { id: `job-${slug}`, kind: 'rerender', startedAt: new Date().toISOString() }
      })
    }
    return (slug: string) => join(projectDir(slug), 'versions', 'v2')
  }

  it('a start that still cannot remove one project\'s version settles its job, keeps the mark, and recovers the projects after it', async () => {
    const v2 = await interrupted('a-held', 'b-next')
    // its job was recorded, and so was a clean-up it owed
    await updateAppState('a-held', (s) => {
      s.cleanupOwed = true
    })
    refuseRm.path = v2('a-held')
    refuseRm.refused = 0
    try {
      expect((await recoverInterrupted()).sort()).toEqual(['a-held', 'b-next'])
    } finally {
      refuseRm.path = ''
    }
    expect(refuseRm.refused).toBe(1)
    expect(existsSync(v2('b-next'))).toBe(false)
    expect((await readAppState('b-next')).job).toBeNull()
    const held = await readAppState('a-held')
    expect(held.job).toBeNull()
    expect(held.cleanupOwed).toBe(true)
    expect(existsSync(v2('a-held'))).toBe(true)

    // the next start
    expect(await recoverInterrupted()).toEqual(['a-held'])
    expect(existsSync(v2('a-held'))).toBe(false)
    expect((await readAppState('a-held')).cleanupOwed).toBeUndefined()
  })

  it('a removal that fails for another reason than a refusal still stops the start\'s recovery', async () => {
    const v2 = await interrupted('broken')
    refuseRm.path = v2('broken')
    refuseRm.code = 'EIO'
    try {
      await expect(recoverInterrupted()).rejects.toMatchObject({ code: 'EIO' })
    } finally {
      refuseRm.path = ''
      refuseRm.code = 'EPERM'
    }
  })
})
