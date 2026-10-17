// "Send to my phone": a tiny, temporary web server on this computer's home-network address that
// serves exactly ONE finished video, plus a phone-sized page to play and save it. The phone opens it
// by scanning a QR code. No Electron imports, so the unit tests run it under plain Node.
//
// Security model (the link travels as a QR code on the screen, the network is the person's Wi-Fi):
// - listens only on the chosen LAN address, on a random port, and stops by itself (15 minutes),
//   when the panel closes, or when the app quits;
// - every URL carries a 256-bit one-time token, compared in constant time; anything else is a 404
//   (no directory listing, no other file, no other method than GET/HEAD);
// - the Host header must be the address we listen on (a web page elsewhere cannot rebind a name to it);
// - no CORS headers, no caching, no referrer, a strict CSP on the page;
// - nothing about the file, the token or the caption is logged here.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { basename } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'

export const SHARE_TTL_MS = 15 * 60_000

// ---- which address the phone can reach ----------------------------------------------------------

export interface LanAddress {
  address: string
  /** The operating system's name for the adapter ("Wi-Fi", "en0", "vEthernet (WSL)"). */
  name: string
  /** Plain words for the "Use a different network" list. */
  label: string
  /** Looks like a real home/office network, not a VPN or a virtual adapter. */
  likely: boolean
}

const VIRTUAL = /vethernet|virtualbox|vbox|vmware|vmnet|hyper-v|wsl|docker|br-|bridge|utun|tun|tap|tailscale|zerotier|wireguard|wg\d|ppp|vpn|loopback|awdl|llw|anpi|npcap|hamachi|radmin|nordlynx|openvpn|cisco|fortinet|globalprotect|pangp/i
const REAL = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i

function isPrivateV4(a: string): boolean {
  const p = a.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
}

function friendlyName(name: string): string {
  if (/wi-?fi|wlan|wireless|^wl/i.test(name)) return 'Wi-Fi'
  if (/^en0$/.test(name)) return 'Wi-Fi or network' // en0 is Wi-Fi on most Macs, Ethernet on some
  if (/ethernet|^en\d|^eth\d/i.test(name)) return 'Cable network'
  return name
}

/**
 * Private IPv4 addresses a phone on the same Wi-Fi could reach, best first: real Wi-Fi/Ethernet before
 * VPN and virtual adapters, 192.168.x before 10.x before 172.16-31.x (Docker and WSL live in 172.x).
 * Link-local (169.254), carrier-grade NAT (100.64/10, Tailscale) and loopback are left out.
 */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanAddress[] {
  const out: (LanAddress & { score: number })[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      const v4 = i.family === 'IPv4' || (i.family as unknown) === 4
      if (!v4 || i.internal || !isPrivateV4(i.address)) continue
      const virtual = VIRTUAL.test(name)
      const real = !virtual && REAL.test(name)
      const range = i.address.startsWith('192.168.') ? 0 : i.address.startsWith('10.') ? 1 : 2
      const score = (virtual ? 100 : real ? 0 : 10) + range
      out.push({ address: i.address, name, label: `${friendlyName(name)} (${i.address})`, likely: !virtual, score })
    }
  }
  out.sort((a, b) => a.score - b.score || a.address.localeCompare(b.address))
  return out.map(({ score: _s, ...a }) => a)
}

// ---- the server --------------------------------------------------------------------------------

export type ShareEvent = { kind: 'page' } | { kind: 'video' } | { kind: 'stopped'; reason: 'timeout' | 'closed' }

export interface ShareOptions {
  /** The one file this server may send. */
  file: string
  /** Shown on the phone page with a Copy button. */
  caption: string
  /** The video's name, for the page title and the saved file name. */
  title: string
  /** The LAN address to listen on (from lanAddresses()). */
  host: string
  ttlMs?: number
  onEvent?: (e: ShareEvent) => void
}

