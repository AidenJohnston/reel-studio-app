// How the engine sizes and wraps one caption (engine/reelengine/captions.py `fit` and `render_ass`), so the
// live subtitle preview breaks lines where the export does: only between words, at the most even split.
// Everything here is in the engine's units: a 1080-wide frame and ASS font sizes.

/** captions.py MARGIN_FRAC: the left and right safe margin, a fraction of the frame's width. */
export const MARGIN_FRAC = 0.065
/** captions.py MIN_SHRINK: below this fraction of the base size, wrap to two lines instead of shrinking. */
export const MIN_SHRINK = 0.62
/** verify.py ig_right_limit at 1080 wide: past this x a caption sits under Instagram's right-side buttons. */
export const IG_RIGHT_LIMIT = 1080 * (1 - 0.13) + 40
/** captions.render_ass at 1080 wide: a centred line fits the margins and ends a pixel inside IG_RIGHT_LIMIT. */
export const SAFE_WIDTH = 2 * Math.min(540 - 1080 * MARGIN_FRAC, IG_RIGHT_LIMIT - 540 - 1)
/** captions.py BOX_PAD: the "box" style's padding, which libass draws as the outline. */
export const BOX_PAD = 18
/**
 * libass sizes a face so that its OS/2 winAscent + winDescent equals the font size (captions.py docstring).
 * For the subtitle face, Montserrat-SemiBold.ttf: upem 1000, winAscent 1109, winDescent 453, read with
 * captions._ttf_metrics. So one em in CSS is the ASS size / 1.562, and one line is the ASS size tall.
 */
export const SIZE_PER_EM = (1109 + 453) / 1000

/** Width of `text` drawn at ASS size `size` with an outline of `outline` on each side, in frame pixels. */
export type Measure = (text: string, size: number, outline: number) => number

/** (size, lines). Shrink-only; wrap to two lines rather than shrink below MIN_SHRINK. A port of captions.fit. */
export function fitCaption(text: string, base: number, safeW: number, outline: number, measure: Measure): { size: number; lines: string[] } {
  // The ratio scales the outline along with the letters, and drawn widths are not linear in size,
  // so the estimate can still overhang by a few pixels.
  const shrunk = (estimate: number, lines: string[]): number => {
    let size = Math.max(10, Math.trunc(estimate))
    while (size > 10 && Math.max(...lines.map((l) => measure(l, size, outline))) > safeW) size--
    return size
  }
  const w = measure(text, base, outline)
  if (w <= safeW) return { size: Math.trunc(base), lines: [text] }
  const size = shrunk((base * safeW) / w, [text])
  if (size >= base * MIN_SHRINK || !text.includes(' ')) return { size, lines: [text] }
  const parts = text.split(' ')
  let best: { widest: number; lines: string[] } | null = null
  for (let k = 1; k < parts.length; k++) {
    const a = parts.slice(0, k).join(' ')
    const b = parts.slice(k).join(' ')
    const widest = Math.max(measure(a, base, outline), measure(b, base, outline))
    if (!best || widest < best.widest) best = { widest, lines: [a, b] }
  }
  // SAFETY: text has a space here, so parts has at least two entries and the loop ran at least once.
  const { widest, lines } = best!
  if (widest <= safeW) return { size: Math.trunc(base), lines }
  return { size: shrunk((base * safeW) / widest, lines), lines }
}
