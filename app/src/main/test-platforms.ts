// Test builds only (REELSTUDIO_TEST=1): REELSTUDIO_TEST_PLATFORMS=<http://127.0.0.1:port> sends every https call the
// Instagram and TikTok services make to that local stand-in instead, as <stand-in>/<host><path>, so e2e specs
// (e2e/social.spec.ts) drive the real services against fake platforms. index.ts never installs it otherwise.
type Fetch = (url: string, init: RequestInit) => Promise<Response>

export function testPlatformFetch(base: string, real: Fetch): Fetch {
  const stand = new URL(base)
  if (stand.protocol !== 'http:' || stand.hostname !== '127.0.0.1') throw new Error('REELSTUDIO_TEST_PLATFORMS must be http://127.0.0.1:<port>')
  return (url, init) => {
    const u = new URL(url)
    if (u.protocol !== 'https:') return real(url, init)
    return real(`${stand.origin}/${u.host}${u.pathname}${u.search}`, init)
  }
}
