// Real phone shapes for the Reel screen's "See it on" picker (renderer/components/DevicePreview.tsx), and
// where Instagram's Reels viewer puts the reel and its own buttons on each. Sizes are logical points (what
// apps lay out in), not pixels. Every number names its source. Apple's Human Interface Guidelines device
// table did not load for us, so sizes come from secondary tables checked against Apple's pixel specs.
// Apple publishes no corner radii or Dynamic Island geometry, and Instagram publishes no layout for organic
// Reels: those numbers are secondary measurements or estimates, marked as such, and the UI says "about".

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Device {
  id: string
  /** What the picker says. */
  label: string
  /** Logical screen size in points. */
  screen: { w: number; h: number }
  /** Display corner radius in points (0 = square corners). */
  radius: number
  /** The Dynamic Island, in screen points. */
  island?: Rect
  homeButton: boolean
  /** Forehead and chin (above and below the screen) as a fraction of the phone's height; home-button phones only. */
  chin: number
  /** The part of the screen Instagram's Reels viewer draws the reel in: points kept clear at the top and bottom. */
  viewer: { top: number; bottom: number }
  sources: { screen: string; radius: string; island?: string; viewer: string }
}

/** A reel's frame (9:16, the engine's 1080 x 1920). */
export const REEL = { w: 1080, h: 1920 }

// Instagram's menu bar at the bottom of the app. The reel is drawn above it. Apple does not publish a tab
// bar height; 49 pt is UIKit's standard one, and Instagram's bar has not been measured: an estimate.
const MENU_BAR = 49
// The Dynamic Island, design-derived, not an Apple spec: "The 125.34 camera width is derived", "36.67 pt"
// (https://www.appetiteui.com/blog/dynamic-island-live-activity-figma). Its distance from the top of the
// screen was not found anywhere; 11 pt is an estimate from how it looks.
const ISLAND = { w: 125.34, h: 36.67, top: 11 }
const island = (screenW: number): Rect => ({ x: (screenW - ISLAND.w) / 2, y: ISLAND.top, w: ISLAND.w, h: ISLAND.h })
const ISLAND_SOURCE = 'https://www.appetiteui.com/blog/dynamic-island-live-activity-figma (size, design-derived); top offset not found, estimated'
// How Instagram's Reels viewer sits on the screen: no Meta source says whether a reel fills a taller phone or
// gets bars ("Meta may zoom to fill or letterbox", https://www.hopperhq.com/blog/instagram-reel-size/).
// We draw it the way the app is commonly seen: from the very top, under the clock, down to the menu bar,
// filled, with the overflow trimmed. Not checked on a real phone yet.
const VIEWER_SOURCE = 'https://www.hopperhq.com/blog/instagram-reel-size/ (fill or letterbox, unspecified); placement is an estimate'

export const DEVICES: Device[] = [
  {
    // Also the iPhone SE (2nd generation) and iPhone 6s, 7 and 8: the same 4.7-inch 16:9 screen.
    id: 'iphone-se',
    label: 'iPhone SE',
    screen: { w: 375, h: 667 },
    radius: 0,
    homeButton: true,
    // Apple: 138.4 mm tall, 4.7-inch 16:9 screen (104.0 mm tall), so (138.4 - 104.0) / 2 / 138.4 = 0.124.
    chin: 0.124,
    viewer: { top: 0, bottom: MENU_BAR },
    sources: {
      screen: 'https://www.ios-resolution.com/iphone-se-3rd-gen/ ("Logical Width: 375", "Logical Height: 667", "Scale Factor: 2"); https://support.apple.com/en-us/111866 ("1334-by-750-pixel resolution")',
      radius: 'https://support.apple.com/en-us/111866 (square corners: no rounded-corner note, unlike the Face ID iPhones; no Home indicator inset, https://1440px.com/safe-area/ "0 px")',
      viewer: VIEWER_SOURCE
    }
  },
  {
    id: 'iphone-17',
    label: 'iPhone 17',
    screen: { w: 402, h: 874 },
    radius: 62,
    island: island(402),
    homeButton: false,
    chin: 0,
    // 34 pt Home indicator inset ("top 62, bottom 34", https://useyourloaf.com/blog/iphone-17-screen-sizes/) under the menu bar.
    viewer: { top: 0, bottom: MENU_BAR + 34 },
    sources: {
      screen: 'https://useyourloaf.com/blog/iphone-17-screen-sizes/ ("402 x 874", "3x"); https://support.apple.com/en-us/125089 ("2622x1206-pixel resolution")',
      radius: 'https://github.com/kylebshr/ScreenCorners ("17" at "62.0", read from the private _displayCornerRadius: a measurement, not an Apple spec)',
      island: ISLAND_SOURCE,
      viewer: VIEWER_SOURCE
    }
  },
  {
    // The 16, 17 and 18 Pro Max share this screen (https://www.screensize.io/devices/iphone-18-pro-max.html
    // "440 × 956 px"). The 18 Pro Max's Dynamic Island is smaller, but its size is not published: we draw the
    // 16 and 17 Pro Max's.
    id: 'iphone-pro-max',
    label: 'iPhone Pro Max',
    screen: { w: 440, h: 956 },
    radius: 62,
    island: island(440),
    homeButton: false,
    chin: 0,
    // "top: 62, bottom: 34" (https://useyourloaf.com/blog/iphone-16-screen-sizes/).
    viewer: { top: 0, bottom: MENU_BAR + 34 },
    sources: {
      screen: 'https://useyourloaf.com/blog/iphone-16-screen-sizes/ ("440 x 956", "3x"); https://support.apple.com/en-us/121032 ("2868-by-1320-pixel resolution")',
      radius: 'https://github.com/kylebshr/ScreenCorners (16 and 17 Pro Max at "62.0", a measurement, not an Apple spec; the 18 Pro Max is not listed)',
      island: ISLAND_SOURCE,
      viewer: VIEWER_SOURCE
    }
  }
]

