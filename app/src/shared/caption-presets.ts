// Caption looks offered as starting points in "Edit it myself". Picking one writes exactly its style fields
// (engine/reelengine/captions.py draws them); Size, Position and Colour, or a note to the AI editor, fine-tune
// from there. All of them use the one subtitle face the engine ships and the preview loads.
import type { Word } from './api'
import { BOX_PAD, SAFE_WIDTH, fitCaption, type Measure } from './caption-fit'

type CaptionStyle = Record<string, unknown>

const BASE = { font: 'Montserrat SemiBold', outlineColor: '#000000', shadow: 0, position: 0.75 }

export const CAPTION_PRESETS: { key: string; label: string; style: CaptionStyle }[] = [
  // engine/reelengine/project.py DEFAULT_CAPTION_STYLE
  { key: 'clean', label: 'Clean', style: { ...BASE, size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8 } },
  // 0.73 is ai/src/project.ts lowestCaptionPosition at size 126 and outline 12: at BASE's 0.75 a cue that wraps
  // reaches under Instagram's caption and username
  { key: 'bold-pop', label: 'Bold pop', style: { ...BASE, size: 126, maxWords: 2, case: 'upper', color: '#FFFFFF', outline: 12, pop: true, position: 0.73 } },
  { key: 'karaoke', label: 'Karaoke', style: { ...BASE, size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, highlight: '#FFD60A' } },
  { key: 'boxed', label: 'Boxed', style: { ...BASE, size: 96, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, box: true } },
  { key: 'minimal', label: 'Minimal', style: { ...BASE, size: 84, maxWords: 4, case: 'lower', color: '#FFFFFF', outline: 5 } }
]

/**
 * The style after picking look `key` over `current`. Position carries over once it was moved off the current
 * look's own position; otherwise the new look's own position applies. Size carries over only when the person
 * picked it in the Size row (`sizePicked`); otherwise the look's own size applies.
 */
export function applyPreset(key: string, current: CaptionStyle = {}): CaptionStyle {
  const preset = CAPTION_PRESETS.find((p) => p.key === key)
  if (!preset) throw new Error(`no caption preset "${key}"`)
  const style: CaptionStyle = { ...preset.style, preset: key }
  if (current.position != null && current.position !== lookPosition(current)) style.position = current.position
  if (current.sizePicked === true && current.size != null) Object.assign(style, { size: current.size, sizePicked: true })
  return style
}

// What a style left out, the engine draws as (captions.render_ass, project.DEFAULT_CAPTION_STYLE).
const DRAWN_AS: CaptionStyle = { ...CAPTION_PRESETS[0].style, box: false, pop: false, highlight: null }
/** The style fields that make a look (presetOf compares these). */
export const LOOK_KEYS = Object.keys(DRAWN_AS).filter((k) => k !== 'size' && k !== 'position')
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

/** Where the Position row puts the subtitles: Higher is a fixed line, Lower is the look's own position (#59), so a
 * look that sits higher to stay clear of Instagram's buttons keeps that. */
export function rowPosition(row: 'higher' | 'lower', st: CaptionStyle): number {
  return row === 'higher' ? 0.66 : lookPosition(st)
}

/** The default position of the look `st` is drawn as (presetOf), or 0.75 when it matches none. */
export function lookPosition(st: CaptionStyle): number {
  return Number(CAPTION_PRESETS.find((p) => p.key === presetOf(st))?.style.position ?? 0.75)
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
  return fitCaption(applyCase(text, look.case), look.size, SAFE_WIDTH, outline, measure)
}

// A spoken word has a letter, digit or underscore in any script: Python's Unicode \w, which the engine
// uses (captions.word_spans). JavaScript's /\w/ is ASCII only and would call "привет" or "你好" punctuation.
const SPOKEN = /[\p{L}\p{N}_]/u

/**
 * A sample line for the subtitle preview: kept words as the engine groups them (captions.chunk), up to
 * `maxWords` and never past a sentence end, shown at the moment its first word is spoken. A word that is only
 * punctuation stays in the line, as it does in the export.
 */
export function sampleLine(words: Word[], kept: Set<string>, maxWords: number): { text: string; at: number; words: number } {
  const k = words.filter((w) => kept.has(w.id))
  const spoken = k.filter((w) => SPOKEN.test(w.w))
  const first = spoken[spoken.length > 6 ? 2 : 0]
  const pick: Word[] = []
  for (const w of first ? k.slice(k.indexOf(first)) : []) {
    pick.push(w)
    if (pick.length >= maxWords || /[.!?…]["')\]]*$/.test(w.w.trim())) break
  }
  if (!pick.length) return { text: 'Your words here', at: 0.5, words: 3 }
  const text = pick.map((w) => w.w.trim()).join(' ').replace(/^[(\[{"¿¡]+/, '').replace(/[.,!?;:)\]}"…]+$/, '')
  return { text, at: pick[0].s + 0.15, words: pick.length }
}

/** The look the preview draws for a sample line: like captions.word_spans, no highlight unless each token is one spoken word. */
export function sampleLook(style: CaptionStyle, sample: { text: string; words: number }): SubtitleLook {
  const look = lookFromStyle(style)
  const tokens = sample.text.split(' ')
  if (tokens.length !== sample.words || !tokens.every((t) => SPOKEN.test(t))) look.highlight = null
  return look
}

/** The subtitle colours "Edit it myself" offers. The AI editor may set any colour (ai/src/tools.ts set_caption_style),
 * and is told these values so "make them red" gives the same red either way. */
export const CAPTION_COLORS = [
  { key: 'white', label: 'White', color: '#FFFFFF' },
  { key: 'yellow', label: 'Yellow', color: '#FFD60A' },
  { key: 'red', label: 'Red', color: '#FF3B30' }
] as const

/**
 * A colour's common name, lowercase ("red", "light blue"), or null when it has none worth saying (a muted or
 * in-between shade), so a description can say "a new colour" rather than name one the reel does not show.
 * Bands are by hue, lightness and saturation; they are judgement calls, not measured against how people name colours.
 */
export function colorName(hex: string): string | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim())
  if (!m) return null
  const [r, g, b] = m.slice(1, 4).map((x) => parseInt(x, 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (l >= 0.93) return 'white'
  if (l <= 0.1) return 'black'
  if (s < 0.12) return 'grey'
  if (s < 0.4) return null
  const h = d === 0 ? 0 : max === r ? (60 * ((g - b) / d) + 360) % 360 : max === g ? 60 * ((b - r) / d) + 120 : 60 * ((r - g) / d) + 240
  if (h < 15 || h >= 345) return l > 0.75 ? 'pink' : 'red'
  if (h < 40) return l < 0.35 ? 'brown' : 'orange'
  if (h < 70) return 'yellow'
  if (h < 165) return 'green'
  if (h < 195) return 'turquoise'
  if (h < 255) return l > 0.7 ? 'light blue' : 'blue'
  if (h < 290) return 'purple'
  // magenta: deep is purple (#800080), bright is pink (#FF2D92)
  return l < 0.4 ? 'purple' : 'pink'
}
