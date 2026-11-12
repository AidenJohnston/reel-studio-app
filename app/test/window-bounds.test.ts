// Where the main window opens (main/window-bounds.ts): always somewhere the person can reach, never bigger than the
// space above the taskbar. A cold run on Nov 12 opened at x=959, 1924 wide, on a 1920-wide display.
import { describe, expect, it } from 'vitest'
import { DEFAULT, MIN, placeWindow, type DisplayArea } from '../src/main/window-bounds'

const BAR = 40 // the Windows title bar (shared/chrome.ts)
const laptop: DisplayArea = { workArea: { x: 0, y: 0, width: 1920, height: 1032 }, primary: true }
const rightMonitor: DisplayArea = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, primary: false }
const leftMonitor: DisplayArea = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, primary: false }
/** a 14-inch 1080p laptop at 150%: 1280 x 720 logical, 672 above the taskbar */
const small: DisplayArea = { workArea: { x: 0, y: 0, width: 1280, height: 672 }, primary: true }

describe('where the window opens', () => {
  it('fails if a first start does not open at the usual size in the middle of the main display', () => {
    expect(placeWindow(null, [rightMonitor, laptop], BAR)).toEqual({ bounds: { x: 320, y: 106, ...DEFAULT }, min: MIN, maximized: false })
  })

  it('fails if a saved place on a connected display is not kept as it was', () => {
    const saved = { x: 100, y: 80, width: 1300, height: 850, maximized: true }
    expect(placeWindow(saved, [laptop], BAR)).toEqual({ bounds: { x: 100, y: 80, width: 1300, height: 850 }, min: MIN, maximized: true })
    // a monitor to the left of the main one has negative x; still connected, still used
    expect(placeWindow({ x: -1700, y: 40, width: 1280, height: 820 }, [laptop, leftMonitor], BAR).bounds).toEqual({ x: -1700, y: 40, width: 1280, height: 820 })
  })

  it('fails if a window saved on a monitor since unplugged opens off screen', () => {
    const saved = { x: 2400, y: 120, width: 1600, height: 1000 }
    expect(placeWindow(saved, [laptop, rightMonitor], BAR).bounds).toEqual({ x: 2400, y: 120, width: 1600, height: 1000 })
    expect(placeWindow(saved, [laptop], BAR)).toEqual({ bounds: { x: 320, y: 106, ...DEFAULT }, min: MIN, maximized: false })
  })

  it('fails if a window too wide for its display, or hanging off its edge, opens partly out of reach', () => {
    // the cold run's window: most of its title bar on screen, so its place is kept, made to fit and pulled in
    expect(placeWindow({ x: 959, y: 0, width: 1924, height: 1040 }, [laptop], BAR).bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1032 })
    expect(placeWindow({ x: 1500, y: 300, width: 1280, height: 820 }, [laptop], BAR).bounds).toEqual({ x: 640, y: 212, width: 1280, height: 820 })
  })

  it('fails if a saved place with too little of its title bar on any display is used', () => {
    // 60 px of the title bar on screen: less than the 100 px a person needs to drag it back
    expect(placeWindow({ x: 1860, y: 100, width: 1280, height: 820 }, [laptop], BAR).bounds).toEqual({ x: 320, y: 106, ...DEFAULT })
    // the title bar above the top of the screen, the rest below it
    expect(placeWindow({ x: 200, y: -20, width: 1280, height: 820 }, [laptop], BAR).bounds).toEqual({ x: 320, y: 106, ...DEFAULT })
  })

  it('fails if the window or its minimum is taller than the space above the taskbar', () => {
    expect(placeWindow(null, [small], BAR)).toEqual({ bounds: { x: 0, y: 0, width: 1280, height: 672 }, min: { width: 1100, height: 672 }, maximized: false })
    expect(placeWindow({ x: 0, y: 0, width: 1280, height: 820 }, [small], BAR)).toEqual({ bounds: { x: 0, y: 0, width: 1280, height: 672 }, min: { width: 1100, height: 672 }, maximized: false })
  })

  it('fails if a saved size below the minimum, or a size saved without a place, is used as it is', () => {
    expect(placeWindow({ x: 50, y: 50, width: 400, height: 300 }, [laptop], BAR).bounds).toEqual({ x: 50, y: 50, width: 1100, height: 720 })
    expect(placeWindow({ width: 1400, height: 900 }, [laptop], BAR).bounds).toEqual({ x: 260, y: 66, width: 1400, height: 900 })
  })
})
