import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, promises as fs, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { exportPlatforms, makeStagingFolder, sweepExportStaging, type ExportTry } from '../src/main/platform-export'
import { coverFrame, outputGroups, type Platform } from '../src/shared/platforms'
import { PYTHON } from './helpers'

const scratch = mkdtempSync(join(tmpdir(), 'rs-platform-export-'))
const engine = resolve(__dirname, '../../engine')
const runEngine = createEngineRunner({ python: () => PYTHON, env: () => ({
  ...process.env, PYTHONPATH: engine, REELENGINE_ROOT: join(scratch, 'root'), REELENGINE_CACHE: join(scratch, 'cache')
}) })

afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

type Request = { platforms: Platform[]; caption: string; coverSeconds: number | null }
/** One try, as an export with Try two versions off sends it. */
const oneTry = (source: string, chosenCover: string | null, name: string, request: Request): [ExportTry] => [{ version: 1, source, chosenCover, name, ...request }]

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
    const run = (request: Request) => exportPlatforms({ tries: oneTry(source, chosenCover, name, request), folder, runEngine })

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
    const result = await exportPlatforms({ tries: oneTry(source, null, 'Over', { platforms: ['instagram', 'linkedin'], caption, coverSeconds: null }), folder, runEngine })
    expect(result.files.map((file) => file.platform)).toEqual(['instagram', 'linkedin'])
    expect(await fs.readFile(result.files[0].captionFile, 'utf8')).toBe(`${caption}\n`)
  })

  it('fails if a render over a platform\'s size limit is not re-encoded under it, or one that fits is', () => {
    const video = { duration: 600, vduration: 600, fps: 30, sizeBytes: 400_000_000, audioBitrate: 128_000, editList: false }
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
    await expect(exportPlatforms({ tries: oneTry(source, null, 'Sound', { platforms: ['tiktok'], caption: '', coverSeconds: null }), folder, runEngine }))
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
    await expect(exportPlatforms({ tries: oneTry(source, null, 'Slow', { platforms: ['tiktok'], caption: '', coverSeconds: null }), folder, runEngine: reading, signal: stop.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await fs.readdir(folder)).toEqual([])
  }, 10_000)

  it('fails if Stop during the Instagram remux leaves a file or the staging folder behind', async () => {
    const source = finalRender(join(scratch, 'long.mp4'), 20)
    const folder = join(scratch, 'stopped')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const stop = new AbortController()
    const running = exportPlatforms({ tries: oneTry(source, null, 'Long', { platforms: ['x', 'instagram'], caption: '', coverSeconds: null }), folder,
      runEngine, signal: stop.signal, onProgress: (_message, pct) => { if (pct > 0) stop.abort() } })
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
    const tries: [ExportTry, ExportTry] = [{ ...one, coverSeconds: null }, { ...one, coverSeconds: 1 }]
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

  it('fails if Stop during Try 2\'s remux leaves any Try 1 file or the staging folder', async () => {
    const first = finalRender(join(scratch, 'try 1.mp4'), 3)
    const second = join(scratch, 'try 2 small.mp4')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second])
    const folder = join(scratch, 'stopped-two')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const tries: [ExportTry, ExportTry] = [
      { version: 1, source: first, chosenCover: null, name: 'Mine - Version 1', platforms: ['instagram', 'tiktok'], caption: 'First', coverSeconds: null },
      { version: 2, source: second, chosenCover: null, name: 'Mine - Version 2', platforms: ['instagram'], caption: 'First', coverSeconds: null }
    ]
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

  it('fails if a Try 2 cover that saves the same frame as Try 1\'s counts as a change', async () => {
    const source = finalRender(join(scratch, 'same frame.mp4'), 3)
    const platforms: Platform[] = ['instagram']
    const one = { version: 1, source, chosenCover: null, name: 'Frame - Version 1', platforms, caption: 'Same' }
    // The very end and 2.97 s both save frame 88 of 90: the engine moves a time in the last two frames back to 3 - 2/30 s.
    await expect(exportPlatforms({ tries: [{ ...one, coverSeconds: 3 }, { ...one, coverSeconds: 2.97 }], folder: join(scratch, 'same frame'), runEngine }))
      .rejects.toMatchObject({ code: 'BAD_EXPORT', userMessage: 'Try 2 is the same as Try 1. Pick another version, cover or caption.' })
  })

  it('fails if a Try 2 cover on the frame Try 1 falls back to, with no cover picture, counts as a change', async () => {
    const source = finalRender(join(scratch, 'no cover.mp4'), 12)
    const platforms: Platform[] = ['instagram']
    const one = { version: 1, source, chosenCover: null, name: 'Fallback - Version 1', platforms, caption: 'Same' }
    // With no cover picture, Try 1 gets the frame at a quarter of the video, at most 3 s.
    await expect(exportPlatforms({ tries: [{ ...one, coverSeconds: null }, { ...one, coverSeconds: 3 }], folder: join(scratch, 'fallback'), runEngine }))
      .rejects.toMatchObject({ code: 'BAD_EXPORT', userMessage: 'Try 2 is the same as Try 1. Pick another version, cover or caption.' })
  })

  it('fails if coverFrame names a different frame from the one export-cover saves', async () => {
    // Each frame's brightness is its number, so the saved JPEG says which frame the engine took. B-frames and an
    // edit list, like a final render.
    const clip = join(scratch, 'numbered.mp4')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=64x64:r=30:d=3,geq=lum='16+2*N':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-preset', 'medium', '-bf', '3', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', clip])
    const saved = async (at: number): Promise<number> => {
      const dest = join(scratch, `numbered ${at}.jpg`)
      await runEngine('export-cover', [clip, '--at', String(at), '--dest', dest])
      const [luma] = execFileSync('ffmpeg', ['-v', 'error', '-i', dest, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
      return Math.round(luma * 219 / 255 / 2) // cover() saves full range: 2N limited-range steps become 2N × 255/219
    }
    const clock = { fps: 30, end: 3, fallback: null }
    for (const at of [0, 0.01, 1, 1.0001, 1.01, 1.03, 1.034, 2.9, 2.95, 2.97, 3]) expect([at, coverFrame(at, clock)]).toEqual([at, await saved(at)])
  }, 60_000)

  it('fails if one export gives its sets different numbers', async () => {
    const source = finalRender(join(scratch, 'numbers.mp4'), 3)
    const folder = join(scratch, 'numbers')
    const run = async (platforms: Platform[]) => {
      const one = { version: 1, source, chosenCover: null, name: 'Mine - Version 1', coverSeconds: null }
      return exportPlatforms({ tries: [{ ...one, platforms, caption: 'First' }, { ...one, platforms: ['instagram'], caption: 'Second' }], folder, runEngine })
    }
    await run(['instagram'])
    // The creator adds TikTok and exports again: Instagram's names are taken, TikTok's are not.
    const again = await run(['instagram', 'tiktok'])
    expect(again.files.map((f) => basename(f.captionFile))).toEqual([
      'Mine - Version 1 - Instagram Reels - Try 1 (2) caption.txt', 'Mine - Version 1 - TikTok - Try 1 (2) caption.txt',
      'Mine - Version 1 - Instagram Reels - Try 2 (2) caption.txt'])
  })

  it('fails if Stop as the second platform lands leaves files behind', async () => {
    const source = finalRender(join(scratch, 'late stop.mp4'), 3)
    const folder = join(scratch, 'late stop')
    mkdirSync(folder)
    writeFileSync(join(folder, 'earlier export.mp4'), 'kept')
    const stop = new AbortController()
    const secondVideo = join(folder, 'Late - YouTube Shorts.mp4')
    const { copyFile, link } = fs
    const stubs = [
      vi.spyOn(fs, 'copyFile').mockImplementation((from, to, mode) => { if (to === secondVideo) stop.abort(); return copyFile(from, to, mode) }),
      vi.spyOn(fs, 'link').mockImplementation((from, to) => { if (to === secondVideo) stop.abort(); return link(from, to) })
    ]
    try {
      await expect(exportPlatforms({ tries: oneTry(source, null, 'Late', { platforms: ['tiktok', 'youtube'], caption: 'Hi', coverSeconds: null }), folder, runEngine, signal: stop.signal }))
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
      await expect(exportPlatforms({ tries: oneTry(source, null, 'Stuck', { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }), folder, runEngine, signal: stop.signal }))
        .rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
  })

  it('fails if a copy that runs out of space halfway leaves a half-written video in Finished videos', async () => {
    const source = finalRender(join(scratch, 'full drive.mp4'), 3)
    const folder = join(scratch, 'full drive')
    mkdirSync(folder)
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
      await expect(exportPlatforms({ tries: oneTry(source, null, 'Full', { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }), folder, runEngine }))
        .rejects.toMatchObject({ code: 'ENOSPC' })
    } finally {
      for (const stub of stubs) stub.mockRestore()
    }
    expect(await fs.readdir(folder)).toEqual([])
  })
  it.skipIf(process.platform !== 'win32')('fails if the staging folder is not hidden on Windows, where a leading dot hides nothing', async () => {
    const folder = join(scratch, 'hidden-stage')
    mkdirSync(folder)
    const stage = await makeStagingFolder(folder)
    const attributes = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Item -LiteralPath '${stage.replaceAll("'", "''")}' -Force).Attributes`]).toString()
    expect(attributes).toMatch(/\bHidden\b/)
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
      await expect(exportPlatforms({ tries: oneTry(source, null, 'Held', { platforms: ['tiktok', 'youtube'], caption: '', coverSeconds: null }), folder, runEngine, signal: stop.signal }))
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
