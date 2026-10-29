// The parts of website capture that need no Electron (capture.ts drives the window): which links
// may be captured, the two page layouts, and how to tell a page that refused us from a real one.
// Tested by test/capture-guard.test.ts.
import { lookup as dnsLookup } from 'node:dns/promises'
import net from 'node:net'

export type LookupFn = (host: string) => Promise<string[]>
export const defaultLookup: LookupFn = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** An error the AI tool turns into a plain sentence (same shape as engine errors). */
export interface CaptureError {
  code: string
  message: string
  userMessage: string
}
export function captureError(code: string, message: string, userMessage: string): CaptureError {
  return { code, message, userMessage }
}

const BLOCKED = new net.BlockList()
for (const [a, n] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as [string, number][]) BLOCKED.addSubnet(a, n, 'ipv4')
for (const [a, n] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]
] as [string, number][]) BLOCKED.addSubnet(a, n, 'ipv6')

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4')
  const fam = net.isIP(bare)
  if (fam === 4) return BLOCKED.check(bare, 'ipv4')
  if (fam === 6) {
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare)
    if (hex) {
      const a = parseInt(hex[1], 16)
      const b = parseInt(hex[2], 16)
      return BLOCKED.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, 'ipv4')
    }
    return BLOCKED.check(bare, 'ipv6')
  }
  return true
}

/** A bare "example.com" is fine: https:// is added. Anything but http(s) to a named host is refused. */
export function normaliseCaptureUrl(raw: string): URL {
  let s = String(raw ?? '').trim()
  if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw captureError('BAD_URL', `not a url: ${s.slice(0, 200)}`, "That isn't a web address. Try something like example.com.")
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw captureError('BAD_URL', `refused scheme ${u.protocol}`, 'I can only take screenshots of web pages (http or https).')
  }
  if (u.username || u.password) throw captureError('BAD_URL', 'credentials in url', "Links with a password in them can't be captured.")
  if (!u.hostname) throw captureError('BAD_URL', 'no host', "That isn't a web address.")
  return u
}

/** Every address the host resolves to must be public (no localhost, no home network). */
export async function publicHostAddress(host: string, lookup: LookupFn = defaultLookup): Promise<string | null> {
  const h = host.replace(/^\[|\]$/g, '')
  if (net.isIP(h)) return isBlockedAddress(h) ? null : h
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || !h.includes('.')) return null
  try {
    const addrs = await lookup(h)
    return addrs.length > 0 && !addrs.some(isBlockedAddress) ? addrs[0] : null
  } catch {
    return null
  }
}

export async function hostIsPublic(host: string, lookup: LookupFn = defaultLookup): Promise<boolean> {
  return (await publicHostAddress(host, lookup)) !== null
}

export async function assertCapturable(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  const u = normaliseCaptureUrl(raw)
  if (!(await hostIsPublic(u.hostname, lookup))) {
    throw captureError('BLOCKED_HOST', `refused ${u.hostname}`,
      "That address isn't a public website (or I couldn't find it), so I didn't open it.")
  }
  return u
}

/**
 * Page layouts. The window is drawn at the OUTPUT size and zoomed, so the page lays itself out for
 * a phone-wide (or laptop-wide) viewport but every pixel is sharp: phone = 432 x 936 CSS px drawn
 * at 1080 x 2340 (the 19.5:9 of the engine's phone-card), desktop = 1280 x 800 CSS px at 1920 x 1200.
 */
export const LAYOUTS = {
  phone: { width: 1080, height: 2340, zoom: 2.5 },
  desktop: { width: 1920, height: 1200, zoom: 1.5 }
} as const
export type Layout = keyof typeof LAYOUTS

/** Generic browser user agents (no app name, no person): sites serve their normal page. */
export const CAPTURE_UA: Record<Layout, string> = {
  phone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
}

/** The containers of the widely used cookie-consent tools (OneTrust, Cookiebot, TrustArc,
 * Usercentrics, Didomi, Quantcast, Sourcepoint, Osano, Google's Funding Choices, Termly). */
export const CONSENT_SELECTORS = [
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#truste-consent-track', '#consent_blackbar',
  '#usercentrics-root', '#didomi-host', '.qc-cmp2-container', '[id^="sp_message_container"]', '.osano-cm-window',
  '.fc-consent-root', '#termly-code-snippet-support', '#transcend-consent-manager'
].join(', ')

/** Run in the page before the capture: hides a fixed or sticky overlay ONLY when its own text is
 * a cookie / privacy-consent notice (short, says "cookie" or "privacy choices", has a button) and
 * it covers under half the screen. Returns how many it hid. Never touches the page's content. */
export const HIDE_CONSENT_OVERLAYS_JS = `(() => {
  const vw = innerWidth, vh = innerHeight; let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.width * r.height > 0.5 * vw * vh) continue;
    const t = (el.innerText || '').slice(0, 1500);
    if (t.length > 1200 || !/cookie|privacy choices|we value your privacy|consent to/i.test(t)) continue;
    if (!el.querySelector('button, a, [role=button]')) continue;
    el.style.setProperty('display', 'none', 'important'); n++;
  }
  return n;
})()`

/** A page that is a bot wall or an error, not the site: never hand that to the edit. */
export function refusalPage(title: string, bodyText: string): string | null {
  const t = `${title}\n${bodyText.slice(0, 600)}`.toLowerCase()
  if (/just a moment|attention required|are you a robot|verify you are human|checking your browser|captcha|unusual traffic/.test(t)) {
    return 'That site blocks automatic screenshots. Take a screenshot on your phone and drop it in instead.'
  }
  if (/^\s*(access denied|forbidden|403\b|404\b|page not found|not found)/.test(title.toLowerCase())) {
    return "That page didn't open (it says it's missing or blocked). Check the address."
  }
  return null
}

/** True when an RGBA/BGRA bitmap is (nearly) one flat colour: a page that never drew. */
export function isBlank(bitmap: Uint8Array | Buffer, width: number, height: number): boolean {
  if (!width || !height || bitmap.length < width * height * 4) return true
  let min = 255
  let max = 0
  const stepY = Math.max(1, Math.floor(height / 60))
  const stepX = Math.max(1, Math.floor(width / 40))
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4
      const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return max - min < 6
}

/** "www.example.com" -> "example.com" for labels and file names. */
export function siteOf(u: URL): string {
  return u.hostname.replace(/^www\./i, '').toLowerCase()
}
