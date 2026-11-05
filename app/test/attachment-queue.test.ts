import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { registerAttachmentIpc, readSidecar, unstage, type AttachIpcDeps } from '../src/main/attachments'
import { createJobManager } from '../src/main/jobs'
import { createNoteQueue } from '../src/main/note-queue'
import { takeNote } from '../src/main/note-intake'
import { noteStagingDir } from '../src/main/paths'
import { projectDir, readProject } from '../src/main/store'
import { setupPaths } from './helpers'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { open, promise }
}

function fixture() {
  setupPaths()
  const slug = 'attachment-reel'
  const dir = projectDir(slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ title: slug, version: 1, broll: [] }))
  const jobs = createJobManager(() => undefined, () => undefined)
  const queue = createNoteQueue({ jobs, startNote: async () => 'note', changed: () => undefined, log: () => undefined })
  const handlers = new Map<string, Parameters<AttachIpcDeps['handle']>[1]>()
  const asset = 'work/assets/attach-12345678-picture.png'
  registerAttachmentIpc({
    handle: (ch, fn) => void handlers.set(ch, fn),
    projectDir, readProject,
    log: () => undefined,
    queue: (s, fn, removing) => queue.run(s, fn, removing),
    reserve: (s, fn) => jobs.hold(s, fn),
    refuse: (s) => jobs.refuseIfKeptClosed(s),
    stagingDir: (s) => noteStagingDir(projectDir(s)),
    clipboardImage: async () => null,
    choose: async () => null,
    runEngine: async (_command, args) => {
      const target = args[args.indexOf('--project') + 1]
      await fs.mkdir(join(target, 'work', 'assets'), { recursive: true })
      await fs.writeFile(join(target, asset), 'picture')
      await fs.writeFile(join(target, asset) + '.attach.json', JSON.stringify({ asset, name: 'picture.png', kind: 'image', bytes: 7 }))
      return { asset }
    }
  })
  const call = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({} as IpcMainInvokeEvent, slug, ...args))
  return { slug, dir, jobs, queue, asset, staging: noteStagingDir(dir), call }
}

describe('attachments in the note queue lane', () => {
  it('keeps a staged file when removal races a note that has admitted it', async () => {
    const f = fixture()
    await f.call('notes:attachFiles', ['/tmp/picture.png'])
    f.queue.quit()
    const admitted = gate()
    const finishAdmission = gate()
    const sending = f.queue.send(f.slug, async () => {
      const { note, files } = await takeNote(f.jobs, f.slug, 'use this', [f.asset])
      admitted.open()
      await finishAdmission.promise
      return { text: note, attachments: files }
    }, 1)
    await admitted.promise
    const removing = f.call('notes:removeAttachment', f.asset)
    const result = removing.then(() => null, (e) => e)
    finishAdmission.open()
    await sending
    expect(await result).toMatchObject({ code: 'IN_USE' })
    expect(await readSidecar(f.staging, f.asset)).toMatchObject({ asset: f.asset })
  })

  it('does not recreate staging when attachment admission races project deletion', async () => {
    const f = fixture()
    const deleting = gate()
    const finishDelete = gate()
    const removal = f.queue.remove(f.slug, async () => {
      deleting.open()
      await finishDelete.promise
      await fs.rm(f.staging, { recursive: true, force: true })
      await fs.rm(f.dir, { recursive: true, force: true })
    })
    await deleting.promise
    const attachment = f.call('notes:attachFiles', ['/tmp/picture.png']).then(() => null, (e) => e)
    finishDelete.open()
    await removal
    expect(await attachment).toMatchObject({ code: 'NOT_FOUND' })
    expect(existsSync(f.staging)).toBe(false)
  })

  it('removes duplicate staging files after an interrupted unstage', async () => {
    const f = fixture()
    await f.call('notes:attachFiles', ['/tmp/picture.png'])
    const attachment = (await readSidecar(f.staging, f.asset))!
    await fs.mkdir(join(f.dir, 'work', 'assets'), { recursive: true })
    await fs.copyFile(join(f.staging, f.asset), join(f.dir, f.asset))
    await fs.copyFile(join(f.staging, f.asset) + '.attach.json', join(f.dir, f.asset) + '.attach.json')
    await unstage(f.dir, f.staging, [attachment])
    expect(await readSidecar(f.dir, f.asset)).toEqual(attachment)
    expect(existsSync(join(f.staging, f.asset))).toBe(false)
    expect(existsSync(join(f.staging, f.asset) + '.attach.json')).toBe(false)
  })

  it('removes orphaned staging at startup after its project was deleted', async () => {
    const f = fixture()
    await f.call('notes:attachFiles', ['/tmp/picture.png'])
    await fs.rm(f.dir, { recursive: true, force: true })
    await f.queue.recover()
    expect(existsSync(f.staging)).toBe(false)
  })
})
