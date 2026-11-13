import { afterAll, afterEach, expect, it, vi, type TestContext } from 'vitest'
import { mkdirSync, mkdtempSync, promises as fs, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let serve: (req: Request) => Promise<Response>
vi.mock('electron', () => ({ protocol: { handle: (_scheme: string, fn: typeof serve) => (serve = fn) } }))
const { handleMediaProtocol } = await import('../src/main/media')
const { mediaUrl } = await import('../src/main/media-url')
const { listLibrary } = await import('../src/main/library')
const { setupPaths } = await import('./helpers')

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'rs-media-')))
afterEach(() => vi.restoreAllMocks())
afterAll(() => rmSync(base, { recursive: true, force: true }))

function link(t: TestContext, target: string, entry: string, directory = false): void {
  try {
    symlinkSync(target, entry, directory ? 'junction' : 'file')
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') t.skip('File symlinks require Windows Developer Mode or administrator rights')
    throw error
  }
}

it('fails if a project or unapproved Library file link serves an outside file, while allowing linked roots', async (t) => {
  const { root } = setupPaths(join(base, 'documents'))
  mkdirSync(join(root, 'Projects', 'p'), { recursive: true })
  const secret = join(base, 'secret.jpg')
  writeFileSync(secret, 'private')
  const escape = join(root, 'Projects', 'p', 'escape.jpg')
  link(t, secret, escape)
  handleMediaProtocol(() => [root])
  expect((await serve(new Request(mediaUrl(escape)))).status).toBe(403)

  writeFileSync(join(root, 'Projects', 'p', 'still.jpg'), 'image')
  const alias = join(base, 'linked-root')
  link(t, root, alias, true)
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
  link(t, song, entry)
  const file = (await listLibrary()).find((b) => b.key === 'music')!.files[0]
  expect((await serve(new Request(file.url))).status).toBe(403)
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

it('fails if replacing checked media with an outside symlink serves outside bytes after native realpath expands an alias', async (t) => {
  const realRoot = join(base, 'Runner Long Folder')
  mkdirSync(realRoot)
  // A fresh parent keeps NTFS 8.3 names from occupying the junction path.
  const root = join(mkdtempSync(join(base, 'alias-')), 'root')
  link(t, realRoot, root, true)
  const requested = join(root, 'still.jpg')
  writeFileSync(requested, 'public')
  const file = await fs.realpath(requested)
  const outside = join(base, 'outside.jpg')
  writeFileSync(outside, 'secret')
  const probe = join(realRoot, 'probe.jpg')
  link(t, outside, probe)
  rmSync(probe)
  let swapped = false
  const stat = fs.stat.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
    const result = await stat(path, options)
    if (path === file) {
      rmSync(file)
      symlinkSync(outside, file)
      swapped = true
    }
    return result
  })
  handleMediaProtocol(() => [root])
  const response = await serve(new Request(mediaUrl(requested), { headers: { range: 'bytes=1-3' } }))
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 1-3/6')
  expect(await response.text()).toBe('ubl')
  expect(swapped).toBe(true)
})

it('plays an external target linked from a direct Library bin and refuses other directory links', async (t) => {
  const { root } = setupPaths(join(base, 'bin-documents'))
  const target = join(base, 'external-music')
  mkdirSync(target)
  writeFileSync(join(target, 'song.mp3'), 'song')
  mkdirSync(join(root, 'Library'), { recursive: true })
  link(t, target, join(root, 'Library', 'Music'), true)
  handleMediaProtocol(() => [root])
  const music = (await listLibrary()).find((bin) => bin.key === 'music')!
  const response = await serve(new Request(music.files[0].url))
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('song')

  const unapproved = join(base, 'unapproved-music')
  mkdirSync(unapproved)
  writeFileSync(join(unapproved, 'secret.mp3'), 'private')
  link(t, unapproved, join(root, 'Library', 'Archive'), true)
  link(t, unapproved, join(target, 'nested'), true)
  expect((await serve(new Request(mediaUrl(join(root, 'Library', 'Archive', 'secret.mp3'))))).status).toBe(403)
  expect((await serve(new Request(mediaUrl(join(root, 'Library', 'Music', 'nested', 'secret.mp3'))))).status).toBe(403)
})

it('refuses a file that escapes a linked bin target through a second link, even after listing', async (t) => {
  const { root } = setupPaths(join(base, 'escape-documents'))
  const target = join(base, 'escape-target')
  mkdirSync(target)
  const secret = join(base, 'escape-secret.mp3')
  writeFileSync(secret, 'private')
  link(t, secret, join(target, 'escape.mp3'))
  mkdirSync(join(root, 'Library'), { recursive: true })
  link(t, target, join(root, 'Library', 'Music'), true)
  handleMediaProtocol(() => [root])
  const music = (await listLibrary()).find((bin) => bin.key === 'music')!
  expect((await serve(new Request(music.files[0].url))).status).toBe(403)
})

it('revalidates a re-pointed Library bin without keeping access to its old target', async (t) => {
  const { root } = setupPaths(join(base, 'repoint-documents'))
  const first = join(base, 'first-music')
  const second = join(base, 'second-music')
  for (const [folder, contents] of [[first, 'first'], [second, 'second']]) {
    mkdirSync(folder)
    writeFileSync(join(folder, 'song.mp3'), contents)
  }
  mkdirSync(join(root, 'Library'), { recursive: true })
  const bin = join(root, 'Library', 'Music')
  link(t, first, bin, true)
  handleMediaProtocol(() => [root])
  const url = mediaUrl(join(bin, 'song.mp3'))
  expect(await (await serve(new Request(url))).text()).toBe('first')
  rmSync(bin)
  link(t, second, bin, true)
  expect((await serve(new Request(mediaUrl(join(first, 'song.mp3'))))).status).toBe(403)
  expect(await (await serve(new Request(url))).text()).toBe('second')
  rmSync(bin)
  expect((await serve(new Request(mediaUrl(join(second, 'song.mp3'))))).status).toBe(403)
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
