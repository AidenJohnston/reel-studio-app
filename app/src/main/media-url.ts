// URLs for local media shown in the renderer. Served by the reel-media: protocol in media.ts,
// which only answers for files inside the Reel Studio root.
export const MEDIA_SCHEME = 'reel-media'

export function mediaUrl(absPath: string, bust?: number): string {
  const q = bust ? `?v=${Math.round(bust)}` : ''
  return `${MEDIA_SCHEME}://f/${encodeURIComponent(absPath)}${q}`
}

export function pathFromMediaUrl(url: string): string {
  const u = new URL(url)
  return decodeURIComponent(u.pathname.replace(/^\//, ''))
}
