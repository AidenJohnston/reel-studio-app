// The reel-media: protocol. Streams files with HTTP range support so <video> can seek.
import { protocol } from 'electron'
import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { extname, resolve, sep, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { isLinkedMedia } from './media-allow'
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

function inside(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep)
}

function allowedNetworkPath(file: string, roots: string[]): boolean {
  const path = win32.resolve(file).toLowerCase()
  return roots.some((root) => {
    if (!/^[\\/]{2}[^?.\\/][^\\/]*[\\/][^\\/]+/.test(root)) return false
    const allowed = win32.resolve(root).toLowerCase()
    return path === allowed || path.startsWith(allowed.endsWith('\\') ? allowed : allowed + '\\')
  })
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export function handleMediaProtocol(allowedRoots: () => string[]): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const allowed = allowedRoots()
    let file: string
    try {
      const requested = pathFromMediaUrl(req.url)
      if (/^[\\/]{2}/.test(requested) && !allowedNetworkPath(requested, allowed)) return new Response('forbidden', { status: 403 })
      file = resolve(requested)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const real = await fs.realpath(file).catch(() => null)
    if (!real) {
      const known = allowed.some((r) => inside(file, resolve(r)))
      return known ? new Response('not found', { status: 404 }) : new Response('forbidden', { status: 403 })
    }
    const roots = (await Promise.all(allowed.map((r) => fs.realpath(r).catch(() => null)))).filter((r) => r !== null)
    if (!roots.some((root) => inside(real, root)) && !(await isLinkedMedia(real, roots))) return new Response('forbidden', { status: 403 })
    let handle: FileHandle | undefined
    let streaming = false
    try {
      handle = await fs.open(real, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0))
      const opened = await handle.stat()
      const checked = await fs.realpath(real)
      const current = await fs.stat(checked)
      if (opened.dev !== current.dev || opened.ino !== current.ino ||
        (!roots.some((root) => inside(checked, root)) && !(await isLinkedMedia(checked, roots)))) {
        return new Response('forbidden', { status: 403 })
      }
      const size = opened.size
      const type = TYPES[extname(checked).toLowerCase()] ?? 'application/octet-stream'
      const headers: Record<string, string> = { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
      const range = req.headers.get('range')
      const m = range && /bytes=(\d*)-(\d*)/.exec(range)
      let start = 0
      let end = size - 1
      let status = 200
      if (m && size > 0) {
        start = m[1] ? Number(m[1]) : 0
        end = m[2] ? Number(m[2]) : size - 1
        if (!m[1] && m[2]) {
          start = Math.max(0, size - Number(m[2]))
          end = size - 1
        }
        end = Math.min(end, size - 1)
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        }
        status = 206
        headers['Content-Length'] = String(end - start + 1)
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      }
      // FileHandle streams retain this descriptor and close it on end, error or cancellation.
      const stream = handle.createReadStream(status === 206 ? { start, end } : {})
      const response = new Response(Readable.toWeb(stream), { status, headers })
      streaming = true
      return response
    } catch {
      return new Response('not found', { status: 404 })
    } finally {
      if (handle && !streaming) await handle.close()
    }
  })
}