export interface ShareServer {
  url: string
  host: string
  port: number
  expiresAt: number
  size: number
  stop(): Promise<void>
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Constant-time: hashing first makes both sides the same length, so length leaks nothing either. */
function tokenMatches(given: string, expected: Buffer): boolean {
  return timingSafeEqual(sha(given), expected)
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** `Content-Disposition` with a plain-ASCII fallback and the real (possibly accented) name. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** One `bytes=` range (multi-range requests get the whole file, which RFC 9110 allows). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return header.includes(',') ? null : 'invalid'
  if (!m[1] && !m[2]) return 'invalid'
  let start: number
  let end: number
  if (!m[1]) {
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

export async function startShare(opts: ShareOptions): Promise<ShareServer> {
  const st = await fs.stat(opts.file)
  if (!st.isFile()) throw new Error('not a file')
  const size = st.size
  const token = randomBytes(32).toString('base64url')
  const expected = sha(token)
  const fileName = basename(opts.file)
  const ttl = opts.ttlMs ?? SHARE_TTL_MS
  const sockets = new Set<Socket>()
  const seen = { page: false, video: false }
  let stopped = false
  let hostHeader = ''
  let timer: NodeJS.Timeout | undefined

  const emit = (e: ShareEvent): void => {
    try {
      opts.onEvent?.(e)
    } catch {
      /* a listener's mistake never takes the server down */
    }
  }

  const notFound = (res: ServerResponse): void => {
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '9' })
    res.end('Not found')
  }

  const sendPage = (req: IncomingMessage, res: ServerResponse): void => {
    const nonce = randomBytes(16).toString('base64')
    const body = Buffer.from(phonePage({ title: opts.title, caption: opts.caption, size, nonce }), 'utf8')
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.length),
      'Content-Security-Policy': `default-src 'none'; media-src 'self'; img-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  }

  const sendVideo = (req: IncomingMessage, res: ServerResponse, save: boolean): void => {
    const range = parseRange(req.headers.range, size)
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition(save ? 'attachment' : 'inline', `${opts.title}.mp4`.replace(/[\\/:*?"<>|]/g, '_') || fileName)
    }
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
      res.end()
      return
    }
    const { start, end } = range ?? { start: 0, end: size - 1 }
    if (range) {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(206, { ...headers, 'Content-Length': String(end - start + 1) })
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': String(size) })
    }
    if (req.method === 'HEAD' || size === 0) {
      res.end()
      return
    }
    const stream = createReadStream(opts.file, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  const server: Server = createServer((req, res) => {
    if (stopped) return notFound(res)
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)
    if ((req.headers.host ?? '').toLowerCase() !== hostHeader) return notFound(res)
    const raw = req.url ?? ''
    const q = raw.indexOf('?')
    const path = q === -1 ? raw : raw.slice(0, q)
    const query = q === -1 ? '' : raw.slice(q + 1)
    const parts = path.split('/')
    // "/<token>/" or "/<token>/video.mp4", nothing else.
    if (parts.length !== 3 || parts[0] !== '' || !tokenMatches(parts[1], expected)) return notFound(res)
    if (parts[2] === '' && query === '') {
      if (!seen.page) {
        seen.page = true
        emit({ kind: 'page' })
      }
      return sendPage(req, res)
    }
    if (parts[2] === 'video.mp4' && (query === '' || query === 'save=1')) {
      if (!seen.video) {
        seen.video = true
        emit({ kind: 'video' })
      }
      return sendVideo(req, res, query === 'save=1')
    }
    return notFound(res)
  })
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000 // the request only (a GET is just headers); sending a big video may take longer
  server.keepAliveTimeout = 5_000
  server.maxConnections = 32
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: opts.host, port: 0, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  hostHeader = `${opts.host}:${port}`.toLowerCase()

  const stop = async (reason: 'timeout' | 'closed' = 'closed'): Promise<void> => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      for (const s of sockets) s.destroy()
    })
    emit({ kind: 'stopped', reason })
  }
  timer = setTimeout(() => void stop('timeout'), ttl)
  timer.unref?.()

  return {
    url: `http://${opts.host}:${port}/${token}/`,
    host: opts.host,
    port,
    expiresAt: Date.now() + ttl,
    size,
    stop: () => stop('closed')
  }
}

// ---- the phone page ----------------------------------------------------------------------------

function megabytes(n: number): string {
  return n < 1_000_000 ? 'less than 1 MB' : `${Math.round(n / 1_000_000)} MB`
}

