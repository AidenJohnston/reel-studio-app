// The phone shapes behind "See it on" (shared/devices.ts): every number is cited, every shape is a real
// phone's, and everything drawn on a screen fits on it.
import { describe, expect, it } from 'vitest'
import { DEVICES, REEL, coveredZones, fitWords, menuBar, placeReel, type Device, type Rect } from '../src/shared/devices'

const inside = (r: Rect, d: Device): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= d.screen.w + 1e-9 && r.y + r.h <= d.screen.h + 1e-9 && r.w > 0 && r.h > 0
const cited = (s: string): boolean => /https:\/\/\S+/.test(s)

describe('devices', () => {
  it('has the shapes the picker promises: a home-button 16:9 phone, a Dynamic Island phone, the largest Pro Max', () => {
    const ids = DEVICES.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('any') // the plain phone's value in the picker
    const se = DEVICES.find((d) => d.homeButton)!
    expect(se.screen.h / se.screen.w).toBeCloseTo(16 / 9, 2)
    expect(DEVICES.some((d) => d.island && !/max/i.test(d.label))).toBe(true)
    const tallest = [...DEVICES].sort((a, b) => b.screen.w * b.screen.h - a.screen.w * a.screen.h)[0]
    expect(tallest.label).toMatch(/Pro Max/)
  })

  for (const d of DEVICES) {
    describe(d.label, () => {
      it('cites a source for its size, corners, camera and Instagram layout', () => {
        expect(cited(d.sources.screen), 'screen size').toBe(true)
        expect(cited(d.sources.radius), 'corner radius').toBe(true)
        if (d.island) expect(cited(d.sources.island ?? ''), 'Dynamic Island').toBe(true)
        expect(cited(d.sources.viewer), 'Instagram layout').toBe(true)
      })

      it('is a phone shape in points, with corners and camera that fit the screen', () => {
        expect(Number.isInteger(d.screen.w) && Number.isInteger(d.screen.h)).toBe(true)
        expect(d.screen.w).toBeGreaterThanOrEqual(320)
        expect(d.screen.w).toBeLessThanOrEqual(480)
        const aspect = d.screen.h / d.screen.w
        expect(aspect).toBeGreaterThanOrEqual(16 / 9 - 0.01) // no phone here is wider than a 9:16 reel
        expect(aspect).toBeLessThanOrEqual(2.3)
        expect(d.radius).toBeGreaterThanOrEqual(0)
        expect(d.radius).toBeLessThan(d.screen.w / 4)
        expect(d.homeButton ? d.chin : 0).toBe(d.chin) // only a home-button phone has a chin
        if (d.island) {
          expect(inside(d.island, d)).toBe(true)
          const mid = d.island.x + d.island.w / 2
          expect(mid).toBeCloseTo(d.screen.w / 2, 6) // centred on the screen
        }
      })

      it('places the 9:16 reel where Instagram draws it: full width, never squashed', () => {
        const { viewer, video, fit } = placeReel(d)
        expect(inside(viewer, d)).toBe(true)
        expect(video.w / video.h).toBeCloseTo(REEL.w / REEL.h, 6)
        expect(['fills', 'trims-sides', 'trims-top-bottom']).toContain(fit)
        // the reel always covers the viewer's width
        expect(video.x).toBeLessThanOrEqual(viewer.x + 1e-9)
        expect(video.x + video.w).toBeGreaterThanOrEqual(viewer.x + viewer.w - 1e-9)
        expect(fitWords(d)).not.toMatch(/—/)
        expect(fitWords(d).length).toBeLessThanOrEqual(44) // one line under the picker, even in a 300px column
      })

      it('marks the top bar, buttons and caption areas inside the screen', () => {
        const zones = coveredZones(d)
        expect(zones.map((z) => z.kind).sort()).toEqual(['buttons', 'caption', 'top'])
        for (const z of zones) expect(inside(z.rect, d), z.kind).toBe(true)
        const { viewer } = placeReel(d)
        const top = zones.find((z) => z.kind === 'top')!.rect
        const caption = zones.find((z) => z.kind === 'caption')!.rect
        const buttons = zones.find((z) => z.kind === 'buttons')!.rect
        expect(top.y).toBeCloseTo(viewer.y, 6)
        expect(caption.y + caption.h).toBeCloseTo(viewer.y + viewer.h, 6)
        expect(buttons.x + buttons.w).toBeCloseTo(viewer.x + viewer.w, 6)
        expect(caption.x + caption.w).toBeLessThanOrEqual(buttons.x + 1e-9) // the caption stops short of the buttons
        const menu = menuBar(d)
        expect(inside(menu, d)).toBe(true)
        expect(menu.y).toBeCloseTo(viewer.y + viewer.h, 6) // Instagram's menu bar sits right under the reel
      })
    })
  }
})

// The numbers worked out by hand from the data, so a change to the data or the maths shows up here.
describe('placement and covered areas, exactly', () => {
  const byId = (id: string): Device => DEVICES.find((d) => d.id === id)!
  const close = (r: Rect, e: Rect): void => {
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(r[k], k).toBeCloseTo(e[k], 3)
  }

  it('iPhone SE: the reel is as wide as the screen, so the menu bar costs it the top and bottom', () => {
    const p = placeReel(byId('iphone-se'))
    close(p.viewer, { x: 0, y: 0, w: 375, h: 618 }) // 667 - 49 menu bar
    close(p.video, { x: 0, y: -24.333, w: 375, h: 666.667 })
    expect(p.fit).toBe('trims-top-bottom')
    expect(fitWords(byId('iphone-se'))).toBe('Instagram may cut about 4% top and bottom.')
  })

  it('iPhone 17: the reel fills the height above the menu bar and loses its sides', () => {
    const p = placeReel(byId('iphone-17'))
    close(p.viewer, { x: 0, y: 0, w: 402, h: 791 }) // 874 - 49 menu bar - 34 Home indicator
    close(p.video, { x: -21.469, y: 0, w: 444.938, h: 791 })
    expect(p.fit).toBe('trims-sides')
    expect(fitWords(byId('iphone-17'))).toBe('Instagram may cut about 5% off each side.')
    const z = Object.fromEntries(coveredZones(byId('iphone-17')).map((c) => [c.kind, c.rect]))
    close(z.top, { x: 0, y: 0, w: 402, h: 110.74 }) // 14%
    close(z.buttons, { x: 316.389, y: 395.5, w: 85.611, h: 395.5 }) // 230 of 1080, lower half
    close(z.caption, { x: 0, y: 514.15, w: 316.389, h: 276.85 }) // 35%, left of the buttons
    close(menuBar(byId('iphone-17')), { x: 0, y: 791, w: 402, h: 49 })
  })

  it('iPhone Pro Max: the same, a little more off each side', () => {
    const p = placeReel(byId('iphone-pro-max'))
    close(p.viewer, { x: 0, y: 0, w: 440, h: 873 })
    close(p.video, { x: -25.531, y: 0, w: 491.063, h: 873 })
    expect(fitWords(byId('iphone-pro-max'))).toBe('Instagram may cut about 5% off each side.')
  })

  it('a screen exactly the shape of the reel is filled with nothing cut', () => {
    const d: Device = { ...byId('iphone-se'), id: 'test', screen: { w: 360, h: 640 }, viewer: { top: 0, bottom: 0 } }
    const p = placeReel(d)
    expect(p.fit).toBe('fills')
    close(p.video, { x: 0, y: 0, w: 360, h: 640 })
    expect(fitWords(d)).toBe('Your reel should fill this screen.')
  })
})
