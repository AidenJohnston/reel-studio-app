import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { copyToCloudDrive, detectCloudDrives } from '../src/main/cloud-drive'

const scratch: string[] = []
async function temp() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'rs-cloud-'))
  scratch.push(dir)
  return dir
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

it('fails if installed macOS cloud folders are not offered', async () => {
  const home = await temp()
  const iCloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  const google = join(home, 'Library', 'CloudStorage', 'GoogleDrive-Creator', 'My Drive')
  await fs.mkdir(iCloud, { recursive: true })
  await fs.mkdir(google, { recursive: true })
  expect(await detectCloudDrives({ platform: 'darwin', home })).toEqual([
    { folder: iCloud, label: 'iCloud Drive' }, { folder: google, label: 'Google Drive' }
  ])
  await fs.rm(iCloud, { recursive: true })
  expect((await detectCloudDrives({ platform: 'darwin', home })).map((drive) => drive.label)).toEqual(['Google Drive'])
})

it('fails if Windows cloud folders, the mirrored My Drive or the mounted Google Drive are missed or listed twice', async () => {
  const home = await temp()
  const mounted = join(home, 'G drive')
  const streamed = join(home, 'H drive')
  const mirrored = join(home, 'My Drive')
  const folders = [join(home, 'iCloudDrive'), join(home, 'Google Drive'), mirrored, join(mounted, 'My Drive')]
  for (const folder of folders) await fs.mkdir(folder, { recursive: true })
  await fs.mkdir(streamed)
  await fs.symlink(mirrored, join(streamed, 'My Drive'), 'junction')
  expect(await detectCloudDrives({ platform: 'win32', home, driveRoots: [mounted, streamed, join(home, 'missing drive')] })).toEqual(
    folders.map((folder, i) => ({ folder, label: i ? 'Google Drive' : 'iCloud Drive' }))
  )
})

it('fails if saving again or concurrently overwrites a reel', async () => {
  const dir = await temp()
  const source = join(dir, 'Family reel.mp4')
  const cloud = join(dir, 'drive')
  await fs.mkdir(join(cloud, 'Reel Studio'), { recursive: true })
  await fs.writeFile(source, 'new video')
  const original = join(cloud, 'Reel Studio', basename(source))
  await fs.writeFile(original, 'previous video')
  const results = await Promise.all([copyToCloudDrive(source, cloud), copyToCloudDrive(source, cloud)])
  expect(results.map((file) => basename(file)).sort()).toEqual(['Family reel (2).mp4', 'Family reel (3).mp4'])
  expect(await fs.readFile(original, 'utf8')).toBe('previous video')
  for (const result of results) expect(await fs.readFile(result, 'utf8')).toBe('new video')
})

it('fails if an interrupted copy exposes a partial reel or leaves its temporary file', async () => {
  const dir = await temp()
  const source = join(dir, 'Family reel.mp4')
  const cloud = join(dir, 'drive')
  await fs.writeFile(source, 'complete video')
  vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (_source, target) => {
    await fs.writeFile(target, 'partial')
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  })
  await expect(copyToCloudDrive(source, cloud)).rejects.toThrow('disk full')
  expect(await fs.readdir(join(cloud, 'Reel Studio'))).toEqual([])
  expect(await fs.readFile(source, 'utf8')).toBe('complete video')
})
