// Caption looks offered as starting points in "Edit it myself". Picking one writes exactly its style fields
// (engine/reelengine/captions.py draws them); Size, Position and Colour, or a note to the AI editor, fine-tune
// from there. All of them use the one subtitle face the engine ships and the preview loads.
import { BOX_PAD, MARGIN_FRAC, fitCaption, type Measure } from './caption-fit'

type CaptionStyle = Record<string, unknown>

const BASE = { font: 'Montserrat SemiBold', outlineColor: '#000000', shadow: 0, position: 0.75 }

export const CAPTION_PRESETS: { key: string; label: string; style: CaptionStyle }[] = [
  // engine/reelengine/project.py DEFAULT_CAPTION_STYLE
  { key: 'clean', label: 'Clean', style: { ...BASE, size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8 } },
  { key: 'bold-pop', label: 'Bold pop', style: { ...BASE, size: 126, maxWords: 2, case: 'upper', color: '#FFFFFF', outline: 12, pop: true } },
  { key: 'karaoke', label: 'Karaoke', style: { ...BASE, size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, highlight: '#FFD60A' } },
  { key: 'boxed', label: 'Boxed', style: { ...BASE, size: 96, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, box: true } },
  { key: 'minimal', label: 'Minimal', style: { ...BASE, size: 84, maxWords: 4, case: 'lower', color: '#FFFFFF', outline: 5 } }
]

export function applyPreset(key: string): CaptionStyle {
  const preset = CAPTION_PRESETS.find((p) => p.key === key)
  if (!preset) throw new Error(`no caption preset "${key}"`)
  return { ...preset.style, preset: key }
}

// What a style left out, the engine draws as (captions.render_ass, project.DEFAULT_CAPTION_STYLE).
const DRAWN_AS: CaptionStyle = { ...CAPTION_PRESETS[0].style, box: false, pop: false, highlight: null }
const LOOK_KEYS = Object.keys(DRAWN_AS).filter((k) => k !== 'size' && k !== 'position')
const drawn = (st: CaptionStyle, k: string): unknown => {
  const v = st[k] ?? DRAWN_AS[k]
  return typeof v === 'string' ? v.toUpperCase() : v
}

/**
 * The look a reel's subtitles started from: the name the picker saved, or else (a reel made before
 * presets, or styled by the AI editor) the preset it is drawn like, Size and Position aside. Null when
 * it matches none.
 */
export function presetOf(st: CaptionStyle): string | null {
  if (CAPTION_PRESETS.some((p) => p.key === st.preset)) return st.preset as string
  const like = CAPTION_PRESETS.find((p) => LOOK_KEYS.every((k) => drawn(st, k) === drawn(p.style, k)))
  return like?.key ?? null
}

/** The subtitle look, in the engine's own units (1080 x 1920 frame). */
export interface SubtitleLook {
  size: number
  position: number
  color: string
  outlineColor: string
  outline: number
  box: boolean
  case: string
  highlight: string | null
  pop: boolean
}

export function lookFromStyle(st: CaptionStyle | undefined): SubtitleLook {
  const s = st ?? {}
  return {
    size: Number(s.size ?? 105),
    position: Number(s.position ?? 0.75),
    color: String(s.color ?? '#FFFFFF'),
    outlineColor: String(s.outlineColor ?? '#000000'),
    outline: Number(s.outline ?? 8),
    box: !!s.box,
    case: String(s.case ?? 'upper'),
    highlight: typeof s.highlight === 'string' ? s.highlight : null,
    pop: !!s.pop
  }
}

/** captions.apply_case */
function applyCase(text: string, c: string): string {
  if (c === 'upper') return text.toUpperCase()
  if (c === 'lower') return text.toLowerCase()
  if (c === 'title') return text.split(' ').map((t) => t.slice(0, 1).toUpperCase() + t.slice(1)).join(' ')
  return text
}

/** The size and lines the engine gives `text` in this look (captions.render_ass at 1080 wide). */
export function fitLook(look: SubtitleLook, text: string, measure: Measure): { size: number; lines: string[] } {
  const outline = look.box ? Math.max(look.outline, BOX_PAD) : look.outline
  return fitCaption(applyCase(text, look.case), look.size, 1080 * (1 - 2 * MARGIN_FRAC), outline, measure)
}
