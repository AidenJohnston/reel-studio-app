// The reel-media: protocol. Streams files with HTTP range support so <video> can seek.
import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { isInsideFolder } from './inside-folder'
import { MEDIA_SCHEME, pathFromMediaUrl } from './media-url'

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac'
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export function handleMediaProtocol(allowedRoots: () => string[]): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    let file: string
    try {
      file = resolve(pathFromMediaUrl(req.url))
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const ok = allowedRoots().some((r) => isInsideFolder(file, r))
    if (!ok) return new Response('forbidden', { status: 403 })
    let size: number
    try {
      size = (await fs.stat(file)).size
    } catch {
      return new Response('not found', { status: 404 })
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    const range = req.headers.get('range')
    const m = range && /bytes=(\d*)-(\d*)/.exec(range)
    if (m && size > 0) {
      let start = m[1] ? Number(m[1]) : 0
      let end = m[2] ? Number(m[2]) : size - 1
      if (!m[1] && m[2]) {
        start = Math.max(0, size - Number(m[2]))
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    })
  })
}
