// The Windows title bar overlay (main/window.ts) is drawn by the OS outside the page, so the modal scrim in
// styles.css cannot reach it; while a modal is open it must take exactly the scrim's colour.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blendHex, INK, PAPER, titleBarOverlay, WIN_TITLEBAR_HEIGHT } from '../src/main/window'

describe('titleBarOverlay', () => {
  it('matches the page background, and the modal scrim over it while a modal is open', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    const m = /\.modal-backdrop\s*\{[^}]*background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(css)
    if (!m) throw new Error('styles.css .modal-backdrop has no rgba() background')
    const scrim = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    expect(titleBarOverlay(false)).toEqual({ color: PAPER, symbolColor: INK, height: WIN_TITLEBAR_HEIGHT })
    expect(titleBarOverlay(true).color).toBe(blendHex(PAPER, scrim, Number(m[4])))
    expect(titleBarOverlay(true).color).toBe('#b6b4b0')
  })

  it('blends per channel and rounds', () => {
    expect(blendHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(blendHex('#f7f5f1', '#1d1b18', 0)).toBe('#f7f5f1')
    expect(blendHex('#f7f5f1', '#1d1b18', 1)).toBe('#1d1b18')
  })
})
