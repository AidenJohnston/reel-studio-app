import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createFootageSources, sourceId, type SavedSource } from '../src/main/footage-sources'

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'rs-footage-ü '))
  const root = join(base, 'Movies', 'Reel Studio')
  mkdirSync(root, { recursive: true })
  let saved: SavedSource[] = []
  const changes: number[] = []
  const sources = createFootageSources({
    load: async () => saved,
    save: async (s) => void (saved = s),
    root: () => root,
    changed: () => changes.push(1),
    watch: () => ({ close() {}, on() { return this as never } })
  })
  return { base, root, sources, changes, saved: () => saved }
}

it('fails if a folder that would index Reel Studio itself, or the same videos twice, can be added', async () => {
  const { base, root, sources, saved } = setup()
  const drive = join(base, 'Drive', 'Shoots')
  mkdirSync(join(drive, 'day 1'), { recursive: true })
  await sources.add(drive)
  // its projects and finished reels would be read as footage
  await expect(sources.add(join(base, 'Movies'))).rejects.toMatchObject({ code: 'HOLDS_LIBRARY' })
  await expect(sources.add(join(root, 'Library'))).rejects.toMatchObject({ code: 'INSIDE_LIBRARY' })
  await expect(sources.add(drive)).rejects.toMatchObject({ code: 'ALREADY_ADDED' })
  await expect(sources.add(join(drive, 'day 1'))).rejects.toMatchObject({ code: 'OVERLAPS' })
  await expect(sources.add(join(base, 'Drive'))).rejects.toMatchObject({ code: 'OVERLAPS' })
  await expect(sources.add(join(base, 'missing'))).rejects.toMatchObject({ code: 'NOT_FOLDER' })
  // a link that leads to the Reel Studio folder is that folder (Windows needs Developer Mode to make one)
  let linked = true
  try { symlinkSync(root, join(base, 'shortcut'), 'dir') } catch { linked = false }
  if (linked) await expect(sources.add(join(base, 'shortcut'))).rejects.toMatchObject({ code: 'INSIDE_LIBRARY' })
  expect(saved().map((s) => s.path)).toEqual([drive])
})

it('fails if an unplugged drive is dropped from the index run, or removing a folder leaves it there', async () => {
  const { base, sources, changes } = setup()
  const drive = join(base, 'Drive')
  mkdirSync(drive)
  const [added] = await sources.add(drive)
  expect(changes).toHaveLength(1)
  sources.indexed([{ id: added.id, files: 4, online: true }])
  renameSync(drive, join(base, 'unplugged'))
  // the engine keeps an unplugged folder's analysis only while it is still named in the run
  expect(await sources.indexArgs()).toEqual(['--source', `${added.id}=${drive}`])
  expect(await sources.list()).toMatchObject([{ id: added.id, name: 'Drive', online: false, files: 4 }])
  expect(await sources.remove(added.id)).toEqual([])
  expect(await sources.indexArgs()).toEqual([])
  expect(changes).toHaveLength(2)
})

it('fails if a Footage/ path the editor passes can reach a file outside its folder, or one on an unplugged drive', async () => {
  const { base, sources } = setup()
  const drive = join(base, 'Drive')
  mkdirSync(join(drive, 'day 1'), { recursive: true })
  writeFileSync(join(drive, 'day 1', 'take.mp4'), 'video')
  writeFileSync(join(drive, 'notes.txt'), 'text')
  const secret = join(base, 'secret.mp4')
  writeFileSync(secret, 'not yours to read')
  // Windows makes links only with Developer Mode on; without one there is nothing to follow out
  let linked = true
  try { symlinkSync(secret, join(drive, 'link.mp4')) } catch { linked = false }
  const [s] = await sources.add(drive)
  const id = s.id
  expect((await sources.resolve(`Footage/${id}/day 1/take.mp4`)).abs).toMatch(/take\.mp4$/)
  for (const [ref, code] of [
    [`Footage/${id}/../secret.mp4`, 'BAD_FOOTAGE_PATH'],
    ...(linked ? [[`Footage/${id}/link.mp4`, 'FILE_GONE']] : []),
    [`Footage/${id}/notes.txt`, 'BAD_FOOTAGE_PATH'],
    [`Footage/${id}/day 1/gone.mp4`, 'FILE_GONE'],
    [`Footage/${sourceId(join(base, 'never added'))}/take.mp4`, 'FOLDER_REMOVED'],
    ['Library/B-roll/take.mp4', 'BAD_FOOTAGE_PATH']
  ]) await expect(sources.resolve(ref), ref).rejects.toMatchObject({ code })
  renameSync(drive, join(base, 'unplugged'))
  await expect(sources.resolve(`Footage/${id}/day 1/take.mp4`)).rejects.toMatchObject({ code: 'FOLDER_OFFLINE', userMessage: 'Plug in Drive to use this clip.' })
})
