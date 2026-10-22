import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { checkPlatformExport, exportPlatforms } from '../src/main/platform-export'
import type { Platform } from '../src/shared/platforms'
import { PYTHON } from './helpers'

const scratch = mkdtempSync(join(tmpdir(), 'rs-platform-export-'))
const engine = resolve(__dirname, '../../engine')
const runEngine = createEngineRunner({ python: () => PYTHON, env: () => ({
  ...process.env, PYTHONPATH: engine, REELENGINE_ROOT: join(scratch, 'root'), REELENGINE_CACHE: join(scratch, 'cache')
}) })

afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

/** A stand-in for the final render: 1080×1920 H.264 + AAC at 30 fps, like render.py writes. */
function finalRender(path: string, seconds: number): string {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path])
  return path
}

function jpeg(args: string[], dest: string): Buffer {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, '-frames:v', '1', '-q:v', '2', dest])
  return readFileSync(dest)
}

describe('platform files through the real engine', () => {
  it('fails if a render that meets a platform rule is re-encoded, X loses its 720×1280 file, or a name clash overwrites', async () => {
    const source = finalRender(join(scratch, 'take ü.mp4'), 3)
    const chosenCover = join(scratch, 'cover.png')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=1080x1920', '-frames:v', '1', chosenCover])
    const folder = join(scratch, 'exports')
    const name = 'My reel - Version 2'
    const run = async (platforms: Platform[], caption: string, coverSeconds: number | null) =>
      exportPlatforms({ tries: await checkPlatformExport([{ source, chosenCover, name, platforms, caption, coverSeconds }], runEngine), folder, runEngine })

    const first = await run(['instagram', 'tiktok', 'x'], 'A creator caption #reel', null)
    const sourceBytes = await fs.readFile(source)
    const [instagram, tiktok, x] = first.files
    expect(instagram.video).toBe(join(folder, 'My reel - Version 2 - Instagram Reels.mp4'))
    expect((await fs.readFile(instagram.video)).equals(sourceBytes)).toBe(true)
    expect((await fs.readFile(tiktok.video)).equals(sourceBytes)).toBe(true)
    expect(await runEngine('probe', [x.video])).toMatchObject({ vcodec: 'h264', acodec: 'aac', width: 720, height: 1280, fps: 30, pixFmt: 'yuv420p' })
    expect(await fs.readFile(x.captionFile, 'utf8')).toBe('A creator caption #reel\n')
    expect((await fs.readFile(instagram.cover)).equals(jpeg(['-i', chosenCover], join(scratch, 'expected-chosen.jpg')))).toBe(true)

    // A stray cover from an earlier export: the whole TikTok set moves to "(2)" instead of overwriting it.
    await fs.rm(tiktok.video)
    await fs.rm(tiktok.captionFile)
    const second = await run(['tiktok'], 'Second', 1)
    expect(second.files[0].video).toBe(join(folder, 'My reel - Version 2 - TikTok (2).mp4'))
    expect((await fs.readFile(tiktok.cover)).equals(await fs.readFile(instagram.cover))).toBe(true)
    expect((await fs.readFile(second.files[0].cover)).equals(jpeg(['-ss', '1', '-i', source], join(scratch, 'expected-frame.jpg')))).toBe(true)
    expect((await fs.readdir(folder)).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('fails if Stop during the X encode leaves a file or the staging folder behind', async () => {
    const source = finalRender(join(scratch, 'long.mp4'), 20)
    const folder = join(scratch, 'stopped')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const tries = await checkPlatformExport([{ source, chosenCover: null, name: 'Long', platforms: ['instagram', 'x'], caption: '', coverSeconds: null }], runEngine)
    const stop = new AbortController()
    const running = exportPlatforms({ tries, folder, runEngine, signal: stop.signal, onProgress: (_message, pct) => { if (pct > 0) stop.abort() } })
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if a cover-only Try 2 writes a second video file, or its cover is Try 1\'s frame', async () => {
    const source = finalRender(join(scratch, 'cover test.mp4'), 3)
    const chosenCover = join(scratch, 'blue cover.png')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=1080x1920', '-frames:v', '1', chosenCover])
    const folder = join(scratch, 'cover-only')
    const platforms: Platform[] = ['instagram', 'facebook']
    const one = { source, chosenCover, name: 'My reel - Version 2', platforms, caption: 'Same caption' }
    const tries = await checkPlatformExport([{ ...one, coverSeconds: null }, { ...one, coverSeconds: 1 }], runEngine)
    const { files } = await exportPlatforms({ tries, folder, runEngine })

    expect((await fs.readdir(folder)).filter((n) => n.endsWith('.mp4')).sort()).toEqual([
      'My reel - Version 2 - Facebook Reels - Try 1.mp4', 'My reel - Version 2 - Instagram Reels - Try 1.mp4'])
    const instagram = files.filter((f) => f.platform === 'instagram')
    expect(instagram.map((f) => f.try)).toEqual([1, 2])
    expect(instagram[1].video).toBe(instagram[0].video)
    expect(instagram[1].cover).toBe(join(folder, 'My reel - Version 2 - Instagram Reels - Try 2 cover.jpg'))
    expect((await fs.readFile(instagram[0].cover)).equals(jpeg(['-i', chosenCover], join(scratch, 'expected-blue.jpg')))).toBe(true)
    expect((await fs.readFile(instagram[1].cover)).equals(jpeg(['-ss', '1', '-i', source], join(scratch, 'expected-second.jpg')))).toBe(true)
  })

  it('fails if Stop during Try 2\'s encode leaves any Try 1 file or the staging folder', async () => {
    const first = finalRender(join(scratch, 'try 1.mp4'), 3)
    const second = join(scratch, 'try 2 small.mp4')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second])
    const folder = join(scratch, 'stopped-two')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const tries = await checkPlatformExport([
      { source: first, chosenCover: null, name: 'Mine - Version 1', platforms: ['instagram', 'tiktok'], caption: 'First', coverSeconds: null },
      { source: second, chosenCover: null, name: 'Mine - Version 2', platforms: ['instagram'], caption: 'First', coverSeconds: null }
    ], runEngine)
    // Try 1 is copied as it is, so the only encode is Try 2's 720×1280 video for Instagram.
    const stop = new AbortController()
    const running = exportPlatforms({ tries, folder, runEngine, signal: stop.signal, onProgress: (_message, pct) => { if (pct > 0) stop.abort() } })
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if Try 2\'s caption skips the platform check', async () => {
    const source = finalRender(join(scratch, 'hashtags.mp4'), 3)
    const platforms: Platform[] = ['instagram']
    const one = { source, chosenCover: null, name: 'Tags - Version 1', platforms, coverSeconds: null }
    await expect(checkPlatformExport([{ ...one, caption: '#reel' }, { ...one, caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ') }], runEngine))
      .rejects.toMatchObject({ code: 'EXPORT_RULE', userMessage: 'Try 2 on Instagram Reels: 31 hashtags; use at most 30.' })
  })
})
