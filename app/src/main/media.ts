// The reel-media: protocol. Streams files with HTTP range support so <video> can seek.
import { protocol } from 'electron'
import { MEDIA_SCHEME } from './media-url'
import { serveMedia } from './media-file'

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export function handleMediaProtocol(allowedRoots: () => string[], stagingRoots: () => string[] = () => []): void {
  protocol.handle(MEDIA_SCHEME, (req) => serveMedia(req, allowedRoots, stagingRoots))
}