/** The page the phone sees: the video, how to save it, and the post caption with a Copy button. */
export function phonePage(p: { title: string; caption: string; size: number; nonce: string }): string {
  const caption = p.caption.trim()
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>${esc(p.title)} · Reel Studio</title>
<style nonce="${p.nonce}">
  :root { color-scheme: light; --ink:#1d1b18; --ink2:#57524c; --line:#e6e1d9; --bg:#f7f5f1; --panel:#fff; --green:#1f6b42; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font: 17px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-text-size-adjust:100%; }
  main { max-width: 520px; margin: 0 auto; padding: 18px 18px 40px; display:flex; flex-direction:column; gap:18px; }
  h1 { font-size: 22px; margin: 0; }
  .sub { color: var(--ink2); margin: 2px 0 0; font-size: 15px; }
  video { width:100%; max-height: 62vh; aspect-ratio: 9/16; background:#000; border-radius:14px; display:block; object-fit:contain; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .card h2 { font-size:17px; margin:0 0 8px; }
  ol { margin:0; padding-left: 22px; } li { margin: 6px 0; }
  .btn { display:flex; align-items:center; justify-content:center; gap:8px; min-height:52px; border-radius:12px; border:1px solid var(--ink); background:var(--ink); color:#fff; font-size:17px; font-weight:600; text-decoration:none; width:100%; }
  .btn.light { background:#fff; color:var(--ink); border-color:#d6cfc4; }
  textarea { width:100%; min-height:110px; font: inherit; font-size:16px; border:1px solid var(--line); border-radius:10px; padding:10px; background:#fbfaf8; color:var(--ink); }
  .ok { color: var(--green); font-weight:600; min-height: 1.4em; margin: 6px 0 0; }
  .hide { display:none; }
  .small { font-size: 14px; color: var(--ink2); }
</style>
</head>
<body>
<main>
  <div>
    <h1>Your video is here</h1>
    <p class="sub">${esc(p.title)} · ${megabytes(p.size)}</p>
  </div>
  <video src="video.mp4#t=0.1" controls playsinline preload="metadata"></video>

  <div class="card" id="ios">
    <h2>iPhone or iPad: save it to Photos</h2>
    <ol>
      <li>Tap <b>Save video</b> below, then tap <b>Download</b>.</li>
      <li>Tap the download arrow in Safari's address bar (or <b>aA</b> &rsaquo; <b>Downloads</b>), then tap your video.</li>
      <li>Tap <b>Share</b> (the square with the arrow pointing up), then <b>Save Video</b>. It is now in Photos, ready for Instagram.</li>
    </ol>
  </div>
  <div class="card" id="android">
    <h2>Android: save it to your phone</h2>
    <ol>
      <li>Tap <b>Save video</b> below.</li>
      <li>It goes to <b>Downloads</b>, and shows up in your Gallery or Photos app.</li>
      <li>Open Instagram, tap <b>+</b>, and pick it.</li>
    </ol>
  </div>
  <a class="btn" href="video.mp4?save=1" download>Save video</a>

  ${
    caption
      ? `<div class="card">
    <h2>Your post caption</h2>
    <textarea id="cap" readonly>${esc(caption)}</textarea>
    <button class="btn light" id="copy" type="button">Copy caption</button>
    <p class="ok" id="copied" aria-live="polite"></p>
    <p class="small">Paste it into Instagram when you post.</p>
  </div>`
      : ''
  }
  <p class="small">This link stops working by itself in 15 minutes. It only works on your home Wi-Fi.</p>
</main>
<script nonce="${p.nonce}">
  (function () {
    var ua = navigator.userAgent || '';
    var apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
    var android = /Android/.test(ua);
    if (apple) document.getElementById('android').className += ' hide';
    if (android) document.getElementById('ios').className += ' hide';
    var btn = document.getElementById('copy');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var t = document.getElementById('cap');
      var done = function () { document.getElementById('copied').textContent = 'Copied. Paste it in Instagram.'; };
      // A plain http page on the home network is not a "secure context", so navigator.clipboard is
      // often missing: select the text and use the older copy command, which phones still honour.
      t.removeAttribute('readonly');
      t.focus();
      t.setSelectionRange(0, t.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      t.setAttribute('readonly', '');
      if (ok) return done();
      if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done, function () {});
      else document.getElementById('copied').textContent = 'Press and hold the text, then tap Copy.';
    });
  })();
</script>
</body>
</html>`
}
