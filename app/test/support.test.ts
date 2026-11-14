// "Report a problem" (main/support.ts): the review step shows exactly what is sent, nothing private goes unless it was
// ticked, the key travels only in the header, the screenshot fits the server's 2 MB, and every failure says what to do.
import { describe, expect, it } from 'vitest'
import { MAX_SCREENSHOT, SUPPORT_REPORT_URL, clean, createSupport, encodeScreenshot, supportUrl, type ImageLike, type Screenshot } from '../src/main/support'
import type { SupportDraft } from '../src/shared/api'

const KEY = 'v1.eyJzIjoiY3NfbGl2ZV9hYmMiLCJwIjoib25jZSIsImUiOjE4MzAwMDAwMDB9.ssssssssssssssssssssssssssssssssssssssssssss'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SHOT: Screenshot = { bytes: PNG, type: 'image/png', width: 1280, height: 820 }
const draft = (over: Partial<SupportDraft> = {}): SupportDraft => ({ what: 'Export stopped at 80%', expected: '', email: '', diagnostics: false, screenshot: false, key: false, ...over })

interface Sent {
  url: string
  headers: Record<string, string>
  form: FormData
}

function rig(opts: { reply?: () => Promise<Response> | Response; key?: string | null; shot?: Screenshot | null; diagnostics?: string } = {}) {
  const sent: Sent[] = []
  const logs: string[] = []
  let diagCalls = 0
  const s = createSupport({
    url: SUPPORT_REPORT_URL,
    appVersion: '0.1.6',
    os: 'Windows 10.0.26200 x64',
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, form: init.body as FormData })
      return opts.reply ? opts.reply() : new Response(JSON.stringify({ ok: true, id: 'RS-7K3F9QXA' }), { status: 201 })
    }) as unknown as typeof fetch,
    getKey: async () => (opts.key === undefined ? KEY : opts.key),
    diagnostics: async () => (diagCalls++, opts.diagnostics ?? 'Reel Studio diagnostics\nApp: 0.1.6'),
    capture: async () => (opts.shot === undefined ? SHOT : opts.shot),
    log: (l) => logs.push(l)
  })
  return { s, sent, logs, diagCalls: () => diagCalls }
}

/** Every entry of a sent form. Node's FormData iterates at runtime, but the app's tsconfig (lib ES2022, no DOM) types
 * it without keys() or values(), so the entries are read through the iteration it does have. */
function entries(form: FormData): [string, unknown][] {
  const out: [string, unknown][] = []
  ;(form as unknown as { forEach(cb: (value: unknown, key: string) => void): void }).forEach((value, key) => out.push([key, value]))
  return out
}

