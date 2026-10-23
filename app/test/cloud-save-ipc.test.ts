// The cloud:save handler, called the way the renderer calls it, with a fake home folder for the drive.
import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PhoneIpcDeps } from '../src/main/phone-ipc'

const home = await fs.mkdtemp(join(tmpdir(), 'rs-cloud-ipc-'))
vi.mock('electron', () => ({ app: { getPath: () => home }, BrowserWindow: {}, ShareMenu: class {}, shell: {} }))
const { registerPhoneIpc } = await import('../src/main/phone-ipc')

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('fails if saving to one drive waits on the other drives answering', async () => {
  const handlers = new Map<string, Parameters<PhoneIpcDeps['handle']>[1]>()
  const root = join(home, 'Reel Studio')
  registerPhoneIpc({ handle: (channel, fn) => handlers.set(channel, fn), roots: () => [root], send: () => {}, log: () => {}, test: true })
  const video = join(root, 'Family reel.mp4')
  await fs.mkdir(root)
  await fs.writeFile(video, 'complete video')
  const iCloud = process.platform === 'darwin' ? join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') : join(home, 'iCloudDrive')
  await fs.mkdir(iCloud, { recursive: true })
  await fs.mkdir(join(home, 'Library', 'CloudStorage', 'GoogleDrive-zoe@gmail.com', 'My Drive'), { recursive: true })

  // Every other place a drive may live never answers, like a disconnected network drive letter.
  const never = new Promise<never>(() => {})
  const other = (path: unknown) => String(path).includes('CloudStorage') || (/^[A-Z]:\\/.test(String(path)) && !String(path).startsWith(home))
  const stat = fs.stat.bind(fs)
  const readdir = fs.readdir.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(((path: string, ...rest: []) => (other(path) ? never : stat(path, ...rest))) as typeof fs.stat)
  vi.spyOn(fs, 'readdir').mockImplementation(((path: string, ...rest: []) => (other(path) ? never : readdir(path, ...rest))) as typeof fs.readdir)

  const saved = await handlers.get('cloud:save')!({} as Electron.IpcMainInvokeEvent, video, iCloud)
  expect(saved).toBe(join(iCloud, 'Reel Studio', 'Family reel.mp4'))
  expect(await fs.readFile(saved as string, 'utf8')).toBe('complete video')
}, 5000)
