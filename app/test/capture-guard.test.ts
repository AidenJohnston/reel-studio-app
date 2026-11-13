import { describe, expect, it } from 'vitest'
import {
  assertCapturable, hostIsPublic, isBlank, isBlockedAddress, LAYOUTS, normaliseCaptureUrl, refusalPage, siteOf
} from '../src/main/capture-guard'

const publicDns = async (): Promise<string[]> => ['93.184.215.14']

describe('website capture: which links may be opened', () => {
  it('adds https:// to a bare site and keeps real links', () => {
    expect(normaliseCaptureUrl('zorblax.example').href).toBe('https://zorblax.example/')
    expect(normaliseCaptureUrl('http://zorblax.example/a?b=1').href).toBe('http://zorblax.example/a?b=1')
  })

  it.each(['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://zorblax.example/', `https://u:p${'@'}zorblax.example/`, ''])(
    'refuses %s', (u) => {
      expect(() => normaliseCaptureUrl(u)).toThrow()
    })

  it.each(['2002::1', '2002:0808:0808::1', '2001::1', '2001:0:808:808:0:0:f7f7:f7f7'])(
    'refuses tunnel address %s even when its embedded IPv4 is public', (ip) => {
      expect(isBlockedAddress(ip)).toBe(true)
    })

  it('refuses this computer and the home network, in every spelling', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.5', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a00:1']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
    expect(isBlockedAddress('93.184.215.14')).toBe(false)
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false)
    expect(await hostIsPublic('localhost', publicDns)).toBe(false)
    expect(await hostIsPublic('printer.local', publicDns)).toBe(false)
    expect(await hostIsPublic('intranet', publicDns)).toBe(false)
    expect(await hostIsPublic('[::1]', publicDns)).toBe(false)
    // a public name that RESOLVES to a private address is refused too (DNS rebinding)
    expect(await hostIsPublic('sneaky.example', async () => ['93.184.215.14', '10.0.0.7'])).toBe(false)
    expect(await hostIsPublic('gone.example', async () => { throw new Error('ENOTFOUND') })).toBe(false)
  })

  it('both directions: a normal public site passes', async () => {
    expect(await hostIsPublic('zorblax.example', publicDns)).toBe(true)
    expect((await assertCapturable('zorblax.example', publicDns)).hostname).toBe('zorblax.example')
    await expect(assertCapturable('http://127.0.0.1:8080/', publicDns)).rejects.toMatchObject({ code: 'BLOCKED_HOST' })
  })
})

describe('website capture: what comes back', () => {
  it('phone layout is the 19.5:9 of the phone-card at full width, drawn sharp', () => {
    expect(LAYOUTS.phone.width).toBe(1080)
    expect(LAYOUTS.phone.height / LAYOUTS.phone.width).toBeCloseTo(19.5 / 9, 2)
    expect(LAYOUTS.phone.width / LAYOUTS.phone.zoom).toBeLessThan(500) // a phone-wide page
    expect(LAYOUTS.desktop.width / LAYOUTS.desktop.zoom).toBeGreaterThanOrEqual(1200) // a laptop-wide page
  })

  it('a bot wall or an error page is never handed to the edit', () => {
    expect(refusalPage('Just a moment...', '')).toMatch(/blocks automatic screenshots/)
    expect(refusalPage('Zorblax', 'Verify you are human by completing the action below.')).toMatch(/blocks/)
    expect(refusalPage('404 Not Found', '')).toMatch(/didn't open/)
    expect(refusalPage('Access Denied', '')).toMatch(/didn't open/)
    expect(refusalPage('Zorblax: learn a language for free', 'Get started')).toBeNull()
    expect(refusalPage('Not Found: the podcast', 'Episodes')).not.toBeNull() // conservative: a title starting "not found"
  })

  it('a flat one-colour capture is blank; a page with content is not', () => {
    const w = 40
    const h = 80
    const flat = new Uint8Array(w * h * 4).fill(255)
    expect(isBlank(flat, w, h)).toBe(true)
    const page = new Uint8Array(flat)
    for (let i = 0; i < page.length / 2; i += 4) page[i] = page[i + 1] = page[i + 2] = 20
    expect(isBlank(page, w, h)).toBe(false)
    expect(isBlank(new Uint8Array(4), w, h)).toBe(true)
  })

  it('labels a site by its name, without www', () => {
    expect(siteOf(new URL('https://www.Zorblax.example/app'))).toBe('zorblax.example')
  })
})
