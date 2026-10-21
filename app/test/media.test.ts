import { afterAll, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let serve: (req: Request) => Promise<Response>
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, fn: typeof serve) => (serve = fn) } }))
const { handleMediaProtocol } = await import('../src/main/media')
const { mediaUrl } = await import('../src/main/media-url')
const { listLibrary } = await import('../src/main/library')
const { setupPaths } = await import('./helpers')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'rs-media-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

it('fails if a project symlink serves an outside file, while allowing linked roots and registered Library links', async () => {
  const { root } = setupPaths(join(base, 'documents'))
  mkdirSync(join(root, 'Projects', 'p'), { recursive: true })
  const secret = join(base, 'secret.jpg')
  writeFileSync(secret, 'private')
  const escape = join(root, 'Projects', 'p', 'escape.jpg')
  symlinkSync(secret, escape)
  handleMediaProtocol(() => [root])
  expect((await serve(new Request(mediaUrl(escape)))).status).toBe(403)

  writeFileSync(join(root, 'Projects', 'p', 'still.jpg'), 'image')
  const alias = join(base, 'linked-root')
  symlinkSync(root, alias, 'dir')
  handleMediaProtocol(() => [alias])
  for (const dir of [root, alias]) {
    const res = await serve(new Request(mediaUrl(join(dir, 'Projects', 'p', 'still.jpg'))))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('image')
  }
  const music = join(root, 'Library', 'Music')
  mkdirSync(music, { recursive: true })
  const song = join(base, 'song.mp3')
  writeFileSync(song, 'song')
  const entry = join(music, 'song.mp3')
  symlinkSync(song, entry)
  const file = (await listLibrary()).find((b) => b.key === 'music')!.files[0]
  expect(await (await serve(new Request(file.url))).text()).toBe('song')
  expect((await serve(new Request(mediaUrl(secret)))).status).toBe(403)
  const otherRoot = join(base, 'other-root')
  mkdirSync(otherRoot)
  handleMediaProtocol(() => [otherRoot])
  expect((await serve(new Request(mediaUrl(song)))).status).toBe(403)
  handleMediaProtocol(() => [root])
  await listLibrary()
  rmSync(entry)
  expect((await serve(new Request(file.url))).status).not.toBe(200)
  expect((await serve(new Request(mediaUrl(song)))).status).toBe(403)
})
