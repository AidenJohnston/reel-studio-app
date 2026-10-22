import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { CloudDrive } from '../shared/api'

const exec = promisify(execFile)

export async function detectCloudDrives({ platform, home, driveRoots = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`) }: {
  platform: NodeJS.Platform
  home: string
  driveRoots?: string[]
}): Promise<CloudDrive[]> {
  const drives: CloudDrive[] = []
  const add = async (folder: string, label: CloudDrive['label']) => {
    if ((await fs.stat(folder).catch(() => null))?.isDirectory()) drives.push({ folder, label })
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
    for (const root of driveRoots) await add(join(root, 'My Drive'), 'Google Drive')
  }
  return drives
}

// Node's rename overwrites existing files. RENAME_EXCL on macOS and os.rename on Windows refuse that race.
const RENAME = `
import ctypes, os, sys
source, target = sys.argv[1:]
try:
    if sys.platform == 'darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        if rename(os.fsencode(source), os.fsencode(target), 0x00000004):
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
    else:
        os.rename(source, target)
except FileExistsError:
    sys.exit(17)
`

export async function copyToCloudDrive(source: string, folder: string, python: string): Promise<string> {
  const destination = join(folder, 'Reel Studio')
  await fs.mkdir(destination, { recursive: true })
  const temp = join(destination, `.${randomUUID()}.tmp`)
  const ext = extname(source)
  const stem = basename(source, ext)
  try {
    await fs.copyFile(source, temp, constants.COPYFILE_EXCL)
    for (let n = 1; ; n++) {
      const target = join(destination, `${stem}${n === 1 ? '' : ` (${n})`}${ext}`)
      try {
        await exec(python, ['-I', '-B', '-c', RENAME, temp, target], { windowsHide: true })
        return target
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 17) continue
        throw error
      }
    }
  } finally {
    await fs.rm(temp, { force: true })
  }
}
