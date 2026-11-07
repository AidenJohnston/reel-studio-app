// The Library screen's previews: a strip of four frames for a clip, the loudness shape of a song or a sound
// effect. Made once with ffmpeg and kept under app data, keyed by the file's path, size and time, so the
// screen never decodes a video itself and mounts no <video> for it.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import type { LibraryPreview } from '../shared/api'
import { isStrictlyInsideFolder } from './inside-folder'
import { binForFolder, isVideo, AUDIO_EXT } from './library'
import { mediaUrl } from './media-url'
import { binDir, ffmpegPath, ffprobePath, libraryPreviewDir, sfxPackDir } from './paths'

// A Library file is untrusted input: only local files and the media demuxers, so a playlist (an HLS or concat
// file renamed .mp4) can't make ffmpeg open other files or the network. The same list as engine asset_preview.py.
const INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi,wav,mp3,flac,ogg,aac']
const PEAKS = 120
const RATE = 2000
const TILE = { w: 135, h: 240 }

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) =>
    execFile(bin, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, out) => (err ? fail(err) : ok(out)))
  )
}

/** Evenly spaced 0..1 peaks of mono float samples, scaled so the loudest is 1. */
export function peaksOf(samples: Float32Array, n = PEAKS): number[] {
  const out = new Array<number>(n).fill(0)
  if (!samples.length) return out
  for (let i = 0; i < samples.length; i++) {
    const b = Math.min(n - 1, Math.floor((i / samples.length) * n))
    const v = Math.abs(samples[i])
    if (v > out[b]) out[b] = v
  }
  const top = Math.max(...out)
  return top > 0 ? out.map((v) => Math.round((v / top) * 1000) / 1000) : out
}

async function audioPreview(file: string): Promise<LibraryPreview> {
  const raw = await run(ffmpegPath(), ['-nostdin', '-v', 'error', ...INPUT, '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'])
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
  return { durationSec: samples.length / RATE, peaks: peaksOf(samples) }
}

async function videoPreview(file: string, sheet: string): Promise<LibraryPreview> {
  const probe = await run(ffprobePath(), ['-v', 'error', ...INPUT, '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  const durationSec = Number(probe.toString().trim())
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`no duration for ${file}`)
  const at = [0.08, 0.36, 0.64, 0.92].map((f) => (durationSec * f).toFixed(3))
  const fit = `scale=${TILE.w}:${TILE.h}:force_original_aspect_ratio=increase,crop=${TILE.w}:${TILE.h},setsar=1`
  await run(ffmpegPath(), [
    '-nostdin', '-v', 'error', '-y',
    ...at.flatMap((t) => [...INPUT, '-ss', t, '-i', file]),
    '-filter_complex', `${at.map((_, i) => `[${i}:v:0]${fit}[t${i}]`).join(';')};${at.map((_, i) => `[t${i}]`).join('')}hstack=inputs=4`,
    '-frames:v', '1', '-q:v', '4', sheet
  ])
  return { durationSec, sheet: mediaUrl(sheet) }
}

const inside = (file: string, dir: string): boolean => resolve(file).startsWith(resolve(dir) + sep)

/** Only Library clips and songs and the bundled sound effects get a preview; anything else is refused. */
function kindOf(file: string): 'video' | 'audio' {
  const bin = binForFolder(file)
  const audio = AUDIO_EXT.has(extname(file).toLowerCase()) || extname(file).toLowerCase() === '.opus'
  if ((bin === 'broll' || bin === 'raw') && isVideo(file)) return 'video'
  if ((bin === 'music' && audio) || (inside(file, sfxPackDir()) && audio)) return 'audio'
  throw { code: 'BAD_ARGS', userMessage: 'That file has no preview.' }
}

let running = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

const pending = new Map<string, Promise<LibraryPreview>>()

export async function libraryPreview(file: string): Promise<LibraryPreview> {
  const kind = kindOf(file)
  // The checks above read the path as written. A file in a bin can be a link to anywhere (a shared drive, a folder
  // set up by hand), and ffmpeg would follow it, so the file itself must resolve inside its folder's real place. A
  // whole bin that is a link to another folder still works: both sides are resolved. The same rule as reel-media:
  // (media.ts).
  const bin = binForFolder(file)
  const [real, folder] = await Promise.all([fs.realpath(file), fs.realpath(bin ? binDir(bin) : sfxPackDir())])
  if (!isStrictlyInsideFolder(real, folder)) throw { code: 'BAD_ARGS', userMessage: 'That file has no preview.' }
  file = real
  const st = await fs.stat(file)
  if (!st.isFile()) throw { code: 'BAD_ARGS', userMessage: 'That file has no preview.' }
  const key = createHash('sha1').update(`${resolve(file)}\0${st.size}\0${st.mtimeMs}`).digest('hex')
  const json = join(libraryPreviewDir(), `${key}.json`)
  const kept = await fs.readFile(json, 'utf8').then((t) => JSON.parse(t) as LibraryPreview, () => null)
  if (kept) return kept
  const busy = pending.get(key)
  if (busy) return busy
  const made = slot(async () => {
    await fs.mkdir(dirname(json), { recursive: true })
    const p = kind === 'video' ? await videoPreview(file, join(libraryPreviewDir(), `${key}.jpg`)) : await audioPreview(file)
    await fs.writeFile(json, JSON.stringify(p))
    return p
  }).finally(() => pending.delete(key))
  pending.set(key, made)
  return made
}
