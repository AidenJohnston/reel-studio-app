import { describe, expect, it, type TestContext } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { binDir } from '../src/main/paths'
import { libraryPreview } from '../src/main/library-preview'
import { setupPaths } from './helpers'

describe('Library previews', () => {
  it('fails if a song that is really an ffconcat list makes ffmpeg read another file', async () => {
    setupPaths()
    const dir = binDir('music')
    mkdirSync(dir, { recursive: true })
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', join(dir, 'other.wav')])
    const disguised = join(dir, 'my song.wav')
    writeFileSync(disguised, 'ffconcat version 1.0\nfile other.wav\n')
    await expect(libraryPreview(join(dir, 'other.wav'))).resolves.toMatchObject({ durationSec: expect.any(Number) })
    await expect(libraryPreview(disguised)).rejects.toBeTruthy()
  }, 60_000)

  it("fails if a song that is a link to a file outside the Library is decoded, or a linked bin's own songs are not", async (t) => {
    const { home } = setupPaths()
    // wav: the product's ffmpeg decodes mp3 but has no mp3 encoder to make one
    const outside = join(dirname(home), 'private', 'client call.wav')
    mkdirSync(dirname(outside), { recursive: true })
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', outside])
    const dir = binDir('music')
    mkdirSync(dir, { recursive: true })
    link(t, outside, join(dir, 'preview.wav'))
    await expect(libraryPreview(join(dir, 'preview.wav'))).rejects.toMatchObject({ code: 'BAD_ARGS' })

    // the whole Music folder kept elsewhere, as a link: its own songs still get a preview
    const moved = join(dirname(home), 'music elsewhere')
    mkdirSync(moved, { recursive: true })
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', join(moved, 'mine.wav')])
    setupPaths(join(dirname(home), 'second'))
    mkdirSync(dirname(binDir('music')), { recursive: true })
    link(t, moved, binDir('music'), true)
    await expect(libraryPreview(join(binDir('music'), 'mine.wav'))).resolves.toMatchObject({ durationSec: expect.any(Number) })
  }, 60_000)
})

function link(t: TestContext, target: string, entry: string, directory = false): void {
  try {
    symlinkSync(target, entry, directory ? 'junction' : 'file')
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') t.skip('File symlinks require Windows Developer Mode or administrator rights')
    throw error
  }
}
