// A QR code for a short text (the "Send to my phone" link), drawn offline as one SVG path.
// The encoding is the vendored Nayuki library; this file only turns its modules into drawing data.
import { qrcodegen } from './vendor/qrcodegen'

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number
  /** dark[y][x] */
  dark: boolean[][]
}

/** Medium error correction: still scans off a glossy screen at an angle, and a LAN URL stays small. */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM)
  const dark: boolean[][] = []
  for (let y = 0; y < qr.size; y++) {
    const row: boolean[] = []
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y))
    dark.push(row)
  }
  return { size: qr.size, dark }
}

/**
 * SVG path data (one unit per module) and the viewBox side, with the standard 4-module quiet zone.
 * Runs of dark modules in a row become one rectangle, so the path stays short.
 */
export function qrSvg(text: string, quiet = 4): { path: string; side: number } {
  const { size, dark } = qrMatrix(text)
  const parts: string[] = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!dark[y][x]) {
        x++
        continue
      }
      const start = x
      while (x < size && dark[y][x]) x++
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`)
    }
  }
  return { path: parts.join(''), side: size + quiet * 2 }
}
