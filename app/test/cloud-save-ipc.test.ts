// The cloud:save handler, called the way the renderer calls it, with a fake home folder for the drive.
import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PhoneIpcDeps } from '../src/main/phone-ipc'

// The long, real form of the temp folder: the handler resolves the video with realpathSync.native, which expands a
// Windows short name (C:\Users\RUNNER~1), and the first test below tells this home from other drives by its prefix.
const home = realpathSync.native(await fs.mkdtemp(join(tmpdir(), 'rs-cloud-ipc-')))
vi.mock('electron', () => ({ app: { getPath: () => home }, BrowserWindow: {}, ShareMenu: class {}, shell: {} }))
const { cloudSavesSettled, registerPhoneIpc } = await import('../src/main/phone-ipc')

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('fails if saving to one drive waits on the other drives answering', async () => {
  const handlers = new Map<string, Parameters<PhoneIpcDeps['handle']>[1]>()
  const root = join(home, 'Reel Studio')
  registerPhoneIpc({ handle: (channel, fn) => handlers.set(channel, fn), roots: () => [root], plan: () => Promise.reject(new Error('no plan in this test')), send: () => {}, log: () => {}, test: true })
  const video = join(root, 'Family reel.mp4')
  await fs.mkdir(root)
  await fs.writeFile(video, 'complete video')
  const iCloud = process.platform === 'darwin' ? join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') : join(home, 'iCloudDrive')
  await fs.mkdir(iCloud, { recursive: true })
  await fs.mkdir(join(home, 'Library', 'CloudStorage', 'GoogleDrive-zoe@example.com', 'My Drive'), { recursive: true })

  // Every other place a drive may live never answers, like a disconnected network drive letter.
  const never = new Promise<never>(() => {})
  const other = (path: unknown) => String(path).includes('CloudStorage') || (/^[A-Z]:\\/.test(String(path)) && !String(path).startsWith(home))
  const stat = fs.stat.bind(fs)
  const readdir = fs.readdir.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(((path: string, ...rest: []) => (other(path) ? never : stat(path, ...rest))) as typeof fs.stat)
  vi.spyOn(fs, 'readdir').mockImplementation(((path: string, ...rest: []) => (other(path) ? never : readdir(path, ...rest))) as typeof fs.readdir)

  const saved = await handlers.get('cloud:save')!({} as Electron.IpcMainInvokeEvent, video, iCloud, 'save-1')
  expect(saved).toBe(join(iCloud, 'Reel Studio', 'Family reel.mp4'))
  expect(await fs.readFile(saved as string, 'utf8')).toBe('complete video')
}, 5000)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('fails if quitting waits more than 15 s for a save on a stalled drive', async () => {
  const handlers = new Map<string, Parameters<PhoneIpcDeps['handle']>[1]>()
  const root = join(home, 'Reel Studio')
  registerPhoneIpc({ handle: (channel, fn) => handlers.set(channel, fn), roots: () => [root], plan: () => Promise.reject(new Error('no plan in this test')), send: () => {}, log: () => {}, test: true })
  const video = join(root, 'Family reel.mp4')
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(video, 'complete video')
  const iCloud = process.platform === 'darwin' ? join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') : join(home, 'iCloudDrive')
  await fs.mkdir(iCloud, { recursive: true })

  // The drive stops answering mid-copy and never fails.
  let copying!: () => void
  const started = new Promise<void>((resolve) => (copying = resolve))
  // (the streamed copy starts by reading the video's size)
  const stat = fs.stat.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(((path: string, ...rest: []) => {
    // the video by name: the handler hands the copy its real path (/private/var on a Mac)
    if (!String(path).endsWith(join('Reel Studio', 'Family reel.mp4')) || String(path).includes('CloudDocs')) return stat(path, ...rest)
    copying()
    return new Promise<never>(() => {})
  }) as typeof fs.stat)
  // its own id: the save map outlives a test, and a 'save-1' the first test left running would be refused here
  void handlers.get('cloud:save')!({} as Electron.IpcMainInvokeEvent, video, iCloud, 'save-2')
  await started

  vi.useFakeTimers()
  let settled = false
  void cloudSavesSettled().then(() => (settled = true))
  await vi.advanceTimersByTimeAsync(14_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toBe(true)
})
