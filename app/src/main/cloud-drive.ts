import { randomUUID } from 'node:crypto'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { CloudDrive } from '../shared/api'

interface DriveOptions {
  platform: NodeJS.Platform
  home: string
  /** Windows drive letters where Google Drive may mount its streaming drive. Tests pass fake roots. */
  driveRoots?: string[]
}

const DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
const GOOGLE_ACCOUNT = 'GoogleDrive-'

// Folders that need no listing to find, in the order they are offered.
function knownFolders({ platform, home, driveRoots = DRIVE_LETTERS }: DriveOptions): CloudDrive[] {
  if (platform === 'darwin') return [{ folder: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), label: 'iCloud Drive' }]
  if (platform !== 'win32') return []
  return [
    { folder: join(home, 'iCloudDrive'), label: 'iCloud Drive' },
    { folder: join(home, 'Google Drive'), label: 'Google Drive' },
    { folder: join(home, 'My Drive'), label: 'Google Drive' },
    ...driveRoots.map((root): CloudDrive => ({ folder: join(root, 'My Drive'), label: 'Google Drive' }))
  ]
}

// Google Drive for desktop on macOS mounts each account at ~/Library/CloudStorage/GoogleDrive-<account>/My Drive.
function macGoogleStorage(home: string): string {
  return join(home, 'Library', 'CloudStorage')
}

async function realDirectory(folder: string): Promise<string | null> {
  if (!(await fs.stat(folder).catch(() => null))?.isDirectory()) return null
  return fs.realpath(folder).catch(() => null)
}

export async function detectCloudDrives(options: DriveOptions): Promise<CloudDrive[]> {
  const candidates = knownFolders(options)
  if (options.platform === 'darwin') {
    const storage = macGoogleStorage(options.home)
    for (const entry of await fs.readdir(storage).catch(() => [])) {
      if (entry.startsWith(GOOGLE_ACCOUNT)) candidates.push({ folder: join(storage, entry, 'My Drive'), label: 'Google Drive' })
    }
  }
  // Probed together: a disconnected network drive letter can take seconds to answer on Windows, and one slow
  // letter must not hold up the rest.
  const reals = await Promise.all(candidates.map((drive) => realDirectory(drive.folder)))
  const seen = new Set<string>()
  return candidates.filter((_, i) => {
    const real = reals[i]
    if (real === null || seen.has(real)) return false
    seen.add(real)
    return true
  })
}

/** The drive at `folder` if it is a folder detectCloudDrives would offer. Checks only that folder. */
export async function cloudDriveAt(folder: string, options: DriveOptions): Promise<CloudDrive | null> {
  let drive = knownFolders(options).find((known) => known.folder === folder)
  if (!drive && options.platform === 'darwin') {
    const account = dirname(folder)
    if (basename(folder) === 'My Drive' && dirname(account) === macGoogleStorage(options.home) && basename(account).startsWith(GOOGLE_ACCOUNT)) {
      drive = { folder, label: 'Google Drive' }
    }
  }
  return drive && (await realDirectory(folder)) !== null ? drive : null
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

// fs.link fails with these where the drive's file system has no hard links (Google Drive's streaming drive
// letter on Windows is the expected case).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EXDEV'])

/**
 * Copies `source` into `<folder>/Reel Studio/`, numbering the name when it is taken, and returns the new file.
 * The video is copied in full under a hidden temporary name first, so the drive never syncs a partial reel,
 * and the publish step never replaces a file the user or the sync client put at that name.
 */
export async function copyToCloudDrive(source: string, folder: string): Promise<string> {
  const destination = join(folder, 'Reel Studio')
  await fs.mkdir(destination, { recursive: true })
  const temp = join(destination, `.${randomUUID()}.tmp`)
  try {
    await fs.copyFile(source, temp, constants.COPYFILE_EXCL)
    const ext = extname(source)
    const stem = basename(source, ext)
    let hardLinks = true
    for (let n = 1; ; n++) {
      const target = join(destination, `${stem}${n === 1 ? '' : ` (${n})`}${ext}`)
      if (hardLinks) {
        try {
          // A hard link refuses to replace an existing name (EEXIST), so publishing cannot overwrite anything.
          await fs.link(temp, target)
          return target
        } catch (error) {
          if (errorCode(error) === 'EEXIST') continue
          if (!NO_HARD_LINKS.has(errorCode(error) as string)) throw error
          hardLinks = false
        }
      }
      if (await renameOntoReservation(temp, target)) return target
    }
  } finally {
    await fs.rm(temp, { force: true })
  }
}

function sameEmptyFile(current: BigIntStats | null, reserved: BigIntStats): boolean {
  return current !== null && current.dev === reserved.dev && current.ino === reserved.ino && current.size === 0n
}

// Without hard links: reserve the name with an empty file that must not exist yet, then check that the name still
// holds that same empty file right before renaming the copy onto it. rename replaces whatever is at the target, so
// a file put there between that check and the rename is still lost. This narrows the window; it does not close it.
async function renameOntoReservation(temp: string, target: string): Promise<boolean> {
  let reservation
  try {
    reservation = await fs.open(target, 'wx')
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
  let reserved: BigIntStats
  try {
    reserved = await reservation.stat({ bigint: true })
  } finally {
    await reservation.close()
  }
  const current = () => fs.stat(target, { bigint: true }).catch(() => null)
  if (!sameEmptyFile(await current(), reserved)) return false
  try {
    await fs.rename(temp, target)
    return true
  } catch (error) {
    if (sameEmptyFile(await current(), reserved)) await fs.rm(target, { force: true })
    throw error
  }
}
