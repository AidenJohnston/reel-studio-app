import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { exportPlatforms } from '../src/main/platform-export'
import { makeClip, PYTHON } from './helpers'

const scratch = mkdtempSync(join(tmpdir(), 'rs-platform-export-'))
const engine = resolve(__dirname, '../../engine')
const runEngine = createEngineRunner({ python: () => PYTHON, env: () => ({
  ...process.env, PYTHONPATH: engine, REELENGINE_ROOT: join(scratch, 'root'), REELENGINE_CACHE: join(scratch, 'cache')
}) })

afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

describe('platform files through the real engine', () => {
  it('fails if matching platforms lose their named videos, caption or selected cover frame', async () => {
    const source = makeClip(join(scratch, 'take ü.mp4'), 3)
    const folder = join(scratch, 'exports')
    const result = await exportPlatforms({ source, folder, name: 'My reel - Version 2', runEngine,
      request: { platforms: ['instagram', 'tiktok', 'youtube', 'facebook', 'threads', 'x', 'linkedin'], caption: 'A creator caption #reel', coverSeconds: 1 } })
    expect(result.files).toHaveLength(7)
    const bytes = await Promise.all(result.files.map((file) => fs.readFile(file.video)))
    expect(bytes[1].equals(bytes[0])).toBe(true)
    expect(bytes[2].equals(bytes[0])).toBe(true)
    for (const file of result.files) {
      expect(file.video).toContain('My reel - Version 2 - ')
      expect(await fs.readFile(file.captionFile, 'utf8')).toBe('A creator caption #reel\n')
      const image = await fs.readFile(file.cover)
      expect(image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    }
    const probe: unknown = await runEngine('probe', [result.files[0].video])
    expect(probe).toMatchObject({ vcodec: 'h264', acodec: 'aac', width: 1080, height: 1920, fps: 30, pixFmt: 'yuv420p' })
    const xFile = result.files.find((file) => file.platform === 'x')
    if (!xFile) throw new Error('The X export is missing')
    expect(await runEngine('probe', [xFile.video])).toMatchObject({ vcodec: 'h264', acodec: 'aac', width: 720, height: 1280 })
    const expected = join(scratch, 'expected.jpg')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', result.files[0].video, '-frames:v', '1', '-q:v', '2', expected])
    expect((await fs.readFile(expected)).equals(await fs.readFile(result.files[0].cover))).toBe(true)
  })
})
