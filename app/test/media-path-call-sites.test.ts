import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { nativeImage, protocol, type WebContents } from 'electron'
import { handleMediaProtocol } from '../src/main/media'
import { mediaUrl } from '../src/main/media-url'
import { startDragOut } from '../src/main/window'

vi.mock('electron', () => ({
  nativeImage: {
    createEmpty: vi.fn(() => ({ isEmpty: () => true })),
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
    createFromPath: vi.fn(() => ({ isEmpty: () => false }))
  },
  protocol: { handle: vi.fn() }
}))

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-path-call-sites-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.mocked(protocol.handle).mockReset()
  vi.mocked(nativeImage.createEmpty).mockReset()
  vi.mocked(nativeImage.createFromDataURL).mockReset()
  vi.mocked(nativeImage.createFromPath).mockReset()
})

describe('startDragOut path checks', () => {
  it('does not drag the Reel Studio root folder itself', () => {
    const root = join(tempDir(), 'Reel Studio')
    mkdirSync(root)
    const startDrag = vi.fn()
    const sender = { startDrag } as unknown as WebContents

    startDragOut(sender, root, [root])

    expect(startDrag).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')('does not drag the root when its path uses different letter case on Windows', () => {
    const root = join(tempDir(), 'Reel Studio')
    mkdirSync(root)
    const startDrag = vi.fn()
    const sender = { startDrag } as unknown as WebContents

    startDragOut(sender, root.toLowerCase(), [root])

    expect(startDrag).not.toHaveBeenCalled()
  })

  it('drags a real file inside the Reel Studio root', () => {
    const root = tempDir()
    const file = join(root, 'Projects', 'clip.mp4')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'clip')
    const startDrag = vi.fn()
    const sender = { startDrag } as unknown as WebContents

    startDragOut(sender, file, [root])

    expect(startDrag).toHaveBeenCalledTimes(1)
    expect(startDrag).toHaveBeenCalledWith(expect.objectContaining({ file: resolve(file) }))
  })
})

describe('media protocol path checks', () => {
  function mediaHandler(roots: () => string[]) {
    const handle = vi.mocked(protocol.handle)
    handleMediaProtocol(roots)
    const registration = handle.mock.calls[0]
    if (!registration) throw new Error('Media protocol handler was not registered')
    return registration[1]
  }

  it.skipIf(process.platform !== 'win32')('allows an existing file in the allowed root when its path uses different letter case on Windows', async () => {
    const root = join(tempDir(), 'Reel Studio')
    const file = join(root, 'Projects', 'clip.mp4')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'clip')
    const handler = mediaHandler(() => [root])

    const response = await handler({ url: mediaUrl(file.toUpperCase()), headers: new Headers() } as Parameters<typeof handler>[0])

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('clip')
  })

  it('refuses a sibling folder whose name starts with the allowed root name', async () => {
    const root = join(tempDir(), 'Reel Studio')
    const sibling = `${root}Evil`
    const file = join(sibling, 'clip.mp4')
    mkdirSync(sibling)
    writeFileSync(file, 'clip')
    const handler = mediaHandler(() => [root])

    const response = await handler({ url: mediaUrl(file), headers: new Headers() } as Parameters<typeof handler>[0])

    expect(response.status).toBe(403)
  })
})