export type Fit = 'fills' | 'trims-sides' | 'trims-top-bottom'

/** Where the reel sits on this phone in Instagram: the viewer rectangle, and the reel scaled to cover it. */
export function placeReel(d: Device): { viewer: Rect; video: Rect; fit: Fit } {
  const viewer: Rect = { x: 0, y: d.viewer.top, w: d.screen.w, h: d.screen.h - d.viewer.top - d.viewer.bottom }
  const k = Math.max(viewer.w / REEL.w, viewer.h / REEL.h)
  const w = REEL.w * k
  const h = REEL.h * k
  const video: Rect = { x: viewer.x + (viewer.w - w) / 2, y: viewer.y + (viewer.h - h) / 2, w, h }
  const fit: Fit = Math.abs(w - viewer.w) < 0.5 && Math.abs(h - viewer.h) < 0.5 ? 'fills' : w > viewer.w ? 'trims-sides' : 'trims-top-bottom'
  return { viewer, video, fit }
}

/** The fit in plain words, for under the picker. */
export function fitWords(d: Device): string {
  const { viewer, video, fit } = placeReel(d)
  // "may" and "about": how Instagram fits a reel on this phone is our estimate (VIEWER_SOURCE), not Meta's word.
  if (fit === 'fills') return 'Your reel should fill this screen.'
  if (fit === 'trims-sides') return `Instagram may cut about ${Math.round(((video.w - viewer.w) / 2 / video.w) * 100)}% off each side.`
  return `Instagram may cut about ${Math.round(((video.h - viewer.h) / 2 / video.h) * 100)}% top and bottom.`
}

export type ZoneKind = 'top' | 'buttons' | 'caption'

/**
 * Instagram's own layer over a reel, as fractions of the viewer (a full-screen reel's frame):
 * - top bar and bottom (your name, caption, audio): Meta's Reels safe zone, "leaving at least 14% of the
 *   top, 35% of the bottom, and 6% on each side of your asset free from text, logos or other important
 *   creative elements" (https://www.facebook.com/business/ads-guide/update/video/instagram-reels). That is
 *   Meta's guidance for Reels ads; organic Reels keep about the same clearance (Hopper HQ below).
 * - the column of buttons on the right: "~230 px" of 1080 (https://www.hopperhq.com/blog/instagram-reel-size/),
 *   a third-party estimate. Its height is not published; we draw it over the lower half, like the app: an estimate.
 * Meta's 6% side margin is a safety margin, not something Instagram draws, so it is not shaded.
 */
export const ZONES = { top: 0.14, bottom: 0.35, buttonsWidth: 230 / REEL.w, buttonsFrom: 0.5 }

export function coveredZones(d: Device): { kind: ZoneKind; rect: Rect }[] {
  const { viewer: v } = placeReel(d)
  const bw = v.w * ZONES.buttonsWidth
  return [
    { kind: 'top', rect: { x: v.x, y: v.y, w: v.w, h: v.h * ZONES.top } },
    { kind: 'buttons', rect: { x: v.x + v.w - bw, y: v.y + v.h * ZONES.buttonsFrom, w: bw, h: v.h * (1 - ZONES.buttonsFrom) } },
    { kind: 'caption', rect: { x: v.x, y: v.y + v.h * (1 - ZONES.bottom), w: v.w - bw, h: v.h * ZONES.bottom } }
  ]
}

/** Instagram's menu bar under the reel (MENU_BAR, an estimate). */
export function menuBar(d: Device): Rect {
  const { viewer: v } = placeReel(d)
  return { x: 0, y: v.y + v.h, w: d.screen.w, h: MENU_BAR }
}
