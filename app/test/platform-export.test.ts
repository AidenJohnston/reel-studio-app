import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { exportPlatforms, sweepExportStaging } from '../src/main/platform-export'
import { outputGroups, type PlatformExportRequest } from '../src/shared/platforms'
import { PYTHON } from './helpers'

const scratch = mkdtempSync(join(tmpdir(), 'rs-platform-export-'))
const engine = resolve(__dirname, '../../engine')
const runEngine = createEngineRunner({ python: () => PYTHON, env: () => ({
  ...process.env, PYTHONPATH: engine, REELENGINE_ROOT: join(scratch, 'root'), REELENGINE_CACHE: join(scratch, 'cache')
}) })

afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

/** A stand-in for the final render: 1080×1920 H.264 + AAC 192k at 30 fps with edit lists, like render.py writes. */
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
function jpeg(args: string[], dest: string): Buffer {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, '-frames:v', '1', '-q:v', '2', dest])
  return readFileSync(dest)
}

describe('platform files through the real engine', () => {
  it('fails if Facebook, X or TikTok get anything but the render, Instagram keeps its edit list or 192k audio, or a name clash overwrites', async () => {
    const source = finalRender(join(scratch, 'take ü.mp4'), 7)
    const chosenCover = join(scratch, 'cover.png')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=1080x1920', '-frames:v', '1', chosenCover])
    const folder = join(scratch, 'exports')
    const name = 'My reel - Version 2'
    const run = (request: PlatformExportRequest) => exportPlatforms({ source, chosenCover, folder, name, request, runEngine })

    const first = await run({ platforms: ['instagram', 'tiktok', 'x', 'facebook'], caption: 'A creator caption #reel', coverSeconds: null })
    const [instagram, tiktok, x, facebook] = first.files
    expect(instagram.video).toBe(join(folder, 'My reel - Version 2 - Instagram Reels.mp4'))
    const render = await fs.readFile(source)
    for (const file of [tiktok, x, facebook]) expect((await fs.readFile(file.video)).equals(render)).toBe(true)
    // Instagram: "no edit lists" and 128 kb/s audio, with the picture untouched.
    expect([hasEditList(source), hasEditList(instagram.video)]).toEqual([true, false])
    expect(audioBitrate(instagram.video)).toBeLessThan(130_000) // ffmpeg's 128k AAC measures a few bits over
    expect(videoPackets(instagram.video)).toBe(videoPackets(source))
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

  it('fails if a platform limit stops the export: a 2 s video with an over-long caption, 31 hashtags and 21 mentions', async () => {
    const source = finalRender(join(scratch, 'short.mp4'), 2)
    const folder = join(scratch, 'over limits')
    const caption = `${'#tag'.repeat(31)} ${Array.from({ length: 21 }, (_, i) => `@person${i}`).join(' ')} ${'x'.repeat(2200)}`
    const result = await exportPlatforms({ source, chosenCover: null, folder, name: 'Over', request: { platforms: ['instagram', 'linkedin'], caption, coverSeconds: null }, runEngine })
    expect(result.files.map((file) => file.platform)).toEqual(['instagram', 'linkedin'])
    expect(await fs.readFile(result.files[0].captionFile, 'utf8')).toBe(`${caption}\n`)
  })

  it('fails if a render over a platform\'s size limit is not re-encoded under it, or one that fits is', () => {
    const video = { duration: 600, sizeBytes: 400_000_000, audioBitrate: 128_000, editList: false }
    // 300 MB × 0.94 × 8 bits / 600 s, less 128 kb/s for the audio
    expect(outputGroups(['instagram', 'facebook', 'x'], video)).toEqual([{ platforms: ['instagram'], bitrate: 3_632_000 }])
    // Too long for any bitrate the engine takes: the floor, then the size check after encoding.
    expect(outputGroups(['instagram'], { ...video, duration: 9_000 })).toEqual([{ platforms: ['instagram'], bitrate: 128_000 }])
    // Edit lists and 192k audio matter only to Instagram and Threads.
    expect(outputGroups(['facebook', 'x', 'tiktok', 'linkedin'], { ...video, sizeBytes: 900_000_000, editList: true, audioBitrate: 192_000 }))
      .toEqual([{ platforms: ['linkedin'], bitrate: 6_138_666 }])
  })

  it('fails if a file with no picture is exported as a finished video', async () => {
    const source = join(scratch, 'sound only.mp4')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', source])
    const folder = join(scratch, 'sound only')
    await expect(exportPlatforms({ source, chosenCover: null, folder, name: 'Sound', request: { platforms: ['tiktok'], caption: '', coverSeconds: null }, runEngine }))
      .rejects.toMatchObject({ code: 'EXPORT_FAILED' })
  })

  it('fails if a re-encode changes the picture size, keeps the edit list, or misses its bitrate', async () => {
    const source = finalRender(join(scratch, 'too big.mp4'), 4)
    const dest = join(scratch, 'smaller.mp4')
    await runEngine('export-media', [source, '--dest', dest, '--bitrate', '400000'])
    expect(await runEngine('probe', [dest])).toMatchObject({ vcodec: 'h264', acodec: 'aac', width: 1080, height: 1920, pixFmt: 'yuv420p' })
    expect(hasEditList(dest)).toBe(false)
    const videoBitrate = Number(ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', dest]))
    expect(videoBitrate).toBeLessThan(500_000)
  }, 60_000)

  // A fifo stands in for a slow drive: reading it blocks until something writes, so the probe never finishes on its own.
  it.skipIf(process.platform === 'win32')('fails if Stop while the render is still being read does not end the export at once, or leaves anything', async () => {
    const folder = join(scratch, 'stopped while reading')
    mkdirSync(folder)
    const source = join(scratch, 'slow drive.mp4')
    execFileSync('mkfifo', [source])
    // Opening and closing the write end lets a reader that was never stopped see the end and exit, even after a timeout.
    onTestFinished(async () => (await fs.open(source, 'r+')).close())
    const stop = new AbortController()
    const reading: typeof runEngine = (command, args, onProgress, signal) => {
      if (command === 'export-probe') setTimeout(() => stop.abort(), 500)
      return runEngine(command, args, onProgress, signal)
    }
    await expect(exportPlatforms({ source, chosenCover: null, folder, name: 'Slow', request: { platforms: ['tiktok'], caption: '', coverSeconds: null }, runEngine: reading, signal: stop.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readdir(folder)).toEqual([])
  }, 10_000)

  it('fails if Stop during the Instagram remux leaves a file or the staging folder behind', async () => {
    const source = finalRender(join(scratch, 'long.mp4'), 20)
    const folder = join(scratch, 'stopped')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const request: PlatformExportRequest = { platforms: ['x', 'instagram'], caption: '', coverSeconds: null }
    const stop = new AbortController()
    const running = exportPlatforms({ source, chosenCover: null, folder,
      name: 'Long', request, runEngine, signal: stop.signal, onProgress: (_message, pct) => { if (pct > 0) stop.abort() } })
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if Stop as the second platform lands leaves files behind', async () => {
    const source = finalRender(join(scratch, 'late stop.mp4'), 3)
    const folder = join(scratch, 'late stop')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const request: PlatformExportRequest = { platforms: ['tiktok', 'youtube'], caption: 'Hi', coverSeconds: null }
    const stop = new AbortController()
    const secondVideo = join(folder, 'Late - YouTube Shorts.mp4')
    const { copyFile, link } = fs
    const stubs = [
      vi.spyOn(fs, 'copyFile').mockImplementation((from, to, mode) => { if (to === secondVideo) stop.abort(); return copyFile(from, to, mode) }),
      vi.spyOn(fs, 'link').mockImplementation((from, to) => { if (to === secondVideo) stop.abort(); return link(from, to) })
    ]
    try {
      await expect(exportPlatforms({ source, chosenCover: null, folder, name: 'Late', request, runEngine, signal: stop.signal }))
        .rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual(['earlier export.mp4'])
  })

  it('fails if a placed file that cannot be removed hides that the export stopped', async () => {
    const source = finalRender(join(scratch, 'stuck.mp4'), 3)
    const folder = join(scratch, 'stuck')
    mkdirSync(folder)
    const stop = new AbortController()
    const stuck = join(folder, 'Stuck - TikTok.mp4')
    const { link, rm } = fs
    const stubs = [
      vi.spyOn(fs, 'link').mockImplementation((from, to) => { if (to === join(folder, 'Stuck - YouTube Shorts.mp4')) stop.abort(); return link(from, to) }),
      vi.spyOn(fs, 'rm').mockImplementation((path, options) => path === stuck
        ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
        : rm(path, options))
    ]
    try {
      await expect(exportPlatforms({ source, chosenCover: null, folder, name: 'Stuck', request: { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }, runEngine, signal: stop.signal }))
        .rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
  })

  it('fails if a copy that runs out of space halfway leaves a half-written video in Finished videos', async () => {
    const source = finalRender(join(scratch, 'full drive.mp4'), 3)
    const folder = join(scratch, 'full drive')
    mkdirSync(folder)
    const request: PlatformExportRequest = { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }
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
      await expect(exportPlatforms({ source, chosenCover: null, folder, name: 'Full', request, runEngine }))
        .rejects.toMatchObject({ code: 'ENOSPC' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual([])
  })
  // Real locks, not mocks: PowerShell opens the file with FileShare.None for 600 ms, as a stopped ffmpeg or a virus scanner can.
  it.runIf(process.platform === 'win32')('removes a staging folder whose file is still locked for a moment', async () => {
    const folder = join(scratch, 'sweep-locked')
    const stage = join(folder, '.platform-export-locked')
    const file = join(stage, 'video.mp4')
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(file, 'leftover')
    await holdFor600ms(file)
    await expect(fs.rm(stage, { recursive: true, force: true })).rejects.toMatchObject({ code: 'EBUSY' })
    await sweepExportStaging(folder)
    expect(await fs.readdir(folder)).toEqual([])
  })

  it.runIf(process.platform === 'win32')('fails if Stop leaves a placed video in Finished videos because Windows held it for a moment', async () => {
    const source = finalRender(join(scratch, 'held.mp4'), 3)
    const folder = join(scratch, 'held')
    mkdirSync(folder)
    const held = join(folder, 'Held - TikTok.mp4')
    const stop = new AbortController()
    const { link } = fs
    const stub = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (to === join(folder, 'Held - YouTube Shorts.mp4')) {
        await holdFor600ms(held)
        stop.abort()
      }
      return link(from, to)
    })
    try {
      await expect(exportPlatforms({ source, chosenCover: null, folder, name: 'Held', request: { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }, runEngine, signal: stop.signal }))
        .rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual([])
  })
})

/** Resolves once PowerShell holds `file` open with no sharing; it lets go 600 ms later. */
async function holdFor600ms(file: string): Promise<void> {
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Milliseconds 600; $f.Close()`])
  await new Promise<void>((ok, fail) => {
    holder.stdout.on('data', (d: Buffer) => d.toString().includes('locked') && ok())
    holder.on('error', fail)
    holder.on('exit', (code) => fail(new Error(`PowerShell exited with ${code} before it held ${file}`)))
  })
}
