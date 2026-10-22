import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, promises as fs, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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

/**
 * A stand-in for the final render: 1080×1920 H.264 + AAC 192k at 30 fps with edit lists, like render.py writes.
 * Keyframes are 6 s apart: x264's default 250-frame interval is over 8 s at 30 fps.
 */
function finalRender(path: string, seconds: number): string {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high',
    '-g', '180', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', path])
  return path
}

const ffprobe = (args: string[]): string => execFileSync('ffprobe', ['-v', 'error', ...args]).toString().trim()
const audioBitrate = (file: string): number => Number(ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', file]))
const hasEditList = (file: string): boolean => spawnSync('ffprobe', ['-v', 'trace', file], { encoding: 'utf8' }).stderr.includes("type:'elst'")
const videoPackets = (file: string): string => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString()
function longestKeyframeGap(file: string): number {
  const keys = ffprobe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]).split('\n')
    .filter((line) => line.split(',')[1]?.includes('K')).map((line) => Number(line.split(',')[0]))
  const end = Number(ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]))
  return Math.max(...keys.map((t, i) => (keys[i + 1] ?? end) - t))
}

function jpeg(args: string[], dest: string): Buffer {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, '-frames:v', '1', '-q:v', '2', dest])
  return readFileSync(dest)
}

describe('platform files through the real engine', () => {
  it('fails if a platform gets a file its rule rejects, TikTok gets a re-encode, or a name clash overwrites', async () => {
    const source = finalRender(join(scratch, 'take ü.mp4'), 7)
    const chosenCover = join(scratch, 'cover.png')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=1080x1920', '-frames:v', '1', chosenCover])
    const folder = join(scratch, 'exports')
    const name = 'My reel - Version 2'
    const run = async (platforms: Platform[], caption: string, coverSeconds: number | null) =>
      exportPlatforms({ tries: await checkPlatformExport([{ version: 2, source, chosenCover, name, platforms, caption, coverSeconds }], runEngine), folder, runEngine })

    const first = await run(['instagram', 'tiktok', 'x', 'facebook'], 'A creator caption #reel', null)
    const [instagram, tiktok, x, facebook] = first.files
    expect(instagram.video).toBe(join(folder, 'My reel - Version 2 - Instagram Reels.mp4'))
    expect((await fs.readFile(tiktok.video)).equals(await fs.readFile(source))).toBe(true)
    // Instagram: "no edit lists" and 128 kb/s audio, with the picture untouched.
    expect([hasEditList(source), hasEditList(instagram.video)]).toEqual([true, false])
    expect(audioBitrate(instagram.video)).toBeLessThan(130_000) // ffmpeg's 128k AAC measures a few bits over
    expect(videoPackets(instagram.video)).toBe(videoPackets(source))
    // Facebook: "Closed GOP (2-5 seconds)".
    expect(longestKeyframeGap(facebook.video)).toBeLessThanOrEqual(5)
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
  }, 120_000)

  it('fails if Stop during the X encode leaves a file or the staging folder behind', async () => {
    const source = finalRender(join(scratch, 'long.mp4'), 20)
    const folder = join(scratch, 'stopped')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const tries = await checkPlatformExport([{ version: 1, source, chosenCover: null, name: 'Long', platforms: ['instagram', 'x'], caption: '', coverSeconds: null }], runEngine)
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
    const one = { version: 2, source, chosenCover, name: 'My reel - Version 2', platforms, caption: 'Same caption' }
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
      { version: 1, source: first, chosenCover: null, name: 'Mine - Version 1', platforms: ['instagram', 'tiktok'], caption: 'First', coverSeconds: null },
      { version: 2, source: second, chosenCover: null, name: 'Mine - Version 2', platforms: ['instagram'], caption: 'First', coverSeconds: null }
    ], runEngine)
    const stop = new AbortController()
    let atStop: string[] = []
    const running = exportPlatforms({ tries, folder, runEngine, signal: stop.signal, onProgress: (message, pct) => {
      if (pct === 0 || !message.endsWith('for Try 2') || stop.signal.aborted) return
      atStop = readdirSync(folder).filter((n) => !n.startsWith('.'))
      stop.abort()
    } })
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(atStop).toEqual(['earlier export.mp4'])
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if Try 2\'s caption skips the platform check', async () => {
    const source = finalRender(join(scratch, 'hashtags.mp4'), 3)
    const platforms: Platform[] = ['instagram']
    const one = { version: 1, source, chosenCover: null, name: 'Tags - Version 1', platforms, coverSeconds: null }
    await expect(checkPlatformExport([{ ...one, caption: '#reel' }, { ...one, caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ') }], runEngine))
      .rejects.toMatchObject({ code: 'EXPORT_RULE', userMessage: 'Try 2 on Instagram Reels: 31 hashtags; use at most 30.' })
  })

  it('fails if a Try 2 cover on the same frame as Try 1\'s counts as a change', async () => {
    const source = finalRender(join(scratch, 'same frame.mp4'), 3)
    const platforms: Platform[] = ['instagram']
    const one = { version: 1, source, chosenCover: null, name: 'Frame - Version 1', platforms, caption: 'Same' }
    // 1 s and 1.01 s are both frame 30 at 30 fps.
    await expect(checkPlatformExport([{ ...one, coverSeconds: 1 }, { ...one, coverSeconds: 1.01 }], runEngine))
      .rejects.toMatchObject({ code: 'BAD_EXPORT', userMessage: 'Try 2 is the same as Try 1. Pick another version, cover or caption.' })
  })

  it('fails if one export gives its sets different numbers', async () => {
    const source = finalRender(join(scratch, 'numbers.mp4'), 3)
    const folder = join(scratch, 'numbers')
    const run = async (platforms: Platform[]) => {
      const one = { version: 1, source, chosenCover: null, name: 'Mine - Version 1', coverSeconds: null }
      return exportPlatforms({ tries: await checkPlatformExport([{ ...one, platforms, caption: 'First' }, { ...one, platforms: ['instagram'], caption: 'Second' }], runEngine), folder, runEngine })
    }
    await run(['instagram'])
    // The creator adds TikTok and exports again: Instagram's names are taken, TikTok's are not.
    const again = await run(['instagram', 'tiktok'])
    expect(again.files.map((f) => basename(f.captionFile))).toEqual([
      'Mine - Version 1 - Instagram Reels - Try 1 (2) caption.txt', 'Mine - Version 1 - TikTok - Try 1 (2) caption.txt',
      'Mine - Version 1 - Instagram Reels - Try 2 (2) caption.txt'])

  })

  it('fails if Stop as the second platform lands leaves files behind, or a briefly locked file hides that it stopped', async () => {
    const source = finalRender(join(scratch, 'late stop.mp4'), 3)
    const folder = join(scratch, 'late stop')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const tries = await checkPlatformExport([{ version: 1, source, chosenCover: null, name: 'Late', platforms: ['tiktok', 'youtube'], caption: 'Hi', coverSeconds: null }], runEngine)
    const stop = new AbortController()
    const secondVideo = join(folder, 'Late - YouTube Shorts.mp4')
    const { copyFile, link, rm } = fs
    const stubs = [
      vi.spyOn(fs, 'copyFile').mockImplementation((from, to, mode) => { if (to === secondVideo) stop.abort(); return copyFile(from, to, mode) }),
      vi.spyOn(fs, 'link').mockImplementation((from, to) => { if (to === secondVideo) stop.abort(); return link(from, to) }),
      // Windows refuses to delete a file that another process still holds; only Node's own retries wait it out.
      vi.spyOn(fs, 'rm').mockImplementation((path, options) => path === join(folder, 'Late - TikTok.mp4') && !options?.maxRetries
        ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
        : rm(path, options))
    ]
    try {
      await expect(exportPlatforms({ tries, folder, runEngine, signal: stop.signal }))
        .rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if a copy that runs out of space halfway leaves a half-written video in Finished videos', async () => {
    const source = finalRender(join(scratch, 'full drive.mp4'), 3)
    const folder = join(scratch, 'full drive')
    mkdirSync(folder)
    const tries = await checkPlatformExport([{ version: 1, source, chosenCover: null, name: 'Full', platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }], runEngine)
    const brokenVideo = join(folder, 'Full - YouTube Shorts.mp4')
    const { copyFile } = fs
    // An exFAT drive: no hard links, and it fills up while the second video is copied.
    const stubs = [
      vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('ENOTSUP: operation not supported'), { code: 'ENOTSUP' })),
      vi.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
        if (to !== brokenVideo) return copyFile(from, to, mode)
        const bytes = await fs.readFile(from)
        await fs.writeFile(to, bytes.subarray(0, bytes.length / 2))
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      })
    ]
    try {
      await expect(exportPlatforms({ tries, folder, runEngine }))
        .rejects.toMatchObject({ code: 'ENOSPC' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual([])
  })
})
