import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, promises as fs, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let serve: (req: Request) => Promise<Response>
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, fn: typeof serve) => (serve = fn) } }))
const { handleMediaProtocol } = await import('../src/main/media')
const { mediaUrl } = await import('../src/main/media-url')
const { listLibrary } = await import('../src/main/library')
const { setupPaths } = await import('./helpers')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'rs-media-')))
afterEach(() => vi.restoreAllMocks())
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

it('fails if replacing checked media with an outside symlink serves outside bytes', async () => {
  const root = join(base, 'race')
  mkdirSync(root)
  const file = join(root, 'still.jpg')
  const outside = join(base, 'outside.jpg')
  writeFileSync(file, 'public')
  writeFileSync(outside, 'secret')
  const stat = fs.stat.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
    const result = await stat(path, options)
    if (path === file) {
      rmSync(file)
      symlinkSync(outside, file)
    }
    return result
  })
  handleMediaProtocol(() => [root])
  const response = await serve(new Request(mediaUrl(file), { headers: { range: 'bytes=1-3' } }))
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 1-3/6')
  expect(await response.text()).toBe('ubl')
})

it('fails if an unconfigured UNC or device path reaches the filesystem', async () => {
  const lookup = vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('must reject before filesystem access'))
  const open = vi.spyOn(fs, 'open').mockRejectedValue(new Error('must reject before filesystem access'))
  const stat = vi.spyOn(fs, 'stat').mockRejectedValue(new Error('must reject before filesystem access'))
  const root = String.raw`\\trusted.example\share`
  handleMediaProtocol(() => [base, root])
  for (const path of [String.raw`\\attacker.example\share\bait.jpg`, String.raw`\\?\UNC\attacker.example\share\bait.jpg`, String.raw`\\.\pipe\bait`, '//attacker.example/share/bait.jpg', String.raw`\\trusted.example\share-other\bait.jpg`]) {
    expect((await serve(new Request(mediaUrl(path)))).status).toBe(403)
  }
  expect(lookup).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(stat).not.toHaveBeenCalled()
  await serve(new Request(mediaUrl(root + String.raw`\clip.jpg`)))
  expect(lookup).toHaveBeenCalled()
})
