import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { checkPlatformExport, exportPlatforms } from '../src/main/platform-export'
import type { PlatformExportRequest } from '../src/shared/platforms'
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
    const run = async (request: PlatformExportRequest) =>
      exportPlatforms({ source, video: await checkPlatformExport(source, request, runEngine), chosenCover, folder, name, request, runEngine })

    const first = await run({ platforms: ['instagram', 'tiktok', 'x', 'facebook'], caption: 'A creator caption #reel', coverSeconds: null })
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
    const second = await run({ platforms: ['tiktok'], caption: 'Second', coverSeconds: 1 })
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
    const request: PlatformExportRequest = { platforms: ['instagram', 'x'], caption: '', coverSeconds: null }
    const stop = new AbortController()
    const running = exportPlatforms({ source, video: await checkPlatformExport(source, request, runEngine), chosenCover: null, folder,
      name: 'Long', request, runEngine, signal: stop.signal, onProgress: (_message, pct) => { if (pct > 0) stop.abort() } })
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if Stop as the second platform lands leaves files behind, or a briefly locked file hides that it stopped', async () => {
    const source = finalRender(join(scratch, 'late stop.mp4'), 3)
    const folder = join(scratch, 'late stop')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const request: PlatformExportRequest = { platforms: ['tiktok', 'youtube'], caption: 'Hi', coverSeconds: null }
    const video = await checkPlatformExport(source, request, runEngine)
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
      await expect(exportPlatforms({ source, video, chosenCover: null, folder, name: 'Late', request, runEngine, signal: stop.signal }))
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
    const request: PlatformExportRequest = { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }
    const video = await checkPlatformExport(source, request, runEngine)
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
      await expect(exportPlatforms({ source, video, chosenCover: null, folder, name: 'Full', request, runEngine }))
        .rejects.toMatchObject({ code: 'ENOSPC' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual([])
  })
  // A real lock, not a mock: PowerShell opens the file with FileShare.None for 600 ms, as a stopped ffmpeg can.
  it.runIf(process.platform === 'win32')('removes a staging folder whose file is still locked for a moment', async () => {
    const folder = join(scratch, 'sweep-locked')
    const stage = join(folder, '.platform-export-locked')
    const file = join(stage, 'video.mp4')
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(file, 'leftover')
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
      `$f = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Milliseconds 600; $f.Close()`])
    await new Promise<void>((ok) => holder.stdout.on('data', (d: Buffer) => d.toString().includes('locked') && ok()))
    await expect(fs.rm(stage, { recursive: true, force: true })).rejects.toMatchObject({ code: 'EBUSY' })
    await sweepExportStaging(folder)
    expect(await fs.readdir(folder)).toEqual([])
  })
})
