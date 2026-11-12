// Where the main window opens (window.ts). A saved place is used only while the person can still reach it: a monitor
// unplugged since, or a window left mostly off screen, opens on the main display instead. Sizes never exceed the
// display's work area (the screen above the taskbar or Dock): a 14-inch 1080p laptop at Windows' 150% scale has a
// 1280 x 672 work area, under the 720 px minimum height the window used to insist on.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayArea {
  /** Electron's Display.workArea */
  workArea: Rect
  primary: boolean
}

export interface SavedBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface Placement {
  bounds: Rect
  min: { width: number; height: number }
  maximized: boolean
}

export const MIN = { width: 1100, height: 720 }
export const DEFAULT = { width: 1280, height: 820 }
/** How much of the title bar must be on a display for a saved place to count as reachable: this wide, full height. */
export const GRAB_WIDTH = 100

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)

/** The part of the window's title bar on this display, or null when less than GRAB_WIDTH of it at its full height. */
function grab(b: Rect, titleBar: number, area: Rect): number | null {
  const w = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x)
  const h = Math.min(b.y + titleBar, area.y + area.height) - Math.max(b.y, area.y)
  return w >= GRAB_WIDTH && h >= titleBar ? w : null
}

/** A size that fits the area, and the window's minimum there. */
function fit(width: number, height: number, area: Rect): { size: { width: number; height: number }; min: Placement['min'] } {
  const min = { width: Math.min(MIN.width, area.width), height: Math.min(MIN.height, area.height) }
  return { size: { width: clamp(Math.round(width), min.width, area.width), height: clamp(Math.round(height), min.height, area.height) }, min }
}

function centred(width: number, height: number, area: Rect): Placement['bounds'] {
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
}

/**
 * The window's place from what was saved (null on a first start or a broken file) and the displays connected now.
 * `titleBar` is the title bar's height in px.
 */
export function placeWindow(saved: SavedBounds | null, displays: DisplayArea[], titleBar: number): Placement {
  if (!displays.length) throw new Error('placeWindow: no displays')
  const main = (displays.find((d) => d.primary) ?? displays[0]).workArea
  const maximized = !!saved?.maximized
  if (saved && finite(saved.width) && finite(saved.height) && saved.width > 0 && saved.height > 0) {
    if (finite(saved.x) && finite(saved.y)) {
      const b = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      // the display holding most of the title bar
      let best: { area: Rect; w: number } | null = null
      for (const d of displays) {
        const w = grab(b, titleBar, d.workArea)
        if (w !== null && (!best || w > best.w)) best = { area: d.workArea, w }
      }
      if (best) {
        const { area } = best
        const { size, min } = fit(saved.width, saved.height, area)
        // kept where it was, pulled in just enough that all of it is on that display
        const x = clamp(Math.round(saved.x), area.x, area.x + area.width - size.width)
        const y = clamp(Math.round(saved.y), area.y, area.y + area.height - size.height)
        return { bounds: { x, y, ...size }, min, maximized }
      }
    } else {
      // a saved size from before places were saved: that size, centred on the main display
      const { size, min } = fit(saved.width, saved.height, main)
      return { bounds: centred(size.width, size.height, main), min, maximized }
    }
  }
  const { size, min } = fit(DEFAULT.width, DEFAULT.height, main)
  return { bounds: centred(size.width, size.height, main), min, maximized }
}
