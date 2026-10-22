import { randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { CloudDrive } from '../shared/api'

export async function detectCloudDrives({ platform, home, driveRoots = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`) }: {
  platform: NodeJS.Platform
  home: string
  driveRoots?: string[]
}): Promise<CloudDrive[]> {
  const drives: CloudDrive[] = []
  const seen = new Set<string>()
  const add = async (folder: string, label: CloudDrive['label']) => {
    if (!(await fs.stat(folder).catch(() => null))?.isDirectory()) return
    const real = await fs.realpath(folder)
    if (seen.has(real)) return
    seen.add(real)
    drives.push({ folder, label })
  }
  if (platform === 'darwin') {
    await add(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), 'iCloud Drive')
    const storage = join(home, 'Library', 'CloudStorage')
    for (const entry of await fs.readdir(storage).catch(() => [])) {
      if (entry.startsWith('GoogleDrive-')) await add(join(storage, entry, 'My Drive'), 'Google Drive')
    }
  } else if (platform === 'win32') {
    await add(join(home, 'iCloudDrive'), 'iCloud Drive')
    await add(join(home, 'Google Drive'), 'Google Drive')
    await add(join(home, 'My Drive'), 'Google Drive')
    for (const root of driveRoots) await add(join(root, 'My Drive'), 'Google Drive')
  }
  return drives
}

export async function copyToCloudDrive(source: string, folder: string): Promise<string> {
  const destination = join(folder, 'Reel Studio')
  await fs.mkdir(destination, { recursive: true })
  const temp = join(destination, `.${randomUUID()}.tmp`)
  const ext = extname(source)
  const stem = basename(source, ext)
  for (let n = 1; ; n++) {
    const target = join(destination, `${stem}${n === 1 ? '' : ` (${n})`}${ext}`)
    let reservation
    try {
      reservation = await fs.open(target, 'wx')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
    try {
      await reservation.close()
      await fs.copyFile(source, temp, constants.COPYFILE_EXCL)
      await fs.rename(temp, target)
      return target
    } catch (error) {
      await Promise.all([fs.rm(temp, { force: true }), fs.rm(target, { force: true })])
      throw error
    }
  }
}