describe('Report a problem', () => {
  it('by default sends only what was typed, the version and the OS: no diagnostics, screenshot, key or email', async () => {
    const r = rig()
    const cap = await r.s.capture()
    expect(cap).toEqual({ available: true, hasKey: true })
    const p = await r.s.prepare(draft())
    expect(p).toMatchObject({ server: 'dl.getreelstudio.com', what: 'Export stopped at 80%', email: null, diagnostics: null, screenshot: null, key: false, appVersion: '0.1.6', os: 'Windows 10.0.26200 x64' })
    expect(r.diagCalls()).toBe(0)
    expect(await r.s.send(p.id)).toEqual({ id: 'RS-7K3F9QXA' })
    const [one] = r.sent
    expect(one.url).toBe('https://dl.getreelstudio.com/v1/support')
    expect(entries(one.form).map(([k]) => k).sort()).toEqual(['appVersion', 'os', 'what'])
    expect(one.headers.Authorization).toBeUndefined()
    expect(one.headers['User-Agent']).toBe('ReelStudio/0.1.6')
  })

  it('sends exactly what the review step showed, with whatever was ticked', async () => {
    const r = rig()
    await r.s.capture()
    const p = await r.s.prepare(draft({ expected: 'A finished reel', email: ' Me@Example.com ', diagnostics: true, screenshot: true, key: true }))
    expect(p.email).toBe('me@example.com')
    expect(p.diagnostics).toBe('Reel Studio diagnostics\nApp: 0.1.6')
    expect(p.screenshot).toMatchObject({ bytes: PNG.length, width: 1280, height: 820 })
    expect(p.screenshot!.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(p.key).toBe(true)
    await r.s.send(p.id)
    const f = r.sent[0].form
    expect(f.get('what')).toBe(p.what)
    expect(f.get('expected')).toBe('A finished reel')
    expect(f.get('email')).toBe('me@example.com')
    expect(f.get('diagnostics')).toBe(p.diagnostics)
    const file = f.get('screenshot') as File
    expect(file.type).toBe('image/png')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
    // the key goes in the header, never in the form
    expect(r.sent[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    for (const [, v] of entries(f)) if (typeof v === 'string') expect(v).not.toContain(KEY)
    expect(r.logs.join('\n')).not.toContain(KEY)
  })

  it('a key ticked with no key saved sends none; no window screenshot means none', async () => {
    const r = rig({ key: null, shot: null })
    expect(await r.s.capture()).toEqual({ available: false, hasKey: false })
    const p = await r.s.prepare(draft({ key: true, screenshot: true }))
    expect(p).toMatchObject({ key: false, screenshot: null })
    await r.s.send(p.id)
    expect(r.sent[0].headers.Authorization).toBeUndefined()
    expect(r.sent[0].form.has('screenshot')).toBe(false)
  })

  it('a changed draft must be reviewed again: send() takes only the newest preview', async () => {
    const r = rig()
    const a = await r.s.prepare(draft())
    const b = await r.s.prepare(draft({ what: 'Something else' }))
    await expect(r.s.send(a.id)).rejects.toMatchObject({ code: 'SUPPORT_STALE' })
    await r.s.send(b.id)
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].form.get('what')).toBe('Something else')
    // sent: it is gone
    await expect(r.s.send(b.id)).rejects.toMatchObject({ code: 'SUPPORT_STALE' })
  })

  it('closing the form forgets the screenshot', async () => {
    const r = rig()
    await r.s.capture()
    r.s.discard()
    const p = await r.s.prepare(draft({ screenshot: true }))
    expect(p.screenshot).toBeNull()
  })

  it('a form closed while prepare() gathers diagnostics keeps nothing', async () => {
    let release!: (t: string) => void
    const r = rig()
    // diagnostics that answer only when the test says so
    const slow = createSupport({
      url: SUPPORT_REPORT_URL,
      appVersion: '0.1.6',
      os: 'Windows 10.0.26200 x64',
      fetch: (async () => new Response('{"id":"RS-7K3F9QXA"}', { status: 201 })) as unknown as typeof fetch,
      getKey: async () => KEY,
      diagnostics: () => new Promise<string>((res) => (release = res)),
      capture: async () => SHOT,
      log: () => {}
    })
    await slow.capture()
    const pending = slow.prepare(draft({ what: 'cancelled report', email: 'me@example.com', diagnostics: true, screenshot: true, key: true }))
    await new Promise((res) => setTimeout(res, 0))
    slow.discard() // Cancel while the diagnostics are still being gathered
    release('Reel Studio diagnostics')
    await expect(pending).rejects.toMatchObject({ code: 'SUPPORT_STALE' })
    // nothing kept: no report to send, copy or mail, and no screenshot for the next form
    expect(slow.asText('p1')).toBe('')
    await expect(slow.send('p1')).rejects.toMatchObject({ code: 'SUPPORT_STALE' })
    expect(decodeURIComponent(slow.mailto('p1'))).not.toContain('cancelled report')
    const next = await slow.prepare(draft({ screenshot: true }))
    expect(next.screenshot).toBeNull()
    expect(r.sent.length).toBe(0)
  })

  it('a form closed while its screenshot is being taken keeps no screenshot', async () => {
    let release!: (s: Screenshot) => void
    const s = createSupport({
      url: SUPPORT_REPORT_URL,
      appVersion: '0.1.6',
      os: 'x',
      fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      getKey: async () => null,
      diagnostics: async () => '',
      capture: () => new Promise<Screenshot>((res) => (release = res)),
      log: () => {}
    })
    const opening = s.capture()
    s.discard()
    release(SHOT)
    expect(await opening).toEqual({ available: false, hasKey: false })
    expect((await s.prepare(draft({ screenshot: true }))).screenshot).toBeNull()
  })

  it('checks the fields the person can fix', async () => {
    const r = rig()
    await expect(r.s.prepare(draft({ what: '   ' }))).rejects.toMatchObject({ code: 'SUPPORT_FIELD', field: 'what' })
    await expect(r.s.prepare(draft({ what: 'x'.repeat(5001) }))).rejects.toMatchObject({ field: 'what' })
    await expect(r.s.prepare(draft({ expected: 'x'.repeat(3001) }))).rejects.toMatchObject({ field: 'expected' })
    await expect(r.s.prepare(draft({ email: 'not an email' }))).rejects.toMatchObject({ field: 'email' })
    await expect(r.s.prepare(draft({ email: 'a@example.com>, c@example.com' }))).rejects.toMatchObject({ field: 'email' })
    expect(clean('  a\r\nb\u0000c\t ')).toBe('a\nbc')
  })

  it('a very long diagnostics text keeps its newest lines', async () => {
    const long = 'old line\n'.repeat(30_000) + 'NEWEST'
    const r = rig({ diagnostics: long })
    const p = await r.s.prepare(draft({ diagnostics: true }))
    expect(p.diagnostics!.length).toBe(200_000)
    expect(p.diagnostics!.startsWith('[…]\n')).toBe(true)
    expect(p.diagnostics!.endsWith('NEWEST')).toBe(true)
  })

  it('every failure is a message the person can act on', async () => {
    const cases: [() => Promise<Response> | Response, string][] = [
      [() => Promise.reject(new TypeError('fetch failed')), 'SUPPORT_OFFLINE'],
      [() => new Response('{"error":"slow down"}', { status: 429 }), 'SUPPORT_BUSY'],
      [() => new Response('{"error":"report too large"}', { status: 413 }), 'SUPPORT_TOO_BIG'],
      [() => new Response('{"error":"required","field":"what"}', { status: 400 }), 'SUPPORT_FIELD'],
      [() => new Response('{"error":"server error"}', { status: 500 }), 'SUPPORT_FAILED'],
      [() => new Response('<html>', { status: 502 }), 'SUPPORT_FAILED'],
      // a 201 without a proper id is not a success
      [() => new Response('{"ok":true}', { status: 201 }), 'SUPPORT_FAILED']
    ]
    for (const [reply, code] of cases) {
      const r = rig({ reply })
      const p = await r.s.prepare(draft())
      const err = await r.s.send(p.id).catch((e) => e)
      expect(err.code, code).toBe(code)
      expect(typeof err.userMessage).toBe('string')
      // still prepared: Try again, Copy and Email work
      expect(r.s.asText(p.id)).toContain('Export stopped at 80%')
    }
  })

  it('the email way out carries what was typed but not the diagnostics', async () => {
    const r = rig({ reply: () => new Response('', { status: 500 }) })
    const p = await r.s.prepare(draft({ expected: 'It finishes', diagnostics: true }))
    const mail = r.s.mailto(p.id)
    expect(mail.startsWith('mailto:support@getreelstudio.com?subject=')).toBe(true)
    const body = decodeURIComponent(mail.split('&body=')[1])
    expect(body).toContain('Export stopped at 80%')
    expect(body).toContain('It finishes')
    expect(body).toContain('Reel Studio 0.1.6 on Windows 10.0.26200 x64')
    expect(body).not.toContain('Reel Studio diagnostics')
    // Copy the report has them
    expect(r.s.asText(p.id)).toContain('Reel Studio diagnostics')
    expect(r.s.asText('p999')).toBe('')
  })
})

describe('supportUrl', () => {
  const log: string[] = []
  it('the real server unless REELSTUDIO_SUPPORT_URL names https (or http on this computer)', () => {
    expect(supportUrl({}, (l) => log.push(l))).toBe(SUPPORT_REPORT_URL)
    expect(supportUrl({ REELSTUDIO_SUPPORT_URL: 'https://dl-staging.getreelstudio.com/v1/support' }, (l) => log.push(l))).toBe('https://dl-staging.getreelstudio.com/v1/support')
    expect(supportUrl({ REELSTUDIO_SUPPORT_URL: 'http://127.0.0.1:8787/v1/support' }, (l) => log.push(l))).toBe('http://127.0.0.1:8787/v1/support')
    expect(supportUrl({ REELSTUDIO_SUPPORT_URL: 'http://example.com/v1/support' }, (l) => log.push(l))).toBe(SUPPORT_REPORT_URL)
    expect(supportUrl({ REELSTUDIO_SUPPORT_URL: 'https://user:pw@example.com/' }, (l) => log.push(l))).toBe(SUPPORT_REPORT_URL)
    expect(supportUrl({ REELSTUDIO_SUPPORT_URL: 'nonsense' }, (l) => log.push(l))).toBe(SUPPORT_REPORT_URL)
    expect(log.length).toBe(3)
  })
})

describe('encodeScreenshot', () => {
  /** A fake image whose PNG is `pngBytes` and whose JPEG shrinks with its width. */
  const img = (width: number, pngBytes: number, jpegPerPixel = 1): ImageLike => ({
    getSize: () => ({ width, height: Math.round(width * 0.64) }),
    toPNG: () => new Uint8Array(pngBytes),
    toJPEG: () => new Uint8Array(Math.round(width * width * 0.64 * jpegPerPixel)),
    resize: ({ width: w }) => img(w, pngBytes, jpegPerPixel),
    isEmpty: () => width === 0
  })
  it('PNG when it fits, else JPEG, made smaller until it fits 2 MB', () => {
    expect(encodeScreenshot(img(1280, 500_000))).toMatchObject({ type: 'image/png', width: 1280 })
    const big = encodeScreenshot(img(2560, 5_000_000))!
    expect(big.type).toBe('image/jpeg')
    expect(big.bytes.byteLength).toBeLessThanOrEqual(MAX_SCREENSHOT)
    expect(big.width).toBeLessThan(2560)
  })
  it('nothing for a blank window or one that never fits', () => {
    expect(encodeScreenshot(img(0, 10))).toBeNull()
    expect(encodeScreenshot(img(2560, 5_000_000, 1000))).toBeNull()
  })
})
