import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let serve: (req: Request) => Promise<Response>
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, fn: typeof serve) => (serve = fn) } }))
const { handleMediaProtocol } = await import('../src/main/media')
const { mediaUrl } = await import('../src/main/media-url')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'rs-media-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('reel-media: protocol', () => {
  it('serves a file under a Reel Studio folder reached through a symlink, and nothing outside it', async () => {
    const realRoot = join(base, 'synced', 'Reel Studio')
    mkdirSync(join(realRoot, 'Projects', 'p'), { recursive: true })
    writeFileSync(join(realRoot, 'Projects', 'p', 'still.jpg'), 'jpg')
    writeFileSync(join(base, 'secret.jpg'), 'no')
    symlinkSync(join(base, 'secret.jpg'), join(realRoot, 'Projects', 'p', 'escape.jpg'))
    symlinkSync(join(base, 'synced'), join(base, 'Documents'))
    const root = join(base, 'Documents', 'Reel Studio') // what the app was told
    handleMediaProtocol(() => [root])

    // the engine reports real paths, the app its own: both name the same file
    for (const p of [join(realRoot, 'Projects', 'p', 'still.jpg'), join(root, 'Projects', 'p', 'still.jpg')]) {
      const res = await serve(new Request(mediaUrl(p)))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('jpg')
    }
    expect((await serve(new Request(mediaUrl(join(root, 'Projects', 'p', 'escape.jpg'))))).status).toBe(403)
    expect((await serve(new Request(mediaUrl(join(base, 'secret.jpg'))))).status).toBe(403)
    expect((await serve(new Request(mediaUrl(join(root, 'Projects', 'p', 'gone.jpg'))))).status).toBe(404)
    expect((await serve(new Request(mediaUrl(join(base, 'gone.jpg'))))).status).toBe(403)
  })
})
